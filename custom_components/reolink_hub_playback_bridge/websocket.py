"""WebSocket API the companion Lovelace card calls into.

Two kinds of commands live here now:

- camera_config: resolves the editor's "pick your camera" device selector
  into the actual config values. The entity-naming rules below (especially
  the PTZ preset select, which isn't consistently named across camera models
  - see PRESET_MATCH) only make sense with backend-side knowledge of this
  integration, not frontend guesswork, which is why this lives here rather
  than in the card's JS.
- ptz_pir_suppress_start/end and manual_record_schedule_stop/cancel_stop:
  thin handlers over the stateful PTZ-pad PIR-suppress and manual-record
  auto-stop logic in camera_actions.py - the actual business logic (in-memory
  state, async_call_later scheduling) lives there, not here.
"""

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .camera_actions import (
    RuntimeData,
    async_manual_record_schedule_stop,
    async_ptz_pir_suppress_end,
    async_ptz_pir_suppress_start,
    manual_record_cancel_stop,
)
from .const import DOMAIN
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


def _runtime_data(hass: HomeAssistant) -> RuntimeData | None:
    """Return the (single, single_config_entry) loaded entry's runtime_data.

    None only if a command somehow arrives before the entry has finished
    setup, which shouldn't happen in practice - websocket connections only
    start processing messages once HA startup (including config entry setup)
    has completed. Same iterate-loaded-entries pattern
    resolve_device_channel (media_source.py) uses for the *reolink*
    integration's own entries.
    """
    for entry in hass.config_entries.async_loaded_entries(DOMAIN):
        return entry.runtime_data
    return None


@websocket_api.websocket_command(
    {
        vol.Required("type"): "reolink_hub_playback_bridge/ptz_pir_suppress_start",
        vol.Required("pir_entity_id"): str,
        vol.Optional("snooze_timer_entity_id"): str,
    }
)
@websocket_api.async_response
async def _ws_ptz_pir_suppress_start(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle reolink_hub_playback_bridge/ptz_pir_suppress_start."""
    runtime_data = _runtime_data(hass)
    if runtime_data is not None:
        await async_ptz_pir_suppress_start(
            hass,
            runtime_data,
            msg["pir_entity_id"],
            msg.get("snooze_timer_entity_id"),
        )
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "reolink_hub_playback_bridge/ptz_pir_suppress_end",
        vol.Required("pir_entity_id"): str,
    }
)
@websocket_api.async_response
async def _ws_ptz_pir_suppress_end(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle reolink_hub_playback_bridge/ptz_pir_suppress_end."""
    runtime_data = _runtime_data(hass)
    if runtime_data is not None:
        await async_ptz_pir_suppress_end(hass, runtime_data, msg["pir_entity_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): (
            "reolink_hub_playback_bridge/manual_record_schedule_stop"
        ),
        vol.Required("entity_id"): str,
        # Only ever sent by the card when an auto-stop duration is actually
        # configured (not "Off") - see record_auto_stop_minutes in the card.
        vol.Required("minutes"): vol.All(
            vol.Coerce(float), vol.Range(min=0, min_included=False)
        ),
    }
)
@websocket_api.async_response
async def _ws_manual_record_schedule_stop(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle reolink_hub_playback_bridge/manual_record_schedule_stop."""
    runtime_data = _runtime_data(hass)
    if runtime_data is not None:
        await async_manual_record_schedule_stop(
            hass, runtime_data, msg["entity_id"], msg["minutes"]
        )
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "reolink_hub_playback_bridge/manual_record_cancel_stop",
        vol.Required("entity_id"): str,
    }
)
@callback
def _ws_manual_record_cancel_stop(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle reolink_hub_playback_bridge/manual_record_cancel_stop."""
    runtime_data = _runtime_data(hass)
    if runtime_data is not None:
        manual_record_cancel_stop(runtime_data, msg["entity_id"])
    connection.send_result(msg["id"])


def async_register(hass: HomeAssistant) -> None:
    """Register reolink_hub_playback_bridge websocket commands."""
    websocket_api.async_register_command(hass, _ws_camera_config)
    websocket_api.async_register_command(hass, _ws_ptz_pir_suppress_start)
    websocket_api.async_register_command(hass, _ws_ptz_pir_suppress_end)
    websocket_api.async_register_command(hass, _ws_manual_record_schedule_stop)
    websocket_api.async_register_command(hass, _ws_manual_record_cancel_stop)
