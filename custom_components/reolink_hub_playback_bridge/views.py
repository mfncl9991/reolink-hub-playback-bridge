"""Streaming proxy for Reolink Playback VOD.

mpegts.js retrieves stream bytes via fetch()/XHR (needed to feed MediaSource
Extensions), which is subject to CORS - unlike a plain <video src>, which
isn't. The Home Hub sends no Access-Control-Allow-Origin header, so a direct
cross-origin fetch is silently blocked by the browser (confirmed via a HAR
capture: 200 OK with correct headers, but 0 bytes ever reach page JS).

This view fetches the clip server-side (no CORS applies to Python) and
streams it back to the browser.

Firefox/Gecko has a separate, unrelated bug where its Service Worker fails
on this large chunked-transfer stream when fetched same-origin from the HA
frontend ("A ServiceWorker intercepted the request and encountered an
unexpected error") - Cache-Control has no effect since a Service Worker
decides whether to intercept a request before any response exists. Since HA
core has no per-path way to exclude a route from its frontend's Service
Worker scope, some deployments route this view through a second origin
(proxying the same backend) for browsers other than Safari instead -
Service Workers are strictly origin-scoped, so they never see cross-origin
requests at all. That means this endpoint needs a real CORS header for the
cross-origin case: it reflects whatever Origin the request actually came
from, rather than a fixed hostname, so this works for any deployment
without extra configuration.
"""

import logging
from urllib.parse import unquote

from aiohttp import ClientPayloadError, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.reolink.util import get_host
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from reolink_aio.enums import VodRequestType

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _stream_headers(request: web.Request, content_type: str) -> dict[str, str]:
    """Build response headers, reflecting the request's own Origin if present.

    Echoing the caller's Origin (rather than a fixed hostname) lets this proxy
    serve a same-origin dashboard and a second cross-origin one (see the
    module docstring) without any per-instance configuration. This endpoint
    is already `requires_auth = True` and protected by HA's signed-path auth,
    so reflecting Origin doesn't weaken access control.
    """
    headers = {
        "Content-Type": content_type,
        "Cache-Control": "no-store",
    }
    origin = request.headers.get("Origin")
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
    return headers


class ReolinkHubPlaybackBridgeLiveStreamView(HomeAssistantView):
    """Proxy a Reolink live FLV stream from the same origin as the frontend.

    Same CORS/Service-Worker rationale as ReolinkHubPlaybackBridgeStreamView
    below, applied to live view instead of VOD playback. Confirmed via a HAR
    capture of the Home Hub's own web client's live view: it hits a distinct
    endpoint from Playback (`/flv?...&stream=channel{N}_{main|sub}.bcs`, an
    HTTP-FLV gateway onto the Home Hub's internal RTMP stream) but still
    serves `video/x-flv`, so the same mpegts.js/MSE pipeline used for VOD
    applies unchanged - just pointed at `reolink_aio`'s
    `get_flv_stream_source()` instead of `get_vod_source()`.

    Must stay server-side proxied rather than handed to the browser directly:
    `get_flv_stream_source()` embeds the Reolink account's plaintext password
    in the URL query string.
    """

    url = (
        "/api/reolink_hub_playback_bridge/live/{config_entry_id}/{channel}/{stream_res}"
    )
    name = f"api:{DOMAIN}:live"
    requires_auth = True

    async def get(
        self,
        request: web.Request,
        config_entry_id: str,
        channel: str,
        stream_res: str,
    ) -> web.StreamResponse:
        """Fetch the live stream from the Home Hub and stream it back same-origin."""
        if stream_res not in ("main", "sub"):
            return web.Response(status=400, text="invalid stream_res")

        hass = request.app["hass"]
        host = get_host(hass, config_entry_id)

        url = host.api.get_flv_stream_source(int(channel), stream_res)
        if url is None:
            return web.Response(status=404, text="channel not available")

        session = async_get_clientsession(hass, verify_ssl=False)
        upstream = await session.get(url)

        response = web.StreamResponse(
            status=upstream.status,
            headers=_stream_headers(request, "video/x-flv"),
        )
        await response.prepare(request)
        try:
            async for chunk in upstream.content.iter_chunked(65536):
                await response.write(chunk)
        except (ClientPayloadError, ConnectionError, OSError) as err:
            _LOGGER.debug("upstream live stream for channel %s ended: %s", channel, err)
        finally:
            upstream.close()
        await response.write_eof()
        return response


class ReolinkHubPlaybackBridgeStreamView(HomeAssistantView):
    """Proxy a Reolink Playback VOD stream from the same origin as the frontend."""

    url = (
        "/api/reolink_hub_playback_bridge/stream/{config_entry_id}/{channel}/"
        "{stream_res}/{seek}/{filename:.+}"
    )
    name = f"api:{DOMAIN}:stream"
    requires_auth = True

    async def get(
        self,
        request: web.Request,
        config_entry_id: str,
        channel: str,
        stream_res: str,
        seek: str,
        filename: str,
    ) -> web.StreamResponse:
        """Fetch the clip from the Home Hub and stream it back same-origin."""
        hass = request.app["hass"]
        host = get_host(hass, config_entry_id)
        decoded_filename = unquote(filename)

        # get_vod_source() reports mime_type="video/mp4" for this branch, which is
        # wrong for this firmware - the Home Hub actually serves FLV regardless of
        # the .mp4 filename (confirmed via response headers), so hard-code it here.
        _wrong_mime, url = await host.api.get_vod_source(
            int(channel), decoded_filename, stream_res, VodRequestType.PLAYBACK
        )

        # Mid-clip seeking: confirmed via a HAR capture of the Home Hub's own web
        # client that cmd=Playback supports a `seek=<seconds-into-clip>` query
        # param (undocumented - reolink_aio's get_vod_source() never sets it,
        # only `start=`, which is always the clip's own start time). This used
        # to be a query param the card added after the fact (see the old
        # _withSeekParam), but HA's signed-path auth (authSig) only ever
        # authorizes the exact query params present when the URL was signed -
        # confirmed live via HA's own auth logs, which flagged every single
        # request here as invalid, on every browser, because `seek` was never
        # in that set. A path segment is covered by the signature by
        # construction, so seek lives here instead - see the card's
        # _pathWithSeek/_commitSeek, which build a fresh URL segment and
        # re-sign it via auth/sign_path for a real seek.
        try:
            seek_seconds = int(seek)
        except ValueError:
            seek_seconds = 0
        if seek_seconds > 0:
            url = f"{url}&seek={seek_seconds}"

        session = async_get_clientsession(hass, verify_ssl=False)
        upstream = await session.get(url)

        # no-store: without this, HA frontend's service worker attempts to
        # cache/clone this large, unbounded chunked-transfer stream, which
        # throws mid-stream ("A ServiceWorker intercepted the request and
        # encountered an unexpected error") and corrupts the MSE buffer -
        # confirmed via browser console errors during playback.
        response = web.StreamResponse(
            status=upstream.status,
            headers=_stream_headers(request, "video/x-flv"),
        )
        await response.prepare(request)
        try:
            async for chunk in upstream.content.iter_chunked(65536):
                await response.write(chunk)
        except (ClientPayloadError, ConnectionError, OSError) as err:
            # The Home Hub occasionally closes the connection before delivering
            # everything it originally declared via its Content-Length/
            # Transfer-Encoding header (a Home Hub-side quirk - not something
            # this proxy controls). Left uncaught, this surfaced as an unhandled
            # traceback in the HA log and an abrupt network-level abort on the
            # browser side, which mpegts.js reports as "Error in input stream".
            # End the response cleanly instead so the browser sees a normal
            # (if short) stream completion.
            _LOGGER.debug(
                "upstream stream for %s ended early: %s", decoded_filename, err
            )
        finally:
            upstream.close()
        await response.write_eof()
        return response
