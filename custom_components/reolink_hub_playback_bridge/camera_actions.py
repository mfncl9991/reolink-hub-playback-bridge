"""In-memory runtime state for the card's PTZ-pad PIR-suppress and manual-
record auto-stop features - see websocket.py for the commands the card
calls into these from.

Both features used to depend on user-hand-authored `timer.*` helpers +
restore automations (a fresh HACS install got neither), and PIR-suppress in
particular had a real failure mode: its client-side restore only ran from JS
lifecycle callbacks, so a killed tab/backgrounded app/dropped network mid-pan
left PIR floored indefinitely (confirmed 2026-07-28, floored for 19+ hours).
Moving both to backend-owned `async_call_later` scheduling means they work
out of the box, and the timeout survives regardless of what happens to the
browser tab that started it.

State lives on the config entry's runtime_data, not anywhere persisted -
that's intentional. An HA restart or integration reload clears it for free,
the same "fail open" tradeoff the old `restore: false` timer helpers made
deliberately: worst case after a restart is PIR resumes at whatever it was
last panned to, or a manual recording keeps running past its window, rather
than staying silently stuck. async_unload_entry (see __init__.py) cancels
every pending callback below so a reload can't leave an orphaned
async_call_later holding a stale closure.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from homeassistant.core import CALLBACK_TYPE, HomeAssistant
from homeassistant.helpers.event import async_call_later

# Matches the old timer.<slug>_pir_pan_safety helper's duration.
PIR_PAN_SAFETY_TIMEOUT_SECONDS = 5 * 60


@dataclass
class _PirSuppression:
    saved_value: float
    snooze_timer_entity_id: str | None
    cancel_restore: CALLBACK_TYPE


@dataclass
class RuntimeData:
    """Per-entry in-memory state - see module docstring."""

    pir_suppressions: dict[str, _PirSuppression] = field(default_factory=dict)
    manual_record_stops: dict[str, CALLBACK_TYPE] = field(default_factory=dict)

    def cancel_all(self) -> None:
        """Cancel every pending scheduled callback. Called from async_unload_entry."""
        for suppression in self.pir_suppressions.values():
            suppression.cancel_restore()
        self.pir_suppressions.clear()
        for cancel in self.manual_record_stops.values():
            cancel()
        self.manual_record_stops.clear()


def _snooze_active(hass: HomeAssistant, snooze_timer_entity_id: str | None) -> bool:
    """Whether a real notification-action snooze is active for this camera.

    Only ever reads this entity - never creates, starts, or assumes it
    exists. That feature (timer.<slug>_camera_snooze) lives entirely outside
    this integration; a missing entity_id or entity just means no such
    feature is configured, not an error.
    """
    if not snooze_timer_entity_id:
        return False
    state = hass.states.get(snooze_timer_entity_id)
    return state is not None and state.state == "active"


async def _async_restore_pir(
    hass: HomeAssistant, runtime_data: RuntimeData, pir_entity_id: str
) -> None:
    suppression = runtime_data.pir_suppressions.pop(pir_entity_id, None)
    if suppression is None:
        return
    # Re-checked at fire time, not just at start/end - a real snooze could
    # have started after the pad opened and outlived this timeout, in which
    # case that snooze's own expiry owns restoration instead (same guard
    # async_ptz_pir_suppress_end applies at close time).
    if _snooze_active(hass, suppression.snooze_timer_entity_id):
        return
    await hass.services.async_call(
        "number",
        "set_value",
        {"entity_id": pir_entity_id, "value": suppression.saved_value},
        blocking=True,
    )


async def async_ptz_pir_suppress_start(
    hass: HomeAssistant,
    runtime_data: RuntimeData,
    pir_entity_id: str,
    snooze_timer_entity_id: str | None,
) -> None:
    """Floor PIR sensitivity for as long as the PTZ pad stays open.

    Called once per pad open (card-initiated pans only - the reolink
    integration gives HA no reliable way to detect a pan made directly in
    the Reolink app). If a suppression is already active for this entity
    (e.g. a start message replayed after a reconnect with no intervening
    end), only the timeout restarts - the saved value is never overwritten
    with the already-floored current one.
    """
    pir_state = hass.states.get(pir_entity_id)
    if pir_state is None:
        return  # not every camera has a PIR sensitivity entity

    existing = runtime_data.pir_suppressions.pop(pir_entity_id, None)
    if existing is not None:
        existing.cancel_restore()
        saved_value = existing.saved_value
    else:
        if _snooze_active(hass, snooze_timer_entity_id):
            return
        saved_value = float(pir_state.state)
        await hass.services.async_call(
            "number",
            "set_value",
            {"entity_id": pir_entity_id, "value": pir_state.attributes.get("min", 1)},
            blocking=True,
        )

    async def _restore(_now) -> None:
        await _async_restore_pir(hass, runtime_data, pir_entity_id)

    cancel_restore = async_call_later(hass, PIR_PAN_SAFETY_TIMEOUT_SECONDS, _restore)
    runtime_data.pir_suppressions[pir_entity_id] = _PirSuppression(
        saved_value, snooze_timer_entity_id, cancel_restore
    )


async def async_ptz_pir_suppress_end(
    hass: HomeAssistant,
    runtime_data: RuntimeData,
    pir_entity_id: str,
) -> None:
    """Restore PIR sensitivity when the pad closes.

    Skipped if a real notification-action snooze is active by then - that
    snooze's own expiry handles restoration at the right time instead, so
    closing the pad mid-snooze can't cut it short.
    """
    suppression = runtime_data.pir_suppressions.pop(pir_entity_id, None)
    if suppression is None:
        return
    suppression.cancel_restore()
    if _snooze_active(hass, suppression.snooze_timer_entity_id):
        return
    await hass.services.async_call(
        "number",
        "set_value",
        {"entity_id": pir_entity_id, "value": suppression.saved_value},
        blocking=True,
    )


async def async_manual_record_schedule_stop(
    hass: HomeAssistant, runtime_data: RuntimeData, entity_id: str, minutes: float
) -> None:
    """Schedule switch.turn_off after `minutes`.

    Only ever called by the card when an auto-stop duration is actually
    configured (not "Off") - replaces any previously scheduled stop for this
    switch, matching the old timer's "start restarts the countdown" behavior.
    """
    manual_record_cancel_stop(runtime_data, entity_id)

    async def _stop(_now) -> None:
        runtime_data.manual_record_stops.pop(entity_id, None)
        await hass.services.async_call(
            "switch", "turn_off", {"entity_id": entity_id}, blocking=True
        )

    runtime_data.manual_record_stops[entity_id] = async_call_later(
        hass, minutes * 60, _stop
    )


def manual_record_cancel_stop(runtime_data: RuntimeData, entity_id: str) -> None:
    """Cancel any pending scheduled stop. No-op if none exists."""
    cancel = runtime_data.manual_record_stops.pop(entity_id, None)
    if cancel is not None:
        cancel()
