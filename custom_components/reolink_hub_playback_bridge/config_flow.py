"""Config flow for Reolink Hub Playback Bridge.

There's nothing to ask the user - no credentials, no host/port. This
integration reuses the already-authenticated `reolink` config entry's
`host.api` at request time (see views.py/media_source.py), so the only
thing a config entry here represents is "enabled". Duplicate-instance
prevention is handled by the `single_config_entry` manifest flag, which
HA checks for every flow source (including the YAML import below), so no
manual `_async_current_entries()` guard is needed here.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, TITLE


class ReolinkHubPlaybackBridgeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Reolink Hub Playback Bridge."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> ConfigFlowResult:
        """Handle the (fieldless) confirmation step."""
        if user_input is not None:
            return self.async_create_entry(title=TITLE, data={})
        return self.async_show_form(step_id="user")

    async def async_step_import(
        self, import_config: dict | None = None
    ) -> ConfigFlowResult:
        """Import the legacy bare `reolink_hub_playback_bridge:` YAML key."""
        return await self.async_step_user({})
