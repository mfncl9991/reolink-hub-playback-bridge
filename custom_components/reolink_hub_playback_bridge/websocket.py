"""WebSocket API for the companion Lovelace card's settings editor.

The card's editor offers a single "pick your camera" device selector instead of
8 hand-typed config fields. This module resolves that pick into the actual
config values. The entity-naming rules below (especially the PTZ preset select,
which isn't consistently named across camera models - see PRESET_MATCH) only
make sense with backend-side knowledge of this integration, not frontend
guesswork, which is why this lives here rather than in the card's JS.
"""

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .media_source import resolve_device_channel


def _first(
    entities: list[er.RegistryEntry], domain: str, match
) -> er.RegistryEntry | None:
    """Return the first entity in `domain` whose entity_id satisfies `match`."""
    return next(
        (e for e in entities if e.domain == domain and match(e.entity_id)),
        None,
    )


@callback
def _camera_config(hass: HomeAssistant, device_id: str) -> dict | None:
    """Derive a card config from a Reolink device."""
    resolved = resolve_device_channel(hass, device_id)
    if resolved is None:
        return None
    config_entry_id, channel = resolved

    entities = er.async_entries_for_device(er.async_get(hass), device_id)

    live = _first(
        entities,
        "camera",
        lambda eid: eid.endswith("_fluent") and "snapshots" not in eid,
    )
    record = _first(entities, "switch", lambda eid: eid.endswith("_manual_record"))
    battery = _first(entities, "sensor", lambda eid: eid.endswith("_battery"))
    ptz_up = _first(entities, "button", lambda eid: eid.endswith("_ptz_up"))
    # Not a fixed "select.<slug>_ptz_preset" template - confirmed some models
    # (e.g. Reolink E1 Zoom) name this entity with the device name repeated
    # (e.g. select.<name>_<name>_ptz_preset), so this matches by substring
    # instead.
    preset = _first(entities, "select", lambda eid: "ptz_preset" in eid)
    guard = _first(entities, "button", lambda eid: eid.endswith("guard_go_to"))
    zoom = _first(entities, "number", lambda eid: eid.endswith("_zoom"))

    base = f"media-source://reolink_hub_playback_bridge/RES|{config_entry_id}|{channel}"
    return {
        "media_source_id_sub": f"{base}|sub",
        "media_source_id_main": f"{base}|main",
        "live_camera_entity": live.entity_id if live else None,
        "record_switch_entity": record.entity_id if record else None,
        "battery_entity": battery.entity_id if battery else None,
        "ptz": (
            {
                "pad_entity_prefix": ptz_up.entity_id.rsplit("_up", 1)[0],
                "preset_entity": preset.entity_id if preset else None,
                "guard_entity": guard.entity_id if guard else None,
                "zoom_entity": zoom.entity_id if zoom else None,
            }
            if ptz_up
            else None
        ),
    }


@websocket_api.websocket_command(
    {
        vol.Required("type"): "reolink_hub_playback_bridge/camera_config",
        vol.Required("device_id"): str,
    }
)
@callback
def _ws_camera_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle reolink_hub_playback_bridge/camera_config."""
    result = _camera_config(hass, msg["device_id"])
    if result is None:
        connection.send_error(msg["id"], "not_found", "Not a Reolink camera device")
        return
    connection.send_result(msg["id"], result)


def async_register(hass: HomeAssistant) -> None:
    """Register reolink_hub_playback_bridge websocket commands."""
    websocket_api.async_register_command(hass, _ws_camera_config)
