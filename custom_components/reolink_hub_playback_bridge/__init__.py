"""Reolink Hub Playback Bridge.

The built-in `reolink` integration always fetches recorded clips for hub/NVR-class
devices (`is_hub` / `is_nvr`) via the `Download`/`NvrDownload` CGI command, which on
a Reolink Home Hub is throttled to ~200-250KB/s regardless of resolution and ignores
HTTP Range requests entirely.

This component exposes a second `media_source`
(`media-source://reolink_hub_playback_bridge/...`) that mirrors the real Reolink
browsing tree byte-for-byte, but resolves playback via the `Playback` CGI command
(captured from the Home Hub's own native web client's network traffic) instead of
`Download`/`NvrDownload`. The Home Hub serves this as FLV regardless of the .mp4
filename - a same-origin streaming proxy (views.py) re-serves it to the browser so a
client-side FLV demuxer (mpegts.js, see the companion Lovelace card) can consume it
without hitting CORS (the Home Hub sends no Access-Control-Allow-Origin, which blocks
a direct cross-origin fetch()/XHR - confirmed via a HAR capture).

No separate credentials: reuses the already-authenticated `host.api` object the real
`reolink` config entry maintains.
"""

from __future__ import annotations

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import DOMAIN as HOMEASSISTANT_DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.typing import ConfigType

from .camera_actions import RuntimeData
from .const import DOMAIN, TITLE
from .frontend_resources import async_register_lovelace_resources
from .views import (
    ReolinkHubPlaybackBridgeLiveStreamView,
    ReolinkHubPlaybackBridgeStreamView,
)
from .websocket import async_register as async_register_websocket_commands

__all__ = ["DOMAIN"]

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

PLATFORMS = [Platform.SWITCH]

_VIEWS_REGISTERED_KEY = f"{DOMAIN}_views_registered"

type ReolinkHubPlaybackBridgeConfigEntry = ConfigEntry[RuntimeData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Handle the deprecated bare `reolink_hub_playback_bridge:` YAML key.

    Import path only - the actual view/websocket registration happens in
    async_setup_entry, once a config entry exists (either from this import or
    from Settings -> Devices & Services -> Add Integration).
    """
    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
        ir.async_create_issue(
            hass,
            HOMEASSISTANT_DOMAIN,
            f"deprecated_yaml_{DOMAIN}",
            is_fixable=False,
            issue_domain=DOMAIN,
            breaks_in_ha_version="2026.11.0",
            severity=ir.IssueSeverity.WARNING,
            translation_key="deprecated_yaml",
            translation_placeholders={"domain": DOMAIN, "integration_title": TITLE},
        )
    return True


async def async_setup_entry(
    hass: HomeAssistant, entry: ReolinkHubPlaybackBridgeConfigEntry
) -> bool:
    """Set up reolink_hub_playback_bridge from a config entry.

    Registers the two proxy HTTP views and the websocket commands exactly
    once per HA run, regardless of how many times the (single) config entry
    is reloaded - hass.http.register_view() isn't safe to call twice.

    entry.runtime_data holds the in-memory PTZ-pad PIR-suppress and
    manual-record auto-stop state (see camera_actions.py) - unlike the
    views/websocket commands above, this genuinely is per-entry-instance:
    async_unload_entry cancels every pending scheduled callback in it below.
    """
    if not hass.data.get(_VIEWS_REGISTERED_KEY):
        hass.http.register_view(ReolinkHubPlaybackBridgeStreamView())
        hass.http.register_view(ReolinkHubPlaybackBridgeLiveStreamView())
        async_register_websocket_commands(hass)
        hass.data[_VIEWS_REGISTERED_KEY] = True

    entry.runtime_data = RuntimeData()

    await async_register_lovelace_resources(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ReolinkHubPlaybackBridgeConfigEntry
) -> bool:
    """Unload a config entry.

    The views/websocket commands are process-wide singletons with no
    per-entry state, and HA's HTTP layer has no clean route-removal API, so
    leaving them registered after an unload is harmless - every request
    still requires a *reolink* config_entry_id in the URL/media-source path,
    which this entry never supplies. entry.runtime_data's pending
    async_call_later callbacks are genuinely per-entry, though, and must be
    cancelled here - otherwise a reload leaves orphaned callbacks holding
    closures over a now-stale runtime_data.
    """
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    entry.runtime_data.cancel_all()
    return unloaded
