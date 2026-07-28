"""Auto-register the companion Lovelace card's JS resources.

The card ships as two files under www/reolink-hub-playback-bridge/, served by
HA's built-in /local/ static path. Registering them as Lovelace resources only
works when dashboards are in storage mode (the default) - YAML-mode dashboards
have no writable resource collection, so those users still add them by hand
(see the README).

Order matters: the card checks for `window.mpegts` when it loads and won't
work if it loads first. HA's storage-mode resources collection is dict/list
backed (insertion order preserved), unlike `frontend.add_extra_js_url`'s
frozenset - which is why this writes directly into the Lovelace resources
collection instead of using that public API.
"""

import logging

from homeassistant.components.lovelace.const import (
    CONF_RESOURCE_TYPE_WS,
    LOVELACE_DATA,
    MODE_STORAGE,
)
from homeassistant.const import CONF_ID, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_RESOURCE_BASE_PATH = "/local/reolink-hub-playback-bridge"
_RESOURCE_FILES = ("mpegts.js", "reolink-hub-playback-bridge-card.js")


async def async_register_lovelace_resources(hass: HomeAssistant) -> None:
    """Add/update the card's two JS resources in the storage resources collection.

    Best-effort: any failure is logged and otherwise ignored - a missing
    Lovelace resource never breaks the integration itself, and the README
    documents the manual fallback.
    """
    try:
        lovelace_data = hass.data.get(LOVELACE_DATA)
        if lovelace_data is None or lovelace_data.resource_mode != MODE_STORAGE:
            _LOGGER.debug(
                "Skipping automatic Lovelace resource registration (dashboards "
                "aren't in storage mode); add the two JS files under www/%s "
                "manually - see the README",
                DOMAIN,
            )
            return

        resources = lovelace_data.resources
        await resources.async_get_info()  # ensures the storage collection is loaded
        existing = {
            item[CONF_URL].split("?", 1)[0]: item for item in resources.async_items()
        }

        integration = await async_get_integration(hass, DOMAIN)
        version = integration.version or "0"

        for filename in _RESOURCE_FILES:
            base_url = f"{_RESOURCE_BASE_PATH}/{filename}"
            url = f"{base_url}?v={version}"
            current = existing.get(base_url)
            if current is None:
                await resources.async_create_item(
                    {CONF_RESOURCE_TYPE_WS: "module", CONF_URL: url}
                )
            elif current[CONF_URL] != url:
                await resources.async_update_item(current[CONF_ID], {CONF_URL: url})
    except Exception:  # noqa: BLE001 - cosmetic, must never break entry setup
        _LOGGER.warning(
            "Could not auto-register Lovelace resources for the Reolink Hub "
            "Playback Bridge card; add the two JS files under "
            "www/reolink-hub-playback-bridge/ manually - see the README",
            exc_info=True,
        )
