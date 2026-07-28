"""Expose Reolink hub/NVR recordings via the Playback CGI command instead of the
throttled Download/NvrDownload command the built-in reolink integration is
hard-coded to use for is_hub/is_nvr devices.

Browsing tree is identical to the built-in `reolink` media_source (same
CAM|RES|DAY|FILE identifier shapes) - only resolve_media differs. Reuses the
already-authenticated `host.api` object from the real reolink config entry; no
separate credentials are stored or handled here.
"""

import datetime as dt
import logging
from typing import override
from urllib.parse import quote

from homeassistant.components.camera import DOMAIN as CAM_DOMAIN
from homeassistant.components.media_player import MediaClass, MediaType
from homeassistant.components.media_source import (
    BrowseMediaSource,
    MediaSource,
    MediaSourceItem,
    PlayMedia,
    Unresolvable,
)
from homeassistant.components.reolink.const import DOMAIN as REOLINK_DOMAIN
from homeassistant.components.reolink.util import get_host
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from reolink_aio.api import DUAL_LENS_MODELS
from reolink_aio.typings import VOD_trigger

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

VOD_SPLIT_TIME = dt.timedelta(minutes=5)


async def async_get_media_source(
    hass: HomeAssistant,
) -> "ReolinkHubPlaybackBridgeMediaSource":
    """Set up camera media source."""
    return ReolinkHubPlaybackBridgeMediaSource(hass)


def resolve_channel(host: object, ch_id: str) -> int | str:
    """Resolve a camera entity's unique_id channel segment to a numeric channel.

    Newer firmware reports a long per-camera UID here instead of a small integer
    index - channel_for_uid() translates that back to the numeric channel Reolink's
    CGI API expects. Shared by the root browse tree below and the camera_config
    websocket command (websocket.py), which both need this same resolution.
    """
    if len(ch_id) > 3:
        return host.api.channel_for_uid(ch_id)
    return ch_id


def resolve_device_channel(
    hass: HomeAssistant, device_id: str
) -> tuple[str, int | str] | None:
    """Resolve a Reolink device_id to its (config_entry_id, channel).

    Scoped, single-device version of the per-entity resolution in
    _async_generate_root below - used by the camera_config websocket command to
    turn a device picked in the card's settings editor into the identifiers
    needed to build its media_source_id.
    """
    device_reg = dr.async_get(hass)
    device = device_reg.async_get(device_id)
    if device is None:
        return None

    entity_reg = er.async_get(hass)
    for config_entry in hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
        if config_entry.entry_id not in device.config_entries:
            continue
        host = config_entry.runtime_data.host
        for entity in er.async_entries_for_device(entity_reg, device_id):
            if entity.domain != CAM_DOMAIN:
                continue
            ch_id = entity.unique_id.split("_")[1]
            return config_entry.entry_id, resolve_channel(host, ch_id)

    return None


def res_name(stream: str) -> str:
    """Return the user friendly name for a stream."""
    match stream:
        case "main":
            return "High res."
        case "autotrack_sub":
            return "Telephoto low res."
        case "autotrack_main":
            return "Telephoto high res."
        case _:
            return "Low res."


class ReolinkHubPlaybackBridgeMediaSource(MediaSource):
    """Provide Reolink hub/NVR recordings as media sources via the fast FLV path."""

    name: str = "Reolink (fast)"

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize ReolinkHubPlaybackBridgeMediaSource."""
        super().__init__(DOMAIN)
        self.hass = hass

    @override
    async def async_resolve_media(self, item: MediaSourceItem) -> PlayMedia:
        """Resolve media to a same-origin proxy url (see views.py).

        The Home Hub's own web client uses `cmd=Playback` (not `cmd=Download`) for
        smooth recorded playback - captured directly from its network traffic.
        `reolink_aio` already builds this exact URL shape for VodRequestType.PLAYBACK
        (same as Download, just a different `cmd=` value). The actual get_vod_source
        call happens server-side in ReolinkHubPlaybackBridgeStreamView at request
        time, not here - resolve_media just needs to hand back a URL the browser can
        fetch.

        Must be same-origin (proxied through HA), not the raw device URL: the Home
        Hub's response carries no Access-Control-Allow-Origin, and mpegts.js needs
        fetch()/XHR (for MediaSource Extensions) which is subject to CORS - unlike a
        plain <video src>. Confirmed via a HAR capture showing a 200 OK with correct
        headers but 0 bytes ever reaching page JS.
        """
        identifier = ["UNKNOWN"]
        if item.identifier is not None:
            identifier = item.identifier.split("|", 8)
        if identifier[0] != "FILE":
            raise Unresolvable(f"Unknown media item '{item.identifier}'.")

        (
            _,
            config_entry_id,
            channel_str,
            stream_res,
            filename,
            _start_time,
            _end_time,
            _duration_ms,
            _triggers,
        ) = identifier

        # The trailing /0 is the seek segment (see views.py) - always present
        # so the initial signed URL from media_source/resolve_media needs no
        # further modification before use; the card only builds a different
        # one (re-signed via auth/sign_path) when the user actually scrubs.
        proxy_url = (
            f"/api/reolink_hub_playback_bridge/stream/{config_entry_id}/{channel_str}/"
            f"{stream_res}/0/{quote(filename, safe='')}"
        )
        return PlayMedia(proxy_url, "video/x-flv")

    @override
    async def async_browse_media(
        self,
        item: MediaSourceItem,
    ) -> BrowseMediaSource:
        """Return media - identical tree shape to the built-in reolink media_source."""
        if not item.identifier:
            return await self._async_generate_root()

        identifier = item.identifier.split("|", 7)
        item_type = identifier[0]

        if item_type == "CAM":
            _, config_entry_id, channel_str = identifier
            return await self._async_generate_resolution_select(
                config_entry_id, int(channel_str)
            )
        if item_type == "RES":
            _, config_entry_id, channel_str, stream = identifier
            return await self._async_generate_camera_days(
                config_entry_id, int(channel_str), stream
            )
        if item_type == "SUMMARY":
            _, config_entry_id, channel_str, stream = identifier
            return await self._async_generate_day_summary(
                config_entry_id, int(channel_str), stream
            )
        if item_type == "DAY":
            (
                _,
                config_entry_id,
                channel_str,
                stream,
                year_str,
                month_str,
                day_str,
            ) = identifier
            return await self._async_generate_camera_files(
                config_entry_id,
                int(channel_str),
                stream,
                int(year_str),
                int(month_str),
                int(day_str),
            )
        if item_type == "EVE":
            (
                _,
                config_entry_id,
                channel_str,
                stream,
                year_str,
                month_str,
                day_str,
                event,
            ) = identifier
            return await self._async_generate_camera_files(
                config_entry_id,
                int(channel_str),
                stream,
                int(year_str),
                int(month_str),
                int(day_str),
                event,
            )

        raise Unresolvable(f"Unknown media item '{item.identifier}' during browsing.")

    async def _async_generate_root(self) -> BrowseMediaSource:
        """Return all available reolink cameras as root browsing structure."""
        children: list[BrowseMediaSource] = []

        entity_reg = er.async_get(self.hass)
        device_reg = dr.async_get(self.hass)
        for config_entry in self.hass.config_entries.async_loaded_entries(
            REOLINK_DOMAIN
        ):
            channels: list[str] = []
            host = config_entry.runtime_data.host
            entities = er.async_entries_for_config_entry(
                entity_reg, config_entry.entry_id
            )
            for entity in entities:
                if (
                    entity.disabled
                    or entity.device_id is None
                    or entity.domain != CAM_DOMAIN
                ):
                    continue

                device = device_reg.async_get(entity.device_id)
                ch_id = entity.unique_id.split("_")[1]
                if ch_id in channels or device is None:
                    continue
                channels.append(ch_id)

                ch = resolve_channel(host, ch_id)

                if not host.api.supported(int(ch), "replay") or not host.api.hdd_info:
                    continue

                device_name = device.name
                if device.name_by_user is not None:
                    device_name = device.name_by_user

                if host.api.model in DUAL_LENS_MODELS:
                    device_name = f"{device_name} lens {ch}"

                children.append(
                    BrowseMediaSource(
                        domain=DOMAIN,
                        identifier=f"CAM|{config_entry.entry_id}|{ch}",
                        media_class=MediaClass.CHANNEL,
                        media_content_type=MediaType.PLAYLIST,
                        title=device_name,
                        thumbnail=f"/api/camera_proxy/{entity.entity_id}",
                        can_play=False,
                        can_expand=True,
                    )
                )

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=None,
            media_class=MediaClass.APP,
            media_content_type="",
            title="Reolink (fast)",
            can_play=False,
            can_expand=True,
            children=children,
        )

    async def _async_generate_resolution_select(
        self, config_entry_id: str, channel: int
    ) -> BrowseMediaSource:
        """Allow the user to select the high or low playback resolution."""
        host = get_host(self.hass, config_entry_id)

        children = [
            BrowseMediaSource(
                domain=DOMAIN,
                identifier=f"RES|{config_entry_id}|{channel}|sub",
                media_class=MediaClass.CHANNEL,
                media_content_type=MediaType.PLAYLIST,
                title="Low resolution",
                can_play=False,
                can_expand=True,
            ),
            BrowseMediaSource(
                domain=DOMAIN,
                identifier=f"RES|{config_entry_id}|{channel}|main",
                media_class=MediaClass.CHANNEL,
                media_content_type=MediaType.PLAYLIST,
                title="High resolution",
                can_play=False,
                can_expand=True,
            ),
        ]

        title = host.api.camera_name(channel)
        if host.api.model in DUAL_LENS_MODELS:
            title = f"{host.api.camera_name(channel)} lens {channel}"

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"RESs|{config_entry_id}|{channel}",
            media_class=MediaClass.CHANNEL,
            media_content_type=MediaType.PLAYLIST,
            title=title,
            can_play=False,
            can_expand=True,
            children=children,
        )

    async def _async_generate_camera_days(
        self, config_entry_id: str, channel: int, stream: str
    ) -> BrowseMediaSource:
        """Return all days on which recordings are available for a reolink camera."""
        host = get_host(self.hass, config_entry_id)

        now = host.api.time() or await host.api.async_get_time()
        start = now - dt.timedelta(days=31)
        end = now

        statuses, _ = await host.api.request_vod_files(
            channel, start, end, status_only=True, stream=stream
        )
        children: list[BrowseMediaSource] = [
            BrowseMediaSource(
                domain=DOMAIN,
                identifier=f"DAY|{config_entry_id}|{channel}|{stream}|{status.year}|{status.month}|{day}",
                media_class=MediaClass.DIRECTORY,
                media_content_type=MediaType.PLAYLIST,
                title=f"{status.year}/{status.month}/{day}",
                can_play=False,
                can_expand=True,
            )
            for status in statuses
            for day in status.days
        ]

        title = f"{host.api.camera_name(channel)} {res_name(stream)}"
        if host.api.model in DUAL_LENS_MODELS:
            title = f"{host.api.camera_name(channel)} lens {channel} {res_name(stream)}"

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"DAYS|{config_entry_id}|{channel}|{stream}",
            media_class=MediaClass.CHANNEL,
            media_content_type=MediaType.PLAYLIST,
            title=title,
            can_play=False,
            can_expand=True,
            children=children,
        )

    async def _async_generate_day_summary(
        self, config_entry_id: str, channel: int, stream: str
    ) -> BrowseMediaSource:
        """Return per-day AI-trigger summaries for the browsable window.

        Powers the frontend calendar's filter-aware day highlighting.
        Unlike _async_generate_camera_days (status_only=True - cheap, since the
        Home Hub only reports which days have *any* recording), trigger data
        requires the full VOD file list. reolink_aio fetches that in a single
        request across the whole date range regardless of how many days it
        spans, so this is one extra network round-trip, not one per day - but
        it is a heavier response than the status-only call, hence this is its
        own browse branch fetched lazily by the frontend rather than folded
        into the fast day-list path.
        """
        host = get_host(self.hass, config_entry_id)

        now = host.api.time() or await host.api.async_get_time()
        start = now - dt.timedelta(days=31)
        end = now

        # split_time matters here, not just for display grouping: reolink_aio
        # only correlates file.bc_triggers (what file.triggers reads from) by
        # matching each file's start_time_id against the AI-detection events
        # returned by its separate Baichuan search_vod_type() call. Without
        # splitting, the Search command's raw (coarser, un-split) file blocks
        # have start_time_ids that don't line up with those finer-grained
        # per-event ids, so every file's triggers silently comes back empty -
        # _async_generate_camera_files avoids this the same way.
        _, vod_files = await host.api.request_vod_files(
            channel, start, end, stream=stream, split_time=VOD_SPLIT_TIME
        )

        triggers_by_day: dict[tuple[int, int, int], set[str]] = {}
        for file in vod_files:
            day_key = (file.start_time.year, file.start_time.month, file.start_time.day)
            triggers_by_day.setdefault(day_key, set()).update(
                trigger.name for trigger in file.triggers if trigger.name
            )

        children = [
            BrowseMediaSource(
                domain=DOMAIN,
                identifier=(
                    f"DAYSUM|{config_entry_id}|{channel}|{stream}|"
                    f"{year}|{month}|{day}|{','.join(sorted(triggers)) or 'NONE'}"
                ),
                media_class=MediaClass.DIRECTORY,
                media_content_type=MediaType.PLAYLIST,
                title=f"{year}/{month}/{day}",
                can_play=False,
                can_expand=False,
            )
            for (year, month, day), triggers in triggers_by_day.items()
        ]

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"SUMMARIES|{config_entry_id}|{channel}|{stream}",
            media_class=MediaClass.CHANNEL,
            media_content_type=MediaType.PLAYLIST,
            title="Recording day summary",
            can_play=False,
            can_expand=True,
            children=children,
        )

    async def _async_generate_camera_files(
        self,
        config_entry_id: str,
        channel: int,
        stream: str,
        year: int,
        month: int,
        day: int,
        event: str | None = None,
    ) -> BrowseMediaSource:
        """Return all recording files on a specific day of a Reolink camera."""
        host = get_host(self.hass, config_entry_id)

        start = dt.datetime(year, month, day, hour=0, minute=0, second=0)
        end = dt.datetime(year, month, day, hour=23, minute=59, second=59)

        children: list[BrowseMediaSource] = []
        event_trigger = VOD_trigger[event] if event is not None else None
        _, vod_files = await host.api.request_vod_files(
            channel,
            start,
            end,
            stream=stream,
            split_time=VOD_SPLIT_TIME,
            trigger=event_trigger,
        )

        if event is None and host.api.is_nvr and not host.api.is_hub:
            triggers = VOD_trigger.NONE
            for file in vod_files:
                triggers |= file.triggers

            children.extend(
                BrowseMediaSource(
                    domain=DOMAIN,
                    identifier=f"EVE|{config_entry_id}|{channel}|{stream}|{year}|{month}|{day}|{trigger.name}",
                    media_class=MediaClass.DIRECTORY,
                    media_content_type=MediaType.PLAYLIST,
                    title=str(trigger.name).title(),
                    can_play=False,
                    can_expand=True,
                )
                for trigger in triggers
            )

        for file in vod_files:
            file_name = f"{file.start_time.time()} {file.duration}"
            # Structured fields (for the frontend card's duration/filter-chip UI) -
            # kept separate from the human-readable title below so the card doesn't
            # have to parse them back out of display text. mpegts.js needs an
            # explicit duration hint (in ms) since the Home Hub's FLV metadata
            # doesn't reliably carry one, which otherwise leaves video.duration as
            # Infinity and disables the native seek bar.
            duration_ms = int(file.duration.total_seconds() * 1000)
            trigger_str = (
                ",".join(str(trigger.name) for trigger in file.triggers if trigger.name)
                or "NONE"
            )
            if file.triggers != file.triggers.NONE:
                file_name += " " + " ".join(
                    str(trigger.name).title() for trigger in file.triggers
                )

            children.append(
                BrowseMediaSource(
                    domain=DOMAIN,
                    identifier=f"FILE|{config_entry_id}|{channel}|{stream}|{file.file_name}|{file.start_time_id}|{file.end_time_id}|{duration_ms}|{trigger_str}",
                    media_class=MediaClass.VIDEO,
                    media_content_type=MediaType.VIDEO,
                    title=file_name,
                    can_play=True,
                    can_expand=False,
                )
            )

        title = (
            f"{host.api.camera_name(channel)} {res_name(stream)} {year}/{month}/{day}"
        )
        if host.api.model in DUAL_LENS_MODELS:
            title = (
                f"{host.api.camera_name(channel)} lens"
                f" {channel} {res_name(stream)}"
                f" {year}/{month}/{day}"
            )
        if event:
            title = f"{title} {event.title()}"

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"FILES|{config_entry_id}|{channel}|{stream}",
            media_class=MediaClass.CHANNEL,
            media_content_type=MediaType.PLAYLIST,
            title=title,
            can_play=False,
            can_expand=True,
            children=children,
        )
