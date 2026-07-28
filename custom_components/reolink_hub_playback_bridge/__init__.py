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

from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .views import (
    ReolinkHubPlaybackBridgeLiveStreamView,
    ReolinkHubPlaybackBridgeStreamView,
)
from .websocket import async_register as async_register_websocket_commands

__all__ = ["DOMAIN"]

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up reolink_hub_playback_bridge (media_source + streaming proxy view)."""
    hass.http.register_view(ReolinkHubPlaybackBridgeStreamView())
    hass.http.register_view(ReolinkHubPlaybackBridgeLiveStreamView())
    async_register_websocket_commands(hass)
    return True
