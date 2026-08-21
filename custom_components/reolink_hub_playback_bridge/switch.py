"""Force Live View switch.

Lets an automation flip the connected camera card straight into live view
during a security alert, instead of waiting for someone to tap the card's
own LIVE button - see the card's `live_trigger_entity` config key and
`_checkLiveTrigger()` in reolink-hub-playback-bridge-card.js.

A single switch for every camera is intentional, and matches
`single_config_entry`: whichever card is actually on screen when this turns
on is the one that reacts (via its own `live_trigger_entity` config), so
there's nothing per-camera to disambiguate here.

State is in-memory only, unlike the PIR-suppress/manual-record timers in
camera_actions.py - there's no "resume where we left off" case that matters:
an alert automation always turns this back off itself a few seconds later,
and starting at "off" after a restart is simply the safer default (never
stuck mid-live-stream) rather than something worth restoring across a
restart.
"""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Force Live View switch for this config entry."""
    async_add_entities([ForceLiveViewSwitch(entry)])


class ForceLiveViewSwitch(SwitchEntity):
    """Switch an automation flips to force the on-screen card into live view."""

    _attr_name = "Reolink Hub Playback Bridge Force Live View"
    _attr_icon = "mdi:cctv"
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry) -> None:
        self._attr_unique_id = f"{entry.entry_id}_force_live_view"
        self._attr_is_on = False

    async def async_turn_on(self, **kwargs) -> None:
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self._attr_is_on = False
        self.async_write_ha_state()
