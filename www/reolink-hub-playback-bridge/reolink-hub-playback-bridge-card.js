/**
 * Reolink Hub Playback Bridge Card
 *
 * Browses a reolink_hub_playback_bridge media_source tree (day -> clips) and plays the
 * selected clip via mpegts.js (must be loaded first - see mpegts.js in this
 * same directory). The Home Hub's Playback CGI command serves FLV, which no
 * browser plays natively via a plain <video src> - mpegts.js demuxes it
 * client-side into fragmented MP4 fed through Media Source Extensions,
 * including iOS Safari 17.1+ via ManagedMediaSource.
 *
 * UI layer: day stepper with a calendar popup, a horizontally-scrolling clip
 * tile strip (oldest to newest, left to right - the newest clip is
 * auto-selected/played on load and the strip starts scrolled all the way
 * right so older clips are reached by scrolling left), AI-trigger filter
 * chips (Person/Vehicle/Animal/etc, derived from
 * reolink_hub_playback_bridge's structured FILE identifier - see media_source.py), and
 * an optional single-camera live view. None of this touches the FLV/mpegts.js
 * playback pipeline below (_playFlv/_destroyPlayer/_syncVisibility/
 * _rewriteToCrossOrigin), which is intentionally conservative given how many
 * subtle bugs it's already had.
 *
 * Live view plays the Home Hub's live FLV stream (same container as VOD,
 * confirmed via a HAR capture of the Home Hub's own web client - a distinct
 * `/flv?...&stream=channel{N}_{main|sub}.bcs` endpoint from Playback, but
 * still `video/x-flv`) through the same mpegts.js/MSE pipeline, proxied
 * server-side by ReolinkHubPlaybackBridgeLiveStreamView since get_flv_stream_source()
 * embeds the account's plaintext password in the URL. The main stream is
 * HEVC on this hub - browsers whose MediaSource accepts hvc1/hev1 (confirmed
 * via MediaSource.isTypeSupported, e.g. Firefox/Zen and Safari, not Chrome)
 * can play it natively; the quality toggle lets the user pick sub (H.264,
 * always playable) instead. Falls back to Home Assistant's own
 * ha-camera-stream component when mpegts.js/MSE isn't usable at all.
 *
 * Live view also optionally exposes PTZ controls (_ptzMove/_ptzStop/
 * _ptzZoomStep/_updatePtzPresetUi/_ptzRecallDefault), gated entirely by
 * config keys (ptz_pad_entity_prefix, ptz_preset_entity, ptz_zoom_entity,
 * ptz_guard_entity) so a card instance without them renders no PTZ UI at
 * all. The pad presses per-direction button entities the integration exposes
 * (there's no camera-level service with pan/tilt fields, and reolink.ptz_move
 * requires a supported_features flag some cameras' button entities don't
 * carry - see _ptzMove) - this is continuous-move, not discrete-step, so
 * panning is press-and-hold with an explicit stop on release. Presets are
 * read live from the configured select
 * entity's `options` attribute rather than hardcoded, so the pill list
 * follows whatever's actually configured on the camera. Opening the pad also
 * floors that camera's PIR sensitivity for as long as it's open
 * (_ptzSuppressPirStart/_ptzSuppressPirEnd), the same technique a
 * notification-snooze automation might use to suppress a motion alert while
 * you're panning - card-initiated pans only, since the reolink integration
 * gives HA no reliable way to detect a pan made directly in the Reolink app.
 */

// Cheap, cached at module scope since MediaSource support doesn't change
// within a session - re-running isTypeSupported() per live-view open would
// be pointless work repeated on every quality toggle.
let _hevcMseSupportCache;
function hevcMseSupported() {
  if (_hevcMseSupportCache === undefined) {
    _hevcMseSupportCache =
      typeof MediaSource !== "undefined" &&
      typeof MediaSource.isTypeSupported === "function" &&
      (MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.90"') ||
        MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.90"'));
  }
  return _hevcMseSupportCache;
}

const TRIGGER_ICONS = {
  PERSON: "mdi:account",
  VEHICLE: "mdi:car",
  ANIMAL: "mdi:paw",
  DOORBELL: "mdi:bell-ring",
  PACKAGE: "mdi:package-variant-closed",
  FACE: "mdi:face-recognition",
  CROSSLINE: "mdi:vector-line",
  INTRUSION: "mdi:shield-alert",
  LINGER: "mdi:timer-sand",
  MOTION: "mdi:motion-sensor",
  TIMER: "mdi:clock-outline",
};

// Always-visible filter chips, greyed out when empty for the selected day -
// the trigger types worth a permanent, predictable spot in the UI.
const CORE_TRIGGERS = ["PERSON", "VEHICLE", "ANIMAL", "DOORBELL", "PACKAGE"];

// Ordering for the *dynamic* long-tail chips that still only appear when
// actually present that day (Face, Crossline, etc) - core triggers are
// excluded here since they're rendered separately, always, above.
const TRIGGER_PRIORITY = [
  "FACE",
  "CROSSLINE",
  "INTRUSION",
  "LINGER",
  "MOTION",
  "TIMER",
];

const WEEKDAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function triggerIcon(name) {
  return TRIGGER_ICONS[name] || "mdi:motion-sensor";
}

function triggerLabel(name) {
  return name
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

class ReolinkHubPlaybackBridgeCard extends HTMLElement {
  setConfig(config) {
    if (!config.media_source_id) {
      throw new Error("reolink-hub-playback-bridge-card: media_source_id is required");
    }
    this._config = config;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    this._liveBtn.hidden = !config.live_camera_entity;
    // Record button only ever shows while the live view is actually active
    // (see _toggleLive/_destroyLiveView) - recordings view has no live
    // camera feed to record from, so it stays hidden here regardless of
    // config until the live view is toggled on.
    this._updateRecordBtnVisibility();
    this._batteryBadge.hidden = !config.battery_entity;
    this._updatePtzUiVisibility();
    // hq_available/hq_default (not the media_source_id RES suffix - see
    // _entryAndChannel) are the sole source of truth for whether HQ is even
    // reachable and whether it's the opening quality. Applies to both live
    // and recordings. When hq_available is false this is reasserted on every
    // setConfig call (not just first init) so a config change that turns HQ
    // off can't leave a stale "main" selection active; otherwise it's only
    // seeded once so an in-session toggle survives a config re-apply from the
    // dashboard editor.
    if (!this._config.hq_available) {
      this._quality = "sub";
    } else if (this._quality === undefined) {
      this._quality = this._config.hq_default ? "main" : "sub";
    }
    this._qualityBtn.hidden = !this._entryAndChannel() || !this._config.hq_available;
    this._updateQualityBtn();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loadedDays) {
      this._loadedDays = true;
      this._loadDays();
    }
    this._syncVisibility();
    if (this._liveActive && this._liveEl && this._config.live_camera_entity) {
      this._liveEl.hass = hass;
      this._liveEl.stateObj = hass.states[this._config.live_camera_entity];
    }
    if (this._config.record_switch_entity) this._updateRecordBtn();
    if (this._config.battery_entity) this._updateBatteryBadge();
    if (this._config.ptz_preset_entity) this._updatePtzPresetUi();
  }

  getCardSize() {
    return 10;
  }

  // Sections-view sizing contract: without this, HA's "auto-height" mode
  // (triggered by grid_options.rows: "auto" in the dashboard config) hides
  // the height-resize drag handle in the layout editor entirely.
  getGridOptions() {
    return { rows: 10, min_rows: 6, max_rows: 24 };
  }

  static getConfigElement() {
    return document.createElement("reolink-hub-playback-bridge-card-editor");
  }

  disconnectedCallback() {
    this._destroyPlayer();
    this._destroyLiveView();
    if (this._onDocumentClick) {
      document.removeEventListener("click", this._onDocumentClick);
    }
    this._teardownSeekBar?.();
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        /* Several elements below set an explicit display (flex, mostly for
           the resize layout) which otherwise wins over the browser's default
           [hidden] { display: none } UA rule at equal specificity, since
           author styles always beat UA styles - silently defeating every
           el.hidden = true toggle used for the live-view switch. This one
           override rule makes hidden authoritative regardless of any other
           display declaration in this stylesheet. */
        [hidden] { display: none !important; }
        ha-card { height: 100%; box-sizing: border-box; padding: 12px; display: flex; flex-direction: column; }
        .topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .pill {
          padding: 6px 14px; border-radius: 999px; border: none; cursor: pointer;
          font-size: 0.85em; font-weight: 600;
          background: var(--secondary-background-color, #2a2a2a); color: var(--primary-text-color, #fff);
        }
        .pill:disabled { opacity: 0.5; cursor: default; }
        .pill.active { background: var(--primary-color, #03a9f4); color: #fff; }
        .record-btn { display: flex; align-items: center; justify-content: center; padding: 6px 12px; }
        .record-dot { width: 10px; height: 10px; border-radius: 50%; background: #e53935; display: block; }
        .record-btn.recording .record-dot { animation: record-pulse 1s ease-in-out infinite; }
        @keyframes record-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        /* Wraps record/quality/live so they stay pinned to the right edge even
           when today-btn/day-stepper are hidden (live view) and there's no
           other flex-grow sibling left to push against - margin-left: auto is
           a no-op when day-stepper IS visible and already claims the space via
           its own flex: 1, so this doesn't change the recordings-view layout. */
        .topbar-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
        .icon-pill { width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; }
        .icon-pill ha-icon { --mdc-icon-size: 18px; }
        .ptz-preset-wrap { position: relative; display: flex; }
        /* Icons default to a larger ha-icon size than the plain-text pills
           (HQ/LIVE/etc), which made this pill taller than its siblings -
           explicit flex + icon sizing matches the other pills' height. */
        .preset-btn { display: flex; align-items: center; gap: 4px; height: 28px; box-sizing: border-box; }
        .preset-btn ha-icon { --mdc-icon-size: 16px; }
        .ptz-preset-dropdown {
          position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 4px;
          background: var(--card-background-color, #1c1c1c); border: 1px solid var(--divider-color, #444);
          border-radius: 8px; padding: 4px; display: flex; flex-direction: column; gap: 2px; min-width: 140px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
        }
        .ptz-preset-dropdown button {
          border: none; background: transparent; color: var(--primary-text-color, #fff); text-align: left;
          padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 0.85em;
          display: flex; align-items: center; gap: 6px;
        }
        .ptz-preset-dropdown button:hover { background: var(--primary-color, #03a9f4); color: #fff; }
        .ptz-preset-dropdown button.active { background: var(--primary-color, #03a9f4); color: #fff; }
        .ptz-preset-dropdown ha-icon { --mdc-icon-size: 16px; }
        /* Pad sits below the video (own row after .live-view), never overlaid
           on it - see setConfig/_toggleLive for why this is live-view only. */
        .ptz-controls { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 20px; margin-top: 8px; }
        .ptz-pad { display: grid; grid-template-columns: repeat(3, 36px); grid-template-rows: repeat(3, 36px); gap: 4px; }
        .ptz-pad button {
          border: none; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;
          background: var(--secondary-background-color, #2a2a2a); color: var(--primary-text-color, #fff);
        }
        .ptz-pad button:active { background: var(--primary-color, #03a9f4); }
        .ptz-pad .pad-empty { background: transparent; pointer-events: none; }
        /* visibility (not [hidden]/display:none) when no preset entity is
           configured - a display:none grid item gets dropped from grid
           auto-placement entirely, which would shift left/right into the
           center cell and collapse the pad's cross shape. */
        .ptz-pad .pad-default.pad-default-unavailable { visibility: hidden; pointer-events: none; }
        .ptz-pad ha-icon { --mdc-icon-size: 18px; }
        .ptz-zoom { display: flex; flex-direction: column; gap: 4px; }
        .ptz-zoom button {
          width: 36px; height: 36px; border: none; border-radius: 8px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          background: var(--secondary-background-color, #2a2a2a); color: var(--primary-text-color, #fff);
        }
        .ptz-zoom ha-icon { --mdc-icon-size: 18px; }
        .day-stepper { position: relative; display: flex; align-items: center; gap: 4px; flex: 1; justify-content: center; }
        .day-stepper button {
          border: none; background: transparent; color: var(--primary-text-color, #fff);
          font-size: 1.1em; cursor: pointer; padding: 4px 8px; border-radius: 999px;
        }
        .day-stepper button:disabled { opacity: 0.3; cursor: default; }
        .day-label { font: inherit; font-weight: 600; font-size: 0.9em; min-width: 8em; text-align: center; }
        .filters {
          flex: 0 0 auto; display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
        }
        .filter-chips {
          display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; flex: 1 1 auto; min-width: 0;
        }
        .battery-badge {
          flex: 0 0 auto; display: flex; align-items: center; gap: 4px; margin-left: auto; cursor: pointer;
          padding: 4px 10px; border-radius: 999px; font-size: 0.8em; font-weight: 600;
          background: var(--secondary-background-color, #2a2a2a); color: var(--primary-text-color, #fff);
        }
        .battery-badge ha-icon { --mdc-icon-size: 16px; }
        .chip {
          display: flex; align-items: center; gap: 4px; white-space: nowrap;
          padding: 4px 10px; border-radius: 999px; border: none; cursor: pointer;
          font-size: 0.8em; background: var(--secondary-background-color, #2a2a2a);
          color: var(--primary-text-color, #fff);
        }
        .chip.active { background: var(--primary-color, #03a9f4); color: #fff; }
        .chip.chip-empty { opacity: 0.35; cursor: not-allowed; }
        .chip ha-icon { --mdc-icon-size: 16px; }
        .vod-view { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        .player-wrap { position: relative; flex: 1 1 auto; min-height: 140px; display: flex; }
        video {
          flex: 1 1 auto; min-height: 140px; width: 100%; background: #000; border-radius: 8px; display: block;
          object-fit: contain;
        }
        /* Deliberately NOT native <video controls>: those can only ever show
           the underlying element's own currentTime/duration, which resets to
           0 on every seek since each seek opens a brand new stream with its
           own internal clock (see _pathWithSeek/_commitSeek) - confirmed
           live as the actual root of "seeking looks broken", repeatedly
           reported and reproduced: the seek itself was landing correctly the
           whole time, but a counter honestly reading "0:00 of 0:18" right
           after a seek is indistinguishable, at a glance, from "seeking
           failed and restarted the clip". This bar always reflects absolute
           position in the ORIGINAL clip (this._seekBaseSeconds + currentTime
           over this._clipDurationMs - see _updateTimeDisplay), so it never
           appears to reset. Always visible (not hover-fade like native
           controls) since dashboards are frequently viewed on touch tablets
           with no hover state.
        */
        .player-controls {
          position: absolute; left: 0; right: 0; bottom: 0; z-index: 1;
          display: flex; align-items: center; gap: 8px; padding: 6px 10px;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
          border-radius: 0 0 8px 8px;
        }
        .player-controls button {
          border: none; background: transparent; color: #fff; cursor: pointer; flex: 0 0 auto;
          display: flex; align-items: center; justify-content: center; padding: 4px;
        }
        .player-controls ha-icon { --mdc-icon-size: 20px; }
        .seek-bar-track {
          position: relative; flex: 1 1 auto; height: 4px; border-radius: 2px; cursor: pointer;
          background: rgba(255, 255, 255, 0.3);
          /* Bigger hit target than the visual 4px track, without changing size. */
          padding: 8px 0; background-clip: content-box; box-sizing: content-box; margin: -8px 0;
          /* Without this, iOS/touch dragging horizontally on the bar fights
             the page's own vertical scroll gesture recognizer instead of
             just moving the thumb. */
          touch-action: none;
        }
        .seek-bar-fill {
          position: absolute; top: 8px; left: 0; bottom: 8px; border-radius: 2px;
          background: var(--primary-color, #03a9f4); pointer-events: none; width: 0%;
        }
        .seek-bar-thumb {
          position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%;
          background: var(--primary-color, #03a9f4); transform: translate(-50%, -50%); pointer-events: none; left: 0%;
        }
        .time-label { color: #fff; font-size: 0.78em; white-space: nowrap; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
        .clip-grid {
          flex: 0 0 auto; display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 6px; margin-top: 8px;
        }
        .clip-tile {
          position: relative; width: 80px; height: 80px; flex: 0 0 auto; border-radius: 8px; cursor: pointer; border: none;
          background: var(--secondary-background-color, #2a2a2a); color: var(--primary-text-color, #fff);
          display: flex; align-items: center; justify-content: center;
        }
        .clip-tile.selected { background: var(--primary-color, #03a9f4); color: #fff; }
        .clip-tile .clip-time { font-size: 1.1em; font-weight: 700; }
        .clip-tile .clip-icons { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; }
        .clip-tile .clip-icons ha-icon { --mdc-icon-size: 18px; opacity: 0.9; }
        .clip-tile .clip-icons .manual-icon { color: #e53935; opacity: 1; }
        .empty, .loading { padding: 12px; color: var(--secondary-text-color, #999); font-size: 0.9em; }
        .live-view { flex: 1 1 auto; min-height: 200px; display: flex; }
        .live-player {
          flex: 1 1 auto; width: 100%; height: 100%; background: #000; border-radius: 8px;
          object-fit: contain; display: block;
        }
        .live-mount { width: 100%; height: 100%; }
        .live-mount ha-camera-stream { width: 100%; height: 100%; display: block; border-radius: 8px; overflow: hidden; }
        .calendar-popup {
          position: absolute; top: 100%; left: 50%; transform: translateX(-50%); z-index: 10; margin-top: 4px;
          background: var(--card-background-color, #1c1c1c); border: 1px solid var(--divider-color, #444);
          border-radius: 8px; padding: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); width: 240px;
        }
        .cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 0.85em; font-weight: 600; }
        .cal-header button { border: none; background: transparent; color: inherit; cursor: pointer; padding: 2px 6px; }
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
        .cal-weekday { text-align: center; font-size: 0.7em; opacity: 0.6; padding: 2px 0; }
        .cal-day { text-align: center; font-size: 0.8em; padding: 4px 0; border-radius: 4px; border: none; background: transparent; color: inherit; }
        .cal-disabled { opacity: 0.25; }
        .cal-available { cursor: pointer; background: var(--secondary-background-color, #2a2a2a); }
        .cal-available.cal-muted { opacity: 0.4; }
        .cal-selected { background: var(--primary-color, #03a9f4) !important; color: #fff; }
      </style>
      <ha-card>
        <div class="topbar">
          <button class="pill today-btn">Today</button>
          <div class="day-stepper">
            <button class="day-prev" aria-label="Older day">&#8249;</button>
            <button class="day-label">Loading…</button>
            <button class="day-next" aria-label="Newer day">&#8250;</button>
            <div class="calendar-popup" hidden></div>
          </div>
          <button class="pill icon-pill move-btn" hidden title="Move camera" aria-label="Move camera">
            <ha-icon icon="mdi:arrow-all"></ha-icon>
          </button>
          <div class="ptz-preset-wrap" hidden>
            <button class="pill preset-btn">
              <ha-icon icon="mdi:map-marker-outline"></ha-icon><span class="preset-label"></span><ha-icon icon="mdi:chevron-down"></ha-icon>
            </button>
            <div class="ptz-preset-dropdown" hidden></div>
          </div>
          <div class="topbar-right">
            <button class="pill record-btn" hidden title="Record 5 minutes"><span class="record-dot"></span></button>
            <button class="pill quality-btn" hidden>LQ</button>
            <button class="pill live-btn" hidden>LIVE</button>
          </div>
        </div>
        <div class="filters">
          <div class="filter-chips"></div>
          <div class="battery-badge" hidden>
            <ha-icon></ha-icon>
            <span class="battery-text"></span>
          </div>
        </div>
        <div class="vod-view">
          <div class="player-wrap">
            <video class="player" playsinline></video>
            <div class="player-controls">
              <button class="play-pause-btn" aria-label="Play/pause"><ha-icon icon="mdi:play"></ha-icon></button>
              <div class="seek-bar-track">
                <div class="seek-bar-fill"></div>
                <div class="seek-bar-thumb"></div>
              </div>
              <span class="time-label">0:00 / 0:00</span>
              <button class="mute-btn" aria-label="Mute/unmute"><ha-icon icon="mdi:volume-high"></ha-icon></button>
              <button class="fullscreen-btn" aria-label="Fullscreen"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
            </div>
          </div>
          <div class="clip-grid"><div class="loading">Loading clips...</div></div>
        </div>
        <div class="live-view" hidden>
          <video class="live-player" controls playsinline muted></video>
          <div class="live-mount"></div>
        </div>
        <div class="ptz-controls" hidden>
          <div class="ptz-pad">
            <div class="pad-empty"></div>
            <button class="pad-up" aria-label="Pan up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
            <div class="pad-empty"></div>
            <button class="pad-left" aria-label="Pan left"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
            <button class="pad-default" aria-label="Return to overview position"><ha-icon icon="mdi:crosshairs"></ha-icon></button>
            <button class="pad-right" aria-label="Pan right"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            <div class="pad-empty"></div>
            <button class="pad-down" aria-label="Pan down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
            <div class="pad-empty"></div>
          </div>
          <div class="ptz-zoom" hidden>
            <button class="zoom-in" aria-label="Zoom in"><ha-icon icon="mdi:magnify-plus-outline"></ha-icon></button>
            <button class="zoom-out" aria-label="Zoom out"><ha-icon icon="mdi:magnify-minus-outline"></ha-icon></button>
          </div>
        </div>
      </ha-card>
    `;
    this._root = root;
    this._todayBtn = root.querySelector(".today-btn");
    this._dayPrevBtn = root.querySelector(".day-prev");
    this._dayNextBtn = root.querySelector(".day-next");
    this._dayLabel = root.querySelector(".day-label");
    this._calendarEl = root.querySelector(".calendar-popup");
    this._liveBtn = root.querySelector(".live-btn");
    this._qualityBtn = root.querySelector(".quality-btn");
    this._recordBtn = root.querySelector(".record-btn");
    this._filtersRow = root.querySelector(".filters");
    this._filtersEl = root.querySelector(".filter-chips");
    this._batteryBadge = root.querySelector(".battery-badge");
    this._batteryIcon = root.querySelector(".battery-badge ha-icon");
    this._batteryText = root.querySelector(".battery-text");
    this._vodView = root.querySelector(".vod-view");
    this._liveView = root.querySelector(".live-view");
    this._liveMount = root.querySelector(".live-mount");
    this._liveVideo = root.querySelector(".live-player");
    this._video = root.querySelector(".player");
    // this._canPlayReceived just feeds _commitSeek's _waitForCanPlayOrTimeout
    // coalescing check now - it used to also gate a native 'seeking'
    // listener against mpegts.js's own StartupStallJumper (see
    // _detectAndFixStuckPlayback in mpegts.js, which nudges currentTime by a
    // fraction of a second whenever a fresh player hasn't reached canplay
    // yet - confirmed live, logged as "Playback seems stuck at 0, seek to
    // 0.052"), but that whole class of bug went away with the native
    // <video controls> scrubber itself (see the custom seek bar setup
    // below) - nothing user-facing listens for 'seeking' anymore, so the
    // jumper's own internal recovery seeks now just pass through unnoticed,
    // which is exactly what should happen to them.
    this._video.addEventListener("canplay", () => {
      this._canPlayReceived = true;
    });
    this._video.addEventListener("timeupdate", () => this._updateTimeDisplay());
    this._video.addEventListener("play", () => this._updatePlayPauseBtn());
    this._video.addEventListener("pause", () => this._updatePlayPauseBtn());
    this._video.addEventListener("volumechange", () => this._updateMuteBtn());
    this._playerWrap = root.querySelector(".player-wrap");
    this._playPauseBtn = root.querySelector(".play-pause-btn");
    this._playPauseBtn.addEventListener("click", () => {
      if (this._video.paused) this._video.play().catch(() => {});
      else this._video.pause();
    });
    this._muteBtn = root.querySelector(".mute-btn");
    this._muteBtn.addEventListener("click", () => {
      this._video.muted = !this._video.muted;
    });
    this._fullscreenBtn = root.querySelector(".fullscreen-btn");
    this._fullscreenBtn.addEventListener("click", () => {
      // The wrapper, not just the video, so the control bar overlay stays
      // present (and functional) in fullscreen too - but iOS Safari (pre-
      // 16.4, still common) has no requestFullscreen() for arbitrary
      // elements at all, only the video-specific webkitEnterFullscreen(),
      // which loses this overlay in exchange for actually working there.
      const wrap = this._playerWrap;
      const requestFs = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (requestFs) {
        requestFs.call(wrap);
      } else if (this._video.webkitEnterFullscreen) {
        this._video.webkitEnterFullscreen();
      }
    });
    this._timeLabel = root.querySelector(".time-label");
    this._seekBarTrack = root.querySelector(".seek-bar-track");
    this._seekBarFill = root.querySelector(".seek-bar-fill");
    this._seekBarThumb = root.querySelector(".seek-bar-thumb");
    this._setupSeekBar();
    this._clipsEl = root.querySelector(".clip-grid");
    this._moveBtn = root.querySelector(".move-btn");
    this._presetWrap = root.querySelector(".ptz-preset-wrap");
    this._presetBtn = root.querySelector(".preset-btn");
    this._presetLabel = root.querySelector(".preset-label");
    this._presetDropdown = root.querySelector(".ptz-preset-dropdown");
    this._ptzControls = root.querySelector(".ptz-controls");
    this._ptzZoom = root.querySelector(".ptz-zoom");
    this._padUpBtn = root.querySelector(".pad-up");
    this._padDownBtn = root.querySelector(".pad-down");
    this._padLeftBtn = root.querySelector(".pad-left");
    this._padRightBtn = root.querySelector(".pad-right");
    this._padDefaultBtn = root.querySelector(".pad-default");
    this._zoomInBtn = root.querySelector(".zoom-in");
    this._zoomOutBtn = root.querySelector(".zoom-out");

    this._todayBtn.addEventListener("click", () => this._goToDay(0));
    this._dayPrevBtn.addEventListener("click", () => this._goToDay(this._dayIndex + 1));
    this._dayNextBtn.addEventListener("click", () => this._goToDay(this._dayIndex - 1));
    this._dayLabel.addEventListener("click", () => this._toggleCalendar());
    this._liveBtn.addEventListener("click", () => this._toggleLive());
    this._qualityBtn.addEventListener("click", () => this._toggleQuality());
    this._recordBtn.addEventListener("click", () => this._recordClip());
    this._batteryBadge.addEventListener("click", () => this._navigateToBatteryDashboard());
    this._moveBtn.addEventListener("click", () => this._togglePtzPad());
    this._presetBtn.addEventListener("click", () => {
      this._presetDropdown.hidden = !this._presetDropdown.hidden;
    });

    // PTZ direction buttons are continuous-move, not discrete-step (see
    // _ptzMove) - press-and-hold starts the pan, releasing anywhere (including
    // dragging off the button) must stop it, hence pointerup/leave/cancel all
    // bound the same way rather than just click.
    const bindPtzDirection = (btn, direction) => {
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._ptzMove(direction);
      });
      btn.addEventListener("pointerup", () => this._ptzStop());
      btn.addEventListener("pointerleave", () => this._ptzStop());
      btn.addEventListener("pointercancel", () => this._ptzStop());
    };
    bindPtzDirection(this._padUpBtn, "up");
    bindPtzDirection(this._padDownBtn, "down");
    bindPtzDirection(this._padLeftBtn, "left");
    bindPtzDirection(this._padRightBtn, "right");
    this._padDefaultBtn.addEventListener("click", () => this._ptzRecallDefault());
    this._zoomInBtn.addEventListener("click", () => this._ptzZoomStep(1));
    this._zoomOutBtn.addEventListener("click", () => this._ptzZoomStep(-1));

    // Close the calendar/preset popups on any click outside them (composedPath
    // since they're shadow-DOM elements - a plain event.target check would
    // miss clicks re-targeted to the host).
    this._onDocumentClick = (e) => {
      const path = e.composedPath();
      if (!this._calendarEl.hidden && !path.includes(this._calendarEl) && !path.includes(this._dayLabel)) {
        this._calendarEl.hidden = true;
      }
      if (!this._presetDropdown.hidden && !path.includes(this._presetDropdown) && !path.includes(this._presetBtn)) {
        this._presetDropdown.hidden = true;
      }
    };
    document.addEventListener("click", this._onDocumentClick);
  }

  async _browse(media_content_id) {
    return this._hass.callWS({
      type: "media_source/browse_media",
      media_content_id,
    });
  }

  async _loadDays() {
    try {
      const days = await this._fetchSortedDays(this._mediaSourceIdForQuality(this._quality));
      this._days = days;
      if (days.length === 0) {
        this._applyEmptyDaysUi();
        return;
      }
      await this._goToDay(0);
    } catch (err) {
      this._dayLabel.textContent = "Error";
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to browse days", err);
    }
  }

  // Renders the day label/chevron-disabled state and loads that day's clips.
  // `index` is a position into `this._days` (0 = newest).
  _dayDate(day) {
    const parts = day.media_content_id.split("|");
    return new Date(Number(parts[4]), Number(parts[5]) - 1, Number(parts[6]));
  }

  async _goToDay(index) {
    if (!this._days || index < 0 || index >= this._days.length) return;
    this._dayIndex = index;
    this._calendarEl.hidden = true;
    this._calendarMonth = null;
    const day = this._days[index];

    const date = this._dayDate(day);
    this._currentDayDate = date;
    this._dayLabel.textContent = date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "long",
      day: "numeric",
    });

    this._todayBtn.disabled = index === 0;
    this._dayNextBtn.disabled = index === 0;
    this._dayPrevBtn.disabled = index === this._days.length - 1;

    await this._loadClips(day);
  }

  // Trailing `|duration_ms|triggers` fields on the FILE identifier - see
  // media_source.py. Falls back to empty/unknown for any identifier shape
  // that doesn't match, rather than throwing.
  _clipMeta(clip) {
    const parts = clip.media_content_id.split("|");
    const triggerTail = parts[parts.length - 1];
    const durationMs = Number(parts[parts.length - 2]);
    return {
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
      triggers:
        !triggerTail || triggerTail === "NONE"
          ? []
          : triggerTail.split(",").filter((t) => t && t !== "NONE"),
    };
  }

  _renderFilters() {
    const present = new Set();
    for (const clip of this._clips) {
      for (const trigger of this._clipMeta(clip).triggers) present.add(trigger);
    }

    this._activeFilter = null;

    const longTail = [
      ...TRIGGER_PRIORITY.filter((t) => present.has(t)),
      ...[...present]
        .filter((t) => !CORE_TRIGGERS.includes(t) && !TRIGGER_PRIORITY.includes(t))
        .sort(),
    ];

    const chips = [
      { name: null, label: "All", icon: null, empty: false },
      ...CORE_TRIGGERS.map((name) => ({
        name,
        label: triggerLabel(name),
        icon: triggerIcon(name),
        empty: !present.has(name),
      })),
      ...longTail.map((name) => ({
        name,
        label: triggerLabel(name),
        icon: triggerIcon(name),
        empty: false,
      })),
    ];

    this._filtersEl.innerHTML = chips
      .map(
        (c) => `
          <button class="chip${c.name === this._activeFilter ? " active" : ""}${c.empty ? " chip-empty" : ""}"
                  data-filter="${c.name ?? ""}" ${c.empty ? "disabled" : ""}>
            ${c.icon ? `<ha-icon icon="${c.icon}"></ha-icon>` : ""}${c.label}
          </button>`
      )
      .join("");

    this._filtersEl.querySelectorAll(".chip:not(.chip-empty)").forEach((el) => {
      el.addEventListener("click", () => {
        this._activeFilter = el.dataset.filter || null;
        this._filtersEl
          .querySelectorAll(".chip")
          .forEach((c) => c.classList.toggle("active", (c.dataset.filter || null) === this._activeFilter));
        this._renderClipGrid();
      });
    });
  }

  // Renders the (possibly filtered) clip grid as a single unpaginated,
  // horizontally-scrolling row - oldest to newest, left to right - over
  // `this._clips`, which is already fully loaded for the selected day in one
  // browse call. Scrolls all the way right afterwards so the newest (and, on
  // initial load, auto-selected) clip is the one in view.
  _renderClipGrid() {
    const filtered = this._clips
      .map((clip, index) => ({ clip, index }))
      .filter(({ clip }) => !this._activeFilter || this._clipMeta(clip).triggers.includes(this._activeFilter));

    if (filtered.length === 0) {
      this._clipsEl.innerHTML = '<div class="empty">No clips match this filter.</div>';
      return;
    }

    this._clipsEl.innerHTML = filtered
      .map(({ clip, index }) => {
        const { triggers, durationMs } = this._clipMeta(clip);
        const manual = this._clipIsManual(clip, durationMs);
        // MOTION is redundant noise once a more specific trigger is also
        // present on the same clip - only show it when it's the sole trigger.
        const displayTriggers = triggers.length > 1 ? triggers.filter((t) => t !== "MOTION") : triggers;
        // One fewer trigger icon when the manual-record dot is also shown, so
        // a clip with 3 AI triggers plus a manual recording doesn't overflow
        // the tile's small icon row.
        const icons = displayTriggers
          .slice(0, manual ? 2 : 3)
          .map((t) => `<ha-icon icon="${triggerIcon(t)}"></ha-icon>`)
          .join("");
        const manualIcon = manual
          ? '<ha-icon icon="mdi:record-circle" class="manual-icon" title="Manually recorded"></ha-icon>'
          : "";
        const time = (clip.title.match(/^\d{1,2}:\d{2}/) || [""])[0];
        return `
          <button class="clip-tile${index === this._selectedIndex ? " selected" : ""}" data-index="${index}">
            <div class="clip-icons">${manualIcon}${icons}</div>
            <div class="clip-time">${time}</div>
          </button>`;
      })
      .join("");

    this._clipsEl.querySelectorAll(".clip-tile").forEach((el) => {
      el.addEventListener("click", () => this._selectClip(Number(el.dataset.index)));
    });

    this._clipsEl.scrollLeft = this._clipsEl.scrollWidth;
  }

  _highlightSelectedTile() {
    this._clipsEl.querySelectorAll(".clip-tile").forEach((el) => {
      el.classList.toggle("selected", Number(el.dataset.index) === this._selectedIndex);
    });
  }

  // The Reolink Home Hub's own VOD metadata has no "manual recording" trigger
  // flag (reolink_aio's VOD_trigger enum only covers motion/AI/timer events -
  // confirmed against its source), so there's nothing server-side to tag a
  // clip with. Instead, recorded here client-side from the one thing that
  // *does* know when a manual recording ran: switch.<location>_manual_record's
  // own on/off history, already sitting in the recorder database for free.
  async _loadManualIntervals() {
    const entityId = this._config.record_switch_entity;
    if (!entityId || !this._currentDayDate) {
      this._manualIntervals = [];
      return;
    }
    const dayStart = new Date(this._currentDayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(this._currentDayDate);
    dayEnd.setHours(23, 59, 59, 999);
    try {
      const [history] = await this._hass.callApi(
        "GET",
        `history/period/${dayStart.toISOString()}?filter_entity_id=${entityId}` +
          `&end_time=${encodeURIComponent(dayEnd.toISOString())}&minimal_response`
      );
      const intervals = [];
      let onSince = null;
      for (const entry of history || []) {
        if (entry.state === "on") {
          if (onSince == null) onSince = new Date(entry.last_changed);
        } else if (onSince != null) {
          intervals.push([onSince, new Date(entry.last_changed)]);
          onSince = null;
        }
      }
      if (onSince != null) intervals.push([onSince, dayEnd]);
      this._manualIntervals = intervals;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to fetch manual-record history", err);
      this._manualIntervals = [];
    }
  }

  // Clip start comes from the HH:MM:SS leading its title (see file_name in
  // media_source.py) combined with the day already established by
  // _goToDay - clip end is that plus its known duration.
  _clipIsManual(clip, durationMs) {
    if (!this._manualIntervals?.length || !this._currentDayDate) return false;
    const match = clip.title.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) return false;
    const [, hh, mm, ss] = match;
    const start = new Date(this._currentDayDate);
    start.setHours(Number(hh), Number(mm), Number(ss), 0);
    const end = new Date(start.getTime() + (durationMs || 0));
    return this._manualIntervals.some(([onAt, offAt]) => start < offAt && end > onAt);
  }

  async _loadClips(day) {
    this._clipsEl.innerHTML = '<div class="loading">Loading clips...</div>';
    try {
      const [result] = await Promise.all([this._browse(day.media_content_id), this._loadManualIntervals()]);
      // FILE identifiers already sort chronologically by title (HH:mm:ss ...),
      // oldest first - kept as-is so the clip strip renders oldest to newest,
      // left to right, with the newest clip last.
      const clips = (result.children || []).slice();
      this._clips = clips;
      this._renderFilters();
      if (clips.length === 0) {
        this._clipsEl.innerHTML = '<div class="empty">No clips on this day.</div>';
        return;
      }
      this._renderClipGrid();
      const newestIndex = clips.length - 1;
      // HA's card `visibility:` condition only toggles display:none - it doesn't
      // unmount hidden cards. Without this guard, a hidden Clear/Fluent sibling
      // card would still autoplay here, and both would fetch the same channel's
      // Playback stream from the Home Hub concurrently, which is what was
      // producing the intermittent IO errors on load.
      if (this.offsetParent !== null) {
        this._selectClip(newestIndex);
      } else {
        this._selectedIndex = newestIndex;
        this._highlightSelectedTile();
      }
    } catch (err) {
      this._clipsEl.innerHTML = '<div class="empty">Error loading clips.</div>';
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to browse clips", err);
    }
  }

  async _selectClip(index, { isRetry = false } = {}) {
    const clip = this._clips[index];
    if (!clip) return;
    this._selectedIndex = index;
    // Tracks whether the current clip has already had its one automatic retry
    // (see the ERROR handler in _playFlv) - reset on every fresh selection,
    // but not when this call *is* that retry, or it would retry forever.
    // _failedClipIndex (see _syncVisibility) resets the same way: a fresh,
    // deliberate selection - manual click or a newly-visible card - always
    // deserves its own two attempts, even if this exact clip gave up before.
    if (!isRetry) {
      this._retriedClip = false;
      this._failedClipIndex = null;
    }
    this._highlightSelectedTile();

    // Same generation-counter guard as _playLiveFlv/_liveGen, and for the same
    // reason: resolve_media is a network round-trip, and without this a stale
    // response landing after the card's been hidden (rapid camera switching -
    // see _syncVisibility) would attach/load/play a player against a
    // display:none <video>, which some browsers leave permanently stuck even
    // once the card is visible again (only a full page reload recovers).
    // _destroyPlayer() bumps the counter, so any teardown - this one or a
    // concurrent _syncVisibility hide - invalidates this call's in-flight await.
    this._destroyPlayer();
    const gen = (this._playGen = (this._playGen || 0) + 1);
    // _syncVisibility's level-triggered play check (see there) would otherwise
    // fire its own redundant _selectClip on every intervening hass update
    // while this one's resolve_media round-trip is still in flight - each
    // would tear down and restart the previous, wasting round-trips and, in
    // the worst case, never letting one finish before the next supersedes it.
    this._selecting = true;

    let resolved;
    try {
      resolved = await this._hass.callWS({
        type: "media_source/resolve_media",
        media_content_id: clip.media_content_id,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to resolve clip", err);
      return;
    } finally {
      this._selecting = false;
    }
    if (gen !== this._playGen) return; // superseded while awaiting - drop it
    const { durationMs } = this._clipMeta(clip);
    this._playFlv(this._rewriteToCrossOrigin(resolved.url), durationMs, 0);
  }

  // Some deployments hit a Home Assistant frontend Service Worker bug where it
  // intermittently intercepts and corrupts same-origin fetches to this large
  // chunked-transfer endpoint ("A ServiceWorker intercepted the request and
  // encountered an unexpected error") - seen on Safari and Firefox/Gecko.
  // Service Workers are strictly origin-scoped, so routing through a second
  // origin pointed at the same backend (CORS-enabled - see views.py) avoids it
  // entirely. The signed authSig query param validates the path only, so it's
  // still valid against a different host. This is opt-in via the
  // `cross_origin_host` config field, since not every deployment hits the bug
  // and setting up a second origin/certificate is extra work most people
  // won't need; with it unset, this is a no-op.
  _rewriteToCrossOrigin(url) {
    const crossOriginHost = this._config.cross_origin_host;
    if (!crossOriginHost) return url;
    try {
      const rewritten = new URL(url, window.location.origin);
      rewritten.protocol = "https:";
      rewritten.host = crossOriginHost;
      return rewritten.toString();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to rewrite URL to cross-origin host", err);
      return url;
    }
  }

  // Only the currently-visible card (Clear or Fluent) should hold a live player.
  // A hidden card left playing wastes a concurrent Playback slot on the Home Hub
  // and was a source of IO errors (see note in _loadClips). Runs on every hass
  // update, which fires often enough to catch the input_select toggle promptly.
  //
  // The "should we be playing" check below is deliberately level-triggered
  // (evaluated on every call, guarded by !this._player/!this._selecting so
  // it's a no-op once satisfied) rather than gated behind the visible !==
  // this._wasVisible edge below. offsetParent is layout-dependent - on
  // initial page load a just-attached element can read null for a tick
  // before the browser's first layout pass, unrelated to actual visibility.
  // _loadClips's own offsetParent check (see there) can lose that race and
  // skip its initial _selectClip call; if _wasVisible had already latched
  // true from an earlier, premature reading (taken before clips were even
  // loaded), the old edge-only check here would never see a fresh
  // false->true transition to retry on, leaving the card stuck: tile
  // highlighted, nothing ever playing, until the next manual clip switch
  // recovers it via a fresh, ungated _selectClip call from the click
  // handler. Re-checking unconditionally self-heals regardless of how many
  // spurious flickers happened before clips were ready.
  //
  // That same unconditional re-check turns into a runaway loop once a clip
  // has genuinely exhausted its one auto-retry (see the ERROR handler in
  // _playFlv): _destroyPlayer() there leaves this._player null, so the very
  // next hass update (these fire near-continuously) sees !this._player and
  // calls _selectClip again - a full fresh resolve_media + fetch cycle, not
  // a no-op - which fails again, destroys again, and repeats forever. Each
  // cycle opens another concurrent Playback connection to the Home Hub
  // before the last one has even been cleaned up, which was enough on its
  // own (confirmed live - one Chrome tab, nothing else streaming) to keep
  // exhausting the Home Hub's few concurrent-Playback slots indefinitely,
  // surfacing as sustained 503s that mpegts.js reports as opaque "Failed to
  // fetch" errors. this._failedClipIndex parks the level-triggered check
  // once a clip has given up, without touching the single-retry logic
  // itself - cleared below on a manual reselect (_selectClip) or on the
  // card becoming visible again, so the user (or a fresh view) still gets
  // another shot.
  _syncVisibility() {
    const visible = this.offsetParent !== null;

    if (visible !== this._wasVisible) {
      this._wasVisible = visible;
      if (visible) {
        this._failedClipIndex = null;
      } else {
        this._destroyPlayer();
        // A hidden live view is just as wasteful as a hidden VOD player (see
        // above) - tear it down and fall back to the recordings view rather
        // than leaving a live stream running off-screen.
        if (this._liveActive) this._toggleLive();
        if (this._calendarEl) this._calendarEl.hidden = true;
      }
    }

    if (
      visible &&
      !this._player &&
      !this._selecting &&
      this._clips &&
      this._selectedIndex != null &&
      this._selectedIndex !== this._failedClipIndex
    ) {
      this._selectClip(this._selectedIndex);
    }
  }

  // Home Hub cmd=Playback seeking is a `seek=<seconds-into-clip>` param, not
  // HTTP Range - confirmed via a HAR capture of the Home Hub's own web client
  // scrubbing an open recording, which re-issues cmd=Playback with the same
  // source/start but a different `seek=` each time (see views.py, which
  // forwards this straight through to the Home Hub). mpegts.js's built-in
  // seek machinery (Range headers, or byte-offset query params via seekType:
  // "param") doesn't apply here since the Home Hub seeks by time, not bytes -
  // _seekToAbsolute below (wired up from the custom seek bar in
  // _setupSeekBar, not native <video> scrubbing - see the CSS comment on
  // .player-controls for why) drives this directly instead.
  //
  // seek lives in the URL PATH (views.py's .../{stream_res}/{seek}/{filename}),
  // not a query param appended after the fact - HA's signed-path auth
  // (authSig) only ever authorizes the exact query params present when a URL
  // was signed, and media_source/resolve_media (and auth/sign_path - see
  // _commitSeek) both sign the bare path only, silently discarding any query
  // string given to them. A query-param seek therefore always fails
  // signature verification - confirmed live via HA's own auth logs, which
  // flagged every single VOD request as invalid on every browser, and again
  // when re-signing a `?seek=` query string didn't help (auth/sign_path
  // dropped it just the same). A path segment, in contrast, is covered by
  // the signature by construction, so this splices it directly into
  // this._baseStreamUrl's path instead.
  _pathWithSeek(seekSeconds) {
    // Fixed prefix before the seek segment: "", api, reolink_hub_playback_bridge,
    // stream, config_entry_id, channel, stream_res - see the url pattern in
    // views.py. filename (right after seek) is a `.+` wildcard that can
    // itself contain slashes (Reolink's own absolute Unix paths), so only
    // this fixed-count prefix is safe to index into.
    const SEEK_SEGMENT_INDEX = 7;
    const pathname = new URL(this._baseStreamUrl, window.location.origin).pathname;
    const segments = pathname.split("/");
    segments[SEEK_SEGMENT_INDEX] = String(Math.max(0, Math.floor(seekSeconds)));
    return segments.join("/");
  }

  // Entry point for a real seek - called from _setupSeekBar's pointerup
  // handler (a click, or the end of a drag) with an ABSOLUTE position in
  // seconds from the start of the ORIGINAL clip. Never fires from native
  // <video> 'seeking' events (there's no native scrubber to fire them -
  // see the CSS comment on .player-controls), so unlike the old
  // event-driven version there's nothing here to confuse with mpegts.js's
  // own StartupStallJumper recovery seeks.
  _seekToAbsolute(targetSeconds) {
    if (this._clipDurationMs == null) return;
    // Always remember the latest requested position; if a reload is
    // already in flight, don't start a second overlapping one -
    // _commitSeek's loop below picks up whatever this ends up holding once
    // it's free.
    this._latestSeekTarget = targetSeconds;
    this._commitSeek();
  }

  // The Home Hub can't seek within an already-open FLV stream, so each real
  // seek tears down the current player and opens a fresh cmd=Playback request
  // starting at the target second, same as the Home Hub's own web client
  // does (see _pathWithSeek above). That fresh stream starts its own
  // timeline at 0 - this._seekBaseSeconds tracks the true absolute offset so
  // _updateTimeDisplay can keep showing genuine clip position instead of a
  // counter that resets to 0:00 on every seek (confirmed live: with the old
  // native-scrubber counter, a seek that landed exactly right was
  // indistinguishable at a glance from one that had silently failed and
  // restarted the clip - the seek logic was never the bug, the display was).
  //
  // A full reload (auth/sign_path round-trip + a brand new Home Hub
  // connection + MSE init) reliably takes longer than a quick click - the
  // loop below processes one target at a time and, after each _playFlv
  // call, actually waits for it to reach canplay (or a timeout) before
  // checking whether this._latestSeekTarget moved on to something newer
  // while it was busy (e.g. two quick clicks in a row) - so it always
  // converges on the last thing the user actually asked for, instead of
  // piling up overlapping reloads that each cancel the last before it gets
  // anywhere.
  async _commitSeek() {
    if (this._clipDurationMs == null || this._seekCommitInFlight) return;
    this._seekCommitInFlight = true;
    try {
      while (this._latestSeekTarget != null) {
        // The card can go hidden mid-loop (_syncVisibility calls
        // _destroyPlayer directly when that happens) - without this, a
        // still-queued target would make this loop rebuild a player nobody
        // can see, wasting a concurrent Playback slot exactly like a
        // visible-but-abandoned live view does (see _syncVisibility).
        if (this.offsetParent === null) break;
        const requestedTime = this._latestSeekTarget;
        this._latestSeekTarget = null;

        const maxSeconds = Math.floor(this._clipDurationMs / 1000);
        const clamped = Math.max(0, Math.min(Math.floor(requestedTime), maxSeconds));
        this._destroyPlayer();
        const gen = (this._playGen = (this._playGen || 0) + 1);

        // this._baseStreamUrl already has a /0/ seek segment (see
        // media_source.py) and a signature to match, so seeking back to
        // the start needs no re-signing at all - only a real seek does.
        let url = this._baseStreamUrl;
        if (clamped > 0) {
          try {
            const { path: signedPath } = await this._hass.callWS({
              type: "auth/sign_path",
              path: this._pathWithSeek(clamped),
              expires: 60,
            });
            url = this._rewriteToCrossOrigin(signedPath);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("reolink-hub-playback-bridge-card: failed to sign seek path", err);
            continue; // a newer target may have queued up meanwhile - try it
          }
          // _destroyPlayer() above (or a concurrent one, e.g. the card
          // being hidden mid-seek) may have superseded this call while the
          // sign_path round-trip was in flight - same staleness guard as
          // _selectClip.
          if (gen !== this._playGen) continue;
        }
        this._playFlv(url, this._clipDurationMs, clamped);
        await this._waitForCanPlayOrTimeout(gen, 5000);
      }
    } finally {
      this._seekCommitInFlight = false;
    }
  }

  // Simple poll rather than a canplay listener with its own cleanup/timeout
  // bookkeeping - resolves as soon as this attempt's player reaches canplay,
  // gets superseded by a newer generation (see _destroyPlayer/_playGen), or
  // the timeout elapses, whichever comes first.
  async _waitForCanPlayOrTimeout(gen, timeoutMs) {
    const start = performance.now();
    while (!this._canPlayReceived && gen === this._playGen && performance.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Wires up the custom seek bar (see the CSS comment on .player-controls
  // for why this exists instead of native <video controls>). Pointer events
  // (not mouse-only) so this works the same on touch dashboards. A click
  // and a drag are the same gesture here - pointerdown already renders the
  // bar at that position, pointermove (if the pointer keeps moving) just
  // keeps redrawing it, and only pointerup actually commits a reload via
  // _seekToAbsolute, so a drag never triggers more than one reload no
  // matter how long it lasts.
  _setupSeekBar() {
    let dragging = false;
    const secondsAt = (clientX) => {
      const rect = this._seekBarTrack.getBoundingClientRect();
      const frac = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
      const maxSeconds = this._clipDurationMs != null ? this._clipDurationMs / 1000 : 0;
      return frac * maxSeconds;
    };
    this._seekBarTrack.addEventListener("pointerdown", (e) => {
      if (this._clipDurationMs == null) return;
      dragging = true;
      this._seekDragging = true;
      this._renderSeekBar(secondsAt(e.clientX));
      e.preventDefault();
    });
    const onMove = (e) => {
      if (!dragging) return;
      this._renderSeekBar(secondsAt(e.clientX));
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      this._seekDragging = false;
      this._seekToAbsolute(secondsAt(e.clientX));
    };
    // On window, not the track - a drag started on the (narrow) track
    // routinely moves the pointer off it before releasing.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    this._teardownSeekBar = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }

  // Draws the bar/thumb/label from an ABSOLUTE seconds-into-the-original-
  // clip value - shared by live dragging (_setupSeekBar) and normal
  // playback (_updateTimeDisplay, below), so both always agree with each
  // other and with what _commitSeek will actually request.
  _renderSeekBar(absSeconds) {
    const maxSeconds = this._clipDurationMs != null ? this._clipDurationMs / 1000 : 0;
    const clamped = Math.max(0, Math.min(absSeconds, maxSeconds));
    const pct = maxSeconds > 0 ? (clamped / maxSeconds) * 100 : 0;
    this._seekBarFill.style.width = `${pct}%`;
    this._seekBarThumb.style.left = `${pct}%`;
    this._timeLabel.textContent = `${this._formatTime(clamped)} / ${this._formatTime(maxSeconds)}`;
  }

  // 'timeupdate' listener (see _build) - this._seekBaseSeconds + currentTime
  // is genuine absolute position regardless of how many seeks got here
  // (each fresh stream's own currentTime restarts at 0 - see _commitSeek).
  // Skipped while the user has a drag in progress (_setupSeekBar owns the
  // display then) so playback of the OLD position doesn't fight the drag
  // preview of where they're currently pointing.
  _updateTimeDisplay() {
    if (this._seekDragging || this._clipDurationMs == null) return;
    this._renderSeekBar((this._seekBaseSeconds || 0) + this._video.currentTime);
  }

  _formatTime(totalSeconds) {
    const whole = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  _updatePlayPauseBtn() {
    this._playPauseBtn
      .querySelector("ha-icon")
      .setAttribute("icon", this._video.paused ? "mdi:play" : "mdi:pause");
  }

  _updateMuteBtn() {
    this._muteBtn
      .querySelector("ha-icon")
      .setAttribute("icon", this._video.muted ? "mdi:volume-off" : "mdi:volume-high");
  }

  // Called from _selectClip (after its own gen check passes, having already
  // torn down any previous player - see _destroyPlayer there) and from
  // _commitSeek (which tears down the previous player itself first).
  _playFlv(url, durationMs, seekSeconds = 0) {
    if (typeof window.mpegts === "undefined") {
      // eslint-disable-next-line no-console
      console.error(
        "reolink-hub-playback-bridge-card: mpegts.js not loaded - add it as a dashboard resource before this card"
      );
      return;
    }
    if (!window.mpegts.isSupported()) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: mpegts.js reports this browser is unsupported");
      return;
    }

    // url and the clip's total duration are stashed so a later _commitSeek
    // can rebuild the request (see _pathWithSeek) without a fresh
    // media_source/resolve_media round-trip.
    this._baseStreamUrl = url;
    this._clipDurationMs = durationMs;
    this._seekBaseSeconds = seekSeconds;
    // Each fresh player gets its own pre-canplay window - see
    // _waitForCanPlayOrTimeout, which this feeds.
    this._canPlayReceived = false;
    // Reflects the new absolute position immediately rather than waiting
    // for the first 'timeupdate' (which can lag a moment behind a fresh
    // player), so the bar/label update in lockstep with the request that
    // was just made instead of visibly catching up after the fact.
    this._renderSeekBar(seekSeconds);

    const remainingMs =
      durationMs != null ? Math.max(durationMs - seekSeconds * 1000, 0) : undefined;

    const player = window.mpegts.createPlayer(
      // The Home Hub's FLV metadata doesn't reliably carry a duration, which
      // otherwise leaves video.duration as Infinity - reolink_hub_playback_bridge
      // already knows the clip length from the Reolink API, so pass it
      // through explicitly. After a seek this is the *remaining* duration
      // (see _commitSeek doc above), not the full clip; _renderSeekBar
      // above is what actually shows absolute position to the user now.
      // url already carries the correct seek segment and a matching
      // signature (see _pathWithSeek/_commitSeek) - nothing to append here.
      { type: "flv", url, isLive: false, duration: remainingMs || undefined },
      { enableStashBuffer: false }
    );
    // mpegts.js's EventEmitter throws "Unhandled error" if an 'error' event fires
    // with no listener attached - this was the actual crash in the console, not
    // a symptom of the underlying IO/MSE issue itself. Listening here turns a
    // hard crash into a normal, recoverable teardown.
    player.on(window.mpegts.Events.ERROR, (type, detail, info) => {
      // A stale player's fetch loader can throw asynchronously after it's already
      // been torn down and replaced (e.g. switching clips quickly) - if `player`
      // here isn't the currently-active one, this is just that expected abort
      // noise, not a real failure, so ignore it rather than tearing down (and
      // logging an error about) whatever is actually playing now.
      if (this._player !== player) return;
      // The Playback CGI proxy (views.py) serves the clip as an unbounded
      // chunked-transfer stream with no Content-Length, so there's no explicit
      // "clip ended cleanly" signal - mpegts.js's fetch loader can't tell a
      // deliberate connection close at the natural end of a clip apart from a
      // genuine mid-stream drop, and reports both identically as an IO error.
      // If playback has already reached (or is within a second of) the clip's
      // end, treat this as a normal completion instead of logging a false error.
      const nearEnd =
        Number.isFinite(this._video.duration) &&
        this._video.currentTime >= this._video.duration - 1;
      if (nearEnd) {
        this._destroyPlayer();
        return;
      }
      // A NetworkError this early is usually transient (e.g. the Home Hub
      // briefly over its concurrent-Playback-slot limit right as a dashboard
      // view switch tears down one card's stream and starts another's - see
      // the note on _syncVisibility above) rather than a real failure, so
      // it's worth one automatic retry before surfacing it as an error.
      if (!this._retriedClip && type === "NetworkError") {
        this._retriedClip = true;
        this._destroyPlayer();
        // Retry the exact same request (same url, same seekSeconds) that
        // just failed - NOT _selectClip, which always resolves media fresh
        // and plays from seek=0. A transient 503 while mid-seek (confirmed
        // live: the Home Hub can reject a fresh Playback connection before
        // the previous one has finished closing) used to retry through
        // _selectClip and silently land back at the clip's start instead of
        // the seek target, which looked indistinguishable from "seeking
        // doesn't work" - it was quietly discarding the seek, not failing it.
        const gen = this._playGen;
        setTimeout(() => {
          if (gen !== this._playGen) return;
          this._playFlv(url, durationMs, seekSeconds);
        }, 750);
        return;
      }
      // Give up on this clip - park it (see _syncVisibility) so the
      // level-triggered visibility check doesn't immediately start a fresh
      // resolve_media + fetch cycle on the very next hass update and spin
      // forever without ever giving the Home Hub a chance to recover.
      this._failedClipIndex = this._selectedIndex;
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: playback error", type, detail, info);
      this._destroyPlayer();
    });
    player.attachMediaElement(this._video);
    player.load();
    this._player = player;
    player.play().catch(() => {
      /* autoplay may be blocked - user can press play manually */
    });
  }

  _destroyPlayer() {
    this._playGen = (this._playGen || 0) + 1;
    // Otherwise a debounced seek (see _handleSeek) still pending when the
    // player is torn down for an unrelated reason (clip switched away from
    // entirely, card hidden) would fire _commitSeek 400ms later against
    // whatever clip/player happens to be current by then.
    clearTimeout(this._seekDebounce);
    if (this._player) {
      try {
        this._player.pause();
        this._player.unload();
        this._player.detachMediaElement();
        this._player.destroy();
      } catch (err) {
        /* ignore teardown errors */
      }
      this._player = null;
    }
  }

  // Pulls {entryId, channel} out of the configured RES|entry|channel|stream
  // media_source_id (see media_source.py) rather than adding separate config
  // fields - the live proxy URL needs the same two IDs the VOD browse tree
  // already resolves through this identifier. The trailing stream segment
  // itself is ignored here - default quality comes from hq_available/
  // hq_default (see setConfig), not from whatever suffix happens to be baked
  // into media_source_id.
  _entryAndChannel() {
    const match = this._config.media_source_id.match(
      /^media-source:\/\/reolink_hub_playback_bridge\/RES\|([^|]+)\|([^|]+)\|([^|]+)$/
    );
    return match ? { entryId: match[1], channel: match[2] } : null;
  }

  // The RES|entry|channel|{quality} browse root for the currently selected
  // quality - VOD's day/clip tree is rooted per-resolution (see
  // media_source.py), so switching quality means re-browsing from here rather
  // than just changing a param on an already-loaded tree.
  _mediaSourceIdForQuality(quality) {
    const ec = this._entryAndChannel();
    return ec ? `media-source://reolink_hub_playback_bridge/RES|${ec.entryId}|${ec.channel}|${quality}` : this._config.media_source_id;
  }

  // Unlike VOD clips (whose resolved.url already comes signed for free from
  // media_source/resolve_media - see _rewriteToCrossOrigin above), this URL
  // is hand-built and carries no auth of its own. When cross_origin_host is
  // configured, this request is routed through that second origin (Service
  // Worker workaround), so the browser won't send the primary origin's auth
  // cookie - without a signed path token the request is unauthenticated,
  // which surfaced as a CORS-flavored 401 (the auth-failure response has no
  // Access-Control-Allow-Origin header, since that's only added by this
  // view's own handler on a successful response).
  async _signedLiveFlvUrl(streamRes) {
    const ec = this._entryAndChannel();
    if (!ec) return null;
    const path = `/api/reolink_hub_playback_bridge/live/${ec.entryId}/${ec.channel}/${streamRes}`;
    const { path: signedPath } = await this._hass.callWS({
      type: "auth/sign_path",
      path,
      expires: 60,
    });
    return this._rewriteToCrossOrigin(signedPath);
  }

  async _playLiveFlv(streamRes) {
    this._destroyLivePlayer();
    // Generation counter guards against a race if _playLiveFlv is called
    // again (quality toggle, live toggled off and back on) while the
    // sign_path round-trip below is still in flight - _destroyLivePlayer
    // bumps this too, so any now-stale call bails instead of creating a
    // second concurrent player.
    const gen = (this._liveGen = (this._liveGen || 0) + 1);
    let url;
    try {
      url = await this._signedLiveFlvUrl(streamRes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to sign live stream path", err);
      return;
    }
    if (!url || gen !== this._liveGen) return;

    const player = window.mpegts.createPlayer({ type: "flv", url, isLive: true }, { enableStashBuffer: false });
    // Same rationale as the VOD ERROR listener above - required so a torn-down
    // stale player's async error doesn't throw as an unhandled crash. Live
    // streams have no natural end, so (unlike VOD) every ERROR here is a real
    // failure - most commonly the "main" stream being HEVC on a browser whose
    // MediaSource doesn't accept hvc1/hev1 (see hevcMseSupported above).
    player.on(window.mpegts.Events.ERROR, (type, detail, info) => {
      if (this._livePlayer !== player) return;
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: live playback error", type, detail, info);
      this._destroyLivePlayer();
    });
    player.attachMediaElement(this._liveVideo);
    player.load();
    this._livePlayer = player;
    player.play().catch(() => {
      /* autoplay may be blocked - user can press play manually */
    });
  }

  _destroyLivePlayer() {
    this._liveGen = (this._liveGen || 0) + 1;
    if (this._livePlayer) {
      try {
        this._livePlayer.pause();
        this._livePlayer.unload();
        this._livePlayer.detachMediaElement();
        this._livePlayer.destroy();
      } catch (err) {
        /* ignore teardown errors */
      }
      this._livePlayer = null;
    }
  }

  // Static "HQ" text with an .active highlight instead of a text swap -
  // matches the LIVE pill's on/off pattern (same .pill.active class) rather
  // than reading as a quality *label* that happens to change.
  _updateQualityBtn() {
    const hq = this._quality === "main";
    this._qualityBtn.textContent = "HQ";
    this._qualityBtn.classList.toggle("active", hq);
    this._qualityBtn.title = hq
      ? "High quality (Clear/4K) - tap for standard quality"
      : "Standard quality (Fluent) - tap for high quality";
  }

  // Record button only makes sense while actually looking at the live feed -
  // there's no live camera to record from underneath the recordings/VOD
  // view. Called from setConfig and every live-view toggle.
  _updateRecordBtnVisibility() {
    this._recordBtn.hidden = !(this._liveActive && this._config.record_switch_entity);
  }

  // Reflects switch.<location>_manual_record's actual state rather than
  // tracking a local "is recording" flag, so the button stays correct
  // regardless of which client started the recording (or if the companion
  // timer.finished automation - reolink_manual_record_expired in
  // security.yaml - already turned it back off). Deliberately never
  // disabled (unlike most other pills here) - clicking again while
  // recording is the stop action, handled by _recordClip below.
  _updateRecordBtn() {
    const entityId = this._config.record_switch_entity;
    const state = this._hass.states[entityId];
    const recording = state ? state.state === "on" : false;
    this._recordBtn.classList.toggle("recording", recording);
    this._recordBtn.title = recording ? "Recording - tap to stop" : "Record 5 minutes";
  }

  // Toggles the Home Hub's own manual-record switch rather than recording via
  // HA's camera.record service - the Home Hub already has its own storage
  // and recording pipeline, so there's nothing for HA to proxy here beyond
  // flipping the switch. Starting sets a fixed 5-minute timer
  // (reolink_manual_record_expired in security.yaml turns the switch back
  // off on timer.finished, so this works even if the dashboard is closed
  // before the window ends); clicking again while already recording stops
  // it immediately instead of waiting out the timer.
  async _recordClip() {
    const entityId = this._config.record_switch_entity;
    if (!entityId) return;
    const timerEntityId = `timer.${entityId.split(".")[1]}`;
    const recording = this._hass.states[entityId]?.state === "on";
    try {
      if (recording) {
        await this._hass.callService("switch", "turn_off", { entity_id: entityId });
        await this._hass.callService("timer", "cancel", { entity_id: timerEntityId });
      } else {
        await this._hass.callService("switch", "turn_on", { entity_id: entityId });
        await this._hass.callService("timer", "start", {
          entity_id: timerEntityId,
          duration: "00:05:00",
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to toggle manual record", err);
    }
  }

  // Shared by setConfig and every live-view toggle (mirrors
  // _updateRecordBtnVisibility) - the move button, preset dropdown, and pad
  // only make sense while actually looking at the live feed, and the pad
  // itself only shows once the move button has been tapped open.
  _updatePtzUiVisibility() {
    const padConfigured = !!this._config.ptz_pad_entity_prefix;
    const presetConfigured = !!this._config.ptz_preset_entity;
    this._moveBtn.hidden = !(this._liveActive && padConfigured);
    this._presetWrap.hidden = !(this._liveActive && presetConfigured);
    this._ptzControls.hidden = !(this._liveActive && padConfigured && this._ptzPadOpen);
    this._ptzZoom.hidden = !this._config.ptz_zoom_entity;
    this._padDefaultBtn.classList.toggle("pad-default-unavailable", !this._config.ptz_guard_entity);
  }

  _togglePtzPad() {
    this._ptzPadOpen = !this._ptzPadOpen;
    this._moveBtn.classList.toggle("active", this._ptzPadOpen);
    this._updatePtzUiVisibility();
    if (this._ptzPadOpen) {
      this._ptzSuppressPirStart();
    } else {
      this._ptzSuppressPirEnd();
    }
  }

  // Derives the location slug from the configured "button.<slug>_ptz" prefix
  // (e.g. "button.patio_ptz" -> "patio") - reuses whatever PIR/snooze
  // entities a notification-action camera_snooze automation already
  // maintains for that slug (number.<slug>_pir_sensitivity,
  // input_number.<slug>_pir_sensitivity_saved, timer.<slug>_camera_snooze)
  // rather than adding new config keys for this.
  _ptzPirLocationSlug() {
    const match = (this._config.ptz_pad_entity_prefix || "").match(/^button\.(.+)_ptz$/);
    return match ? match[1] : null;
  }

  // Floors PIR sensitivity for as long as the pad is open, the same way the
  // notification-action camera_snooze already does - see _ptzSuppressPirEnd
  // for the restore side. This only covers pans made through this card.
  // There's no reliable way to also catch a pan made directly in the Reolink
  // app: this integration's sensor.<slug>_ptz_pan/tilt_position entities
  // only update when the connection re-establishes (confirmed via a week of
  // history showing the value frozen except right after reconnects), not
  // live during normal panning, so an automation keyed off them never
  // actually fires in practice - tried and reverted rather than shipping a
  // design that silently does nothing (see git history).
  //
  // Skips entirely - no save, no floor - if a real notification-action
  // snooze is already active for this camera, so opening the pad during an
  // existing (longer) snooze can't stomp its saved-PIR value with the
  // already-floored one (the same class of bug reolink_snooze_camera's own
  // re-press guard fixes).
  async _ptzSuppressPirStart() {
    const slug = this._ptzPirLocationSlug();
    if (!slug) return;
    const pirEntity = `number.${slug}_pir_sensitivity`;
    const pirState = this._hass.states[pirEntity];
    if (!pirState) return; // not every camera has a PIR sensitivity entity
    if (this._hass.states[`timer.${slug}_camera_snooze`]?.state === "active") return;
    await this._hass.callService("input_number", "set_value", {
      entity_id: `input_number.${slug}_pir_sensitivity_saved`,
      value: Number(pirState.state),
    });
    await this._hass.callService("number", "set_value", {
      entity_id: pirEntity,
      value: pirState.attributes.min ?? 1,
    });
  }

  // Restores PIR sensitivity when the pad closes, unless a real
  // notification-action snooze is active by then - that snooze's own expiry
  // handles restoration at the right time instead, so closing the pad
  // mid-snooze can't cut it short.
  async _ptzSuppressPirEnd() {
    const slug = this._ptzPirLocationSlug();
    if (!slug) return;
    const pirEntity = `number.${slug}_pir_sensitivity`;
    if (!this._hass.states[pirEntity]) return;
    if (this._hass.states[`timer.${slug}_camera_snooze`]?.state === "active") return;
    const saved = this._hass.states[`input_number.${slug}_pir_sensitivity_saved`];
    if (!saved) return;
    await this._hass.callService("number", "set_value", {
      entity_id: pirEntity,
      value: Number(saved.state),
    });
  }

  // Originally called reolink.ptz_move (its target selector requires the
  // button entity to report supported_features: 2), but some cameras' PTZ
  // button entities never carry that flag - unlike others on the same hub,
  // even fresh after an integration reload - so the service call was
  // rejected outright ("does not support action") despite the camera and
  // button working fine otherwise. button.press has no such feature-flag gate
  // and works
  // uniformly regardless of what capability bits a given camera happens to
  // report, at the cost of losing the ability to set a custom pan speed (the
  // button uses whatever default speed the integration itself presses it
  // at) - not a loss in practice since nothing here ever exposed a speed
  // config option.
  _ptzMove(direction) {
    const prefix = this._config.ptz_pad_entity_prefix;
    if (!prefix) return;
    this._hass.callService("button", "press", { entity_id: `${prefix}_${direction}` });
  }

  // The direction buttons start a continuous move (see _ptzMove) that only
  // the camera's own stop command ends.
  _ptzStop() {
    const prefix = this._config.ptz_pad_entity_prefix;
    if (!prefix) return;
    this._hass.callService("button", "press", { entity_id: `${prefix}_stop` });
  }

  // Each click is a multiple of the entity's own step so it's a
  // proportionally similar jump regardless of a given camera's configured
  // min/max/step, rather than a hardcoded absolute amount. A bare single
  // step per click (1 out of 0-32 here) was too fine-grained to be useful
  // for a tap-to-zoom control.
  static PTZ_ZOOM_STEP_MULTIPLIER = 4;

  // Same gap as presets (see _updatePtzPresetUi): this Reolink number entity
  // doesn't report its live zoom position back, so hass.states[entityId].state
  // never changes after a set_value call - reading it fresh on every click
  // meant every click after the first re-sent the same target value (the
  // camera would refocus at that position but never actually move further).
  // _ptzZoomValue tracks the optimistic current value locally instead, the
  // same pattern _ptzSelectedPreset uses for the preset dropdown.
  _ptzZoomStep(direction) {
    const entityId = this._config.ptz_zoom_entity;
    if (!entityId) return;
    const state = this._hass.states[entityId];
    if (!state) return;
    const { min, max, step } = state.attributes;
    if (this._ptzZoomValue === undefined) this._ptzZoomValue = Number(state.state);
    const delta = step * ReolinkHubPlaybackBridgeCard.PTZ_ZOOM_STEP_MULTIPLIER * direction;
    const next = Math.max(min, Math.min(max, this._ptzZoomValue + delta));
    this._hass.callService("number", "set_value", { entity_id: entityId, value: next });
    this._ptzZoomValue = next;
  }

  // Sentinel for the synthetic "Default" entry (see _updatePtzPresetUi) -
  // distinct from any real camera preset name so it can never collide with
  // one, and never passed to select.select_option.
  static PTZ_GUARD_DEFAULT_OPTION = "__ptz_guard_default__";

  // Fallback only for cameras with presets but no ptz_guard_entity
  // configured: marks whichever preset is literally named "Default"
  // (case-insensitive) with a home icon. Camera-side option ORDER isn't a
  // reliable signal for this (one camera's first option might be "Default",
  // another's might be its own name, and a third might list
  // ["Side door", "Default"] with "Default" second), so this scans for the
  // name rather than assuming position. Falls back to the first option for
  // cameras with no preset actually named that.
  _ptzDefaultPreset(options) {
    return options.find((o) => o.toLowerCase() === "default") || options[0];
  }

  // Displayed as "Overview" - the sentinel/internal naming elsewhere in this
  // file still says "default"/"guard default" since that's what it does
  // (recalls the Guard set point), not what it's labeled.
  _ptzPresetLabel(option) {
    return option === ReolinkHubPlaybackBridgeCard.PTZ_GUARD_DEFAULT_OPTION ? "Overview" : option;
  }

  // The pad's center button and the dropdown's synthetic "Default" entry are
  // the same action - see _updatePtzPresetUi.
  _ptzRecallDefault() {
    if (!this._config.ptz_guard_entity) return;
    this._activatePtzPreset(ReolinkHubPlaybackBridgeCard.PTZ_GUARD_DEFAULT_OPTION);
  }

  // Shared by every dropdown item and the pad's center button. The guard
  // sentinel presses the camera's Guard set point
  // (button.<prefix>_guard_go_to) instead of calling select.select_option -
  // see _updatePtzPresetUi for why Guard, not a preset, backs "Default".
  // Updates _ptzSelectedPreset optimistically either way, since the preset
  // entity's own state can't be trusted to reflect what's active.
  _activatePtzPreset(option) {
    if (option === ReolinkHubPlaybackBridgeCard.PTZ_GUARD_DEFAULT_OPTION) {
      this._hass.callService("button", "press", { entity_id: this._config.ptz_guard_entity });
    } else {
      this._hass.callService("select", "select_option", {
        entity_id: this._config.ptz_preset_entity,
        option,
      });
    }
    this._ptzSelectedPreset = option;
    this._presetDropdown.hidden = true;
    this._renderPtzPresetSelection();
  }

  // Presets come entirely from the select entity's live options list (never
  // hardcoded per-camera) so this scales to any future PTZ camera just by
  // pointing ptz_preset_entity at its select entity. The dropdown is only
  // rebuilt when the state object itself changes (HA replaces the state
  // object wholesale on any change, so reference equality is enough) -
  // otherwise this runs on every hass tick and would rebuild for no reason.
  //
  // When ptz_guard_entity is configured, a synthetic "Default" entry is
  // prepended ahead of the camera's own preset list rather than trusting a
  // camera-side preset to represent "default" - Guard is a single dedicated
  // home/return position the integration exposes uniformly on every PTZ
  // camera (there's also a separate switch.<prefix>_guard_return for
  // auto-return-on-idle, which this card doesn't touch), so it's a more
  // reliable "Default" than hoping a same-named preset exists and is
  // maintained. Falls back to _ptzDefaultPreset when there's no guard
  // entity.
  //
  // The select entity's own `state` never actually reflects which preset is
  // active (this camera/integration doesn't echo it back - it reads
  // "unknown" even right after a successful select_option call), so the
  // dropdown/label track a locally-optimistic _ptzSelectedPreset instead:
  // set immediately on click (_activatePtzPreset) and initialized here from
  // state.state only the first time. If a future integration version does
  // start reporting a real (non-"unknown") state that disagrees with the
  // local guess, that real value wins - see the reconciliation below.
  _updatePtzPresetUi() {
    const entityId = this._config.ptz_preset_entity;
    const state = this._hass.states[entityId];
    if (!state) return;
    const options = state.attributes.options || [];
    const GUARD = ReolinkHubPlaybackBridgeCard.PTZ_GUARD_DEFAULT_OPTION;
    const guardConfigured = !!this._config.ptz_guard_entity;
    if (state !== this._lastPtzPresetState) {
      this._lastPtzPresetState = state;
      const defaultPreset = guardConfigured ? null : this._ptzDefaultPreset(options);
      const items = guardConfigured
        ? [{ option: GUARD, home: true }, ...options.map((opt) => ({ option: opt, home: false }))]
        : options.map((opt) => ({ option: opt, home: opt === defaultPreset }));
      this._presetDropdown.innerHTML = items
        .map(
          (item) => `
            <button data-option="${item.option}">
              ${item.home ? '<ha-icon icon="mdi:home"></ha-icon>' : ""}<span>${this._ptzPresetLabel(item.option)}</span>
            </button>`
        )
        .join("");
      this._presetDropdown.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => this._activatePtzPreset(btn.dataset.option));
      });
      const knownOptions = items.map((i) => i.option);
      if (this._ptzSelectedPreset === undefined || !knownOptions.includes(this._ptzSelectedPreset)) {
        this._ptzSelectedPreset =
          state.state && state.state !== "unknown" && options.includes(state.state)
            ? state.state
            : guardConfigured
              ? GUARD
              : defaultPreset;
      }
    } else if (
      state.state &&
      state.state !== "unknown" &&
      options.includes(state.state) &&
      state.state !== this._ptzSelectedPreset
    ) {
      this._ptzSelectedPreset = state.state;
    }
    this._renderPtzPresetSelection();
  }

  _renderPtzPresetSelection() {
    this._presetDropdown.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.option === this._ptzSelectedPreset);
    });
    this._presetLabel.textContent = this._ptzSelectedPreset
      ? this._ptzPresetLabel(this._ptzSelectedPreset)
      : "Preset";
  }

  _batteryMdiIcon(pct) {
    if (!Number.isFinite(pct)) return "mdi:battery-unknown";
    if (pct >= 95) return "mdi:battery";
    if (pct <= 5) return "mdi:battery-outline";
    return `mdi:battery-${Math.max(1, Math.min(9, Math.round(pct / 10)))}0`;
  }

  _updateBatteryBadge() {
    const state = this._hass.states[this._config.battery_entity];
    if (!state) {
      this._batteryBadge.hidden = true;
      return;
    }
    this._batteryBadge.hidden = false;
    const pct = Number(state.state);
    this._batteryIcon.setAttribute("icon", this._batteryMdiIcon(pct));
    this._batteryText.textContent = Number.isFinite(pct) ? `${pct}%` : state.state;
  }

  // Tapping the battery badge can deep-link to wherever your own dashboard
  // shows battery history, via the `battery_dashboard_path` config field (a
  // path within this same HA frontend, e.g. "/my-dashboard/batteries") - a
  // no-op when unset. Uses HA's own SPA navigation - pushState plus a
  // location-changed event - rather than a real link/window.open, so it
  // doesn't trigger a full page reload the way an <a href> would if the
  // frontend's own click interception didn't catch it first.
  _navigateToBatteryDashboard() {
    const path = this._config.battery_dashboard_path;
    if (!path) return;
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  // Applies to whichever view is currently showing: restarts the live stream
  // at the new quality, or re-browses the VOD day/clip tree at the new
  // quality (see _mediaSourceIdForQuality) and tries to land back on the same
  // day and clip index - main/sub are simultaneous encodes of the same
  // events, so day count and per-day clip order line up between the two.
  async _toggleQuality() {
    if (this._qualityBtn.hidden) return;
    const next = this._quality === "main" ? "sub" : "main";
    if (next === "main" && !hevcMseSupported()) {
      // eslint-disable-next-line no-console
      console.warn(
        "reolink-hub-playback-bridge-card: this browser's MediaSource doesn't report hvc1/hev1 support - high quality may fail to play"
      );
    }
    this._quality = next;
    this._updateQualityBtn();

    if (this._liveActive) {
      await this._playLiveFlv(this._quality);
      return;
    }
    await this._reloadVodForQuality();
  }

  _dayKey(day) {
    const p = day.media_content_id.split("|");
    return `${p[4]}-${p[5]}-${p[6]}`;
  }

  async _fetchSortedDays(mediaSourceId) {
    const result = await this._browse(mediaSourceId);
    // DAY identifiers: DAY|entry|channel|stream|year|month|day - sort newest first
    return (result.children || []).slice().sort((a, b) => {
      const pa = a.media_content_id.split("|");
      const pb = b.media_content_id.split("|");
      const da = new Date(Number(pa[4]), Number(pa[5]) - 1, Number(pa[6]));
      const db = new Date(Number(pb[4]), Number(pb[5]) - 1, Number(pb[6]));
      return db - da;
    });
  }

  _applyEmptyDaysUi() {
    this._dayLabel.textContent = "No recordings";
    this._todayBtn.disabled = true;
    this._dayPrevBtn.disabled = true;
    this._dayNextBtn.disabled = true;
    this._clipsEl.innerHTML = '<div class="empty">No recordings in the last 31 days.</div>';
  }

  async _reloadVodForQuality() {
    const prevDayKey = this._days && this._dayIndex != null ? this._dayKey(this._days[this._dayIndex]) : null;
    const prevSelectedIndex = this._selectedIndex;
    try {
      const days = await this._fetchSortedDays(this._mediaSourceIdForQuality(this._quality));
      this._days = days;
      if (days.length === 0) {
        this._applyEmptyDaysUi();
        return;
      }
      let newIndex = prevDayKey ? days.findIndex((d) => this._dayKey(d) === prevDayKey) : 0;
      if (newIndex < 0) newIndex = 0;
      await this._goToDay(newIndex);
      if (prevSelectedIndex != null && this._clips && prevSelectedIndex < this._clips.length) {
        this._selectClip(prevSelectedIndex);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to reload recordings at new quality", err);
    }
  }

  // ha-camera-stream is a Home Assistant frontend component (powers the
  // built-in more-info live view) but frontend internals aren't exposed on
  // `window` for custom cards to import directly. `loadCardHelpers()` is the
  // documented, public way to reach them: creating a picture-glance card
  // with camera_view: "live" and feeding it `hass` forces it to mount
  // ha-camera-stream immediately (unlike the default "auto" view, which only
  // shows a static snapshot until tapped), which registers the custom
  // element globally as a side effect. A no-op once already registered.
  async _ensureCameraStreamLoaded() {
    if (customElements.get("ha-camera-stream")) return;
    if (typeof window.loadCardHelpers !== "function") return;
    const helpers = await window.loadCardHelpers();
    const probe = await helpers.createCardElement({
      type: "picture-glance",
      camera_view: "live",
      entities: [],
      camera_image: this._config.live_camera_entity,
    });
    probe.hass = this._hass;
    await customElements.whenDefined("ha-camera-stream");
  }

  async _toggleLive() {
    if (this._liveActive) {
      this._destroyLiveView();
      return;
    }

    this._liveActive = true;
    this._liveBtn.classList.add("active");
    this._todayBtn.hidden = true;
    this._root.querySelector(".day-stepper").hidden = true;
    // Hides the battery badge too (a sibling inside .filters) - it's only
    // relevant while browsing recordings, not while watching the live feed.
    this._filtersRow.hidden = true;
    this._updateRecordBtnVisibility();
    // Pad always starts collapsed on entering live view - it shouldn't stay
    // open from a previous session and push the card taller before the user
    // has asked for it.
    this._ptzPadOpen = false;
    this._moveBtn.classList.remove("active");
    this._updatePtzUiVisibility();
    this._vodView.hidden = true;
    this._liveView.hidden = false;
    this._video.pause();

    const canUseFlvLive =
      typeof window.mpegts !== "undefined" && window.mpegts.isSupported() && this._entryAndChannel() !== null;

    if (canUseFlvLive) {
      this._liveVideo.hidden = false;
      this._liveMount.hidden = true;
      await this._playLiveFlv(this._quality);
      return;
    }

    // Fallback when mpegts.js/MSE isn't usable at all: Home Assistant's own
    // live view component (goes over the built-in reolink integration's
    // RTSP -> HLS pipeline instead of the Home Hub's live FLV endpoint).
    // Quality is meaningless here since ha-camera-stream is bound to a fixed
    // live_camera_entity, but stays applicable to recordings underneath.
    this._liveVideo.hidden = true;
    this._liveMount.hidden = false;
    this._qualityBtn.hidden = true;
    this._liveMount.innerHTML = '<div class="loading">Loading live view…</div>';

    try {
      await this._ensureCameraStreamLoaded();
      if (!this._liveActive) return; // toggled off again while loading
      const el = document.createElement("ha-camera-stream");
      el.hass = this._hass;
      el.stateObj = this._hass.states[this._config.live_camera_entity];
      el.muted = true;
      el.controls = true;
      this._liveMount.innerHTML = "";
      this._liveMount.appendChild(el);
      this._liveEl = el;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to load live view", err);
      this._liveMount.innerHTML = '<div class="empty">Live view unavailable.</div>';
    }
  }

  _destroyLiveView() {
    this._liveActive = false;
    this._liveBtn.classList.remove("active");
    // Restore (rather than force-hide) - the quality toggle still applies to
    // the recordings view being revealed underneath.
    this._qualityBtn.hidden = !this._entryAndChannel() || !this._config.hq_available;
    this._todayBtn.hidden = false;
    this._root.querySelector(".day-stepper").hidden = false;
    this._filtersRow.hidden = false;
    this._updateRecordBtnVisibility();
    // Safety net - closing the whole live view (not just the pad) while
    // panning shouldn't leave PIR floored indefinitely.
    if (this._ptzPadOpen) this._ptzSuppressPirEnd();
    this._ptzPadOpen = false;
    this._moveBtn.classList.remove("active");
    this._presetDropdown.hidden = true;
    this._updatePtzUiVisibility();
    this._vodView.hidden = false;
    this._liveView.hidden = true;

    this._destroyLivePlayer();

    if (this._liveEl) {
      this._liveEl.stateObj = undefined;
      this._liveEl.remove();
      this._liveEl = null;
    }
    this._liveMount.innerHTML = "";
  }

  // Derives the SUMMARY|entry|channel|stream browse id from the configured
  // RES|entry|channel|stream media_source_id (see media_source.py) - both
  // share the same entry/channel/stream triple, so no separate config field
  // is needed for this.
  _summaryMediaSourceId() {
    const match = this._config.media_source_id.match(/^(media-source:\/\/reolink_hub_playback_bridge\/)RES\|(.+)$/);
    return match ? `${match[1]}SUMMARY|${match[2]}` : null;
  }

  // Lazily fetches per-day AI-trigger summaries (see _async_generate_day_summary
  // in media_source.py) the first time the calendar is opened, so cards that
  // never use the date picker never pay for the heavier bulk fetch. Opt-out via
  // `calendar_trigger_highlighting: false` in the card config.
  async _loadDaySummary() {
    if (this._config.calendar_trigger_highlighting === false) return;
    const summaryId = this._summaryMediaSourceId();
    if (!summaryId) return;
    try {
      const result = await this._browse(summaryId);
      const map = new Map();
      for (const child of result.children || []) {
        // DAYSUM|entry|channel|stream|year|month|day|triggers
        const parts = child.media_content_id.split("|");
        const [year, month, day] = parts.slice(4, 7);
        const triggerTail = parts[7];
        map.set(`${year}-${month}-${day}`, triggerTail === "NONE" ? [] : triggerTail.split(","));
      }
      this._daySummary = map;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card: failed to load day summary, falling back to unfiltered calendar", err);
      this._daySummary = null;
    }
  }

  async _toggleCalendar() {
    if (!this._calendarEl.hidden) {
      this._calendarEl.hidden = true;
      return;
    }
    this._calendarEl.hidden = false;
    this._calendarEl.innerHTML = '<div class="loading">Loading…</div>';
    if (this._config.calendar_trigger_highlighting !== false && this._daySummary === undefined) {
      await this._loadDaySummary();
    }
    this._renderCalendar();
  }

  _renderCalendar() {
    const current = this._days[this._dayIndex];
    const currentParts = current.media_content_id.split("|");
    const monthDate =
      this._calendarMonth || new Date(Number(currentParts[4]), Number(currentParts[5]) - 1, 1);
    this._calendarMonth = monthDate;

    const dayIndexByKey = new Map();
    this._days.forEach((d, idx) => {
      const p = d.media_content_id.split("|");
      dayIndexByKey.set(`${p[4]}-${p[5]}-${p[6]}`, idx);
    });

    const year = monthDate.getFullYear();
    const month = monthDate.getMonth(); // 0-based
    const firstOfMonth = new Date(year, month, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = Array(startOffset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);

    const monthLabel = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const weekdayHeaders = WEEKDAY_HEADERS.map((w) => `<div class="cal-weekday">${w}</div>`).join("");

    const cellsHtml = cells
      .map((d) => {
        if (d === null) return `<div class="cal-day"></div>`;
        const key = `${year}-${month + 1}-${d}`;
        const dayIndex = dayIndexByKey.get(key);
        if (dayIndex === undefined) {
          return `<div class="cal-day cal-disabled">${d}</div>`;
        }
        const cls = ["cal-day", "cal-available"];
        if (this._activeFilter && this._daySummary) {
          const summary = this._daySummary.get(key);
          if (summary && !summary.includes(this._activeFilter)) cls.push("cal-muted");
        }
        if (dayIndex === this._dayIndex) cls.push("cal-selected");
        return `<button class="${cls.join(" ")}" data-day-index="${dayIndex}">${d}</button>`;
      })
      .join("");

    this._calendarEl.innerHTML = `
      <div class="cal-header">
        <button class="cal-prev-month" aria-label="Previous month">&#8249;</button>
        <span>${monthLabel}</span>
        <button class="cal-next-month" aria-label="Next month">&#8250;</button>
      </div>
      <div class="cal-grid">${weekdayHeaders}${cellsHtml}</div>
    `;

    this._calendarEl.querySelectorAll(".cal-available").forEach((el) => {
      el.addEventListener("click", () => this._goToDay(Number(el.dataset.dayIndex)));
    });
    this._calendarEl.querySelector(".cal-prev-month").addEventListener("click", () => {
      this._calendarMonth = new Date(year, month - 1, 1);
      this._renderCalendar();
    });
    this._calendarEl.querySelector(".cal-next-month").addEventListener("click", () => {
      this._calendarMonth = new Date(year, month + 1, 1);
      this._renderCalendar();
    });
  }
}

// Settings editor. Kept thin on purpose: a "pick your camera" device selector
// on top (not itself a saved config field) that calls the reolink_hub_playback_bridge
// backend's camera_config websocket command and merges the result into the
// working config, plus one <ha-form> for every actual field, reused as-is for
// direct edits - <ha-form> already treats its `.data` as current values and
// fires value-changed on manual edits, so "auto-populate, but overridable"
// falls out for free rather than needing bespoke per-field wiring. This is
// why it's a real custom element (getConfigElement) rather than the simpler
// static getConfigForm schema: the device-picker auto-population is an
// imperative "field A changed, fetch, then overwrite fields B-H" flow that a
// declarative form schema has no hook for.
const PTZ_SCHEMA = [
  { name: "ptz_pad_entity_prefix", selector: { text: {} } },
  { name: "ptz_preset_entity", selector: { entity: { domain: "select" } } },
  { name: "ptz_guard_entity", selector: { entity: { domain: "button" } } },
  { name: "ptz_zoom_entity", selector: { entity: { domain: "number" } } },
];

const FIELD_LABELS = {
  media_source_id: "Media source ID",
  live_camera_entity: "Live camera entity",
  record_switch_entity: "Record switch entity",
  battery_entity: "Battery entity",
  hq_available: "Enable 4K (Clear)",
  hq_default: "Default to 4K",
  ptz_pad_entity_prefix: "PTZ pad entity prefix",
  ptz_preset_entity: "PTZ preset entity",
  ptz_guard_entity: "PTZ guard entity",
  ptz_zoom_entity: "PTZ zoom entity",
};

const FIELD_HELPERS = {
  media_source_id:
    "media-source://reolink_hub_playback_bridge/RES|<hub_entry_id>|<channel>|<sub|main> - auto-filled by the camera picker above. The quality suffix here no longer affects behavior; hq_available/hq_default below control the actual default.",
  hq_available:
    "Shows the HQ pill in both live and recorded view. Leave off for cameras where 4K decode has been unreliable.",
  hq_default:
    "Opens both live and recorded view on the Clear stream. Off by default even when 4K is enabled - the HQ pill still lets you switch to it per session.",
  ptz_pad_entity_prefix:
    "A prefix, not a full entity ID - the card appends _up/_down/_left/_right etc. itself.",
};

class ReolinkHubPlaybackBridgeCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    // this._form may not exist yet - _build() is async (awaits
    // customElements.whenDefined below) and HA can call setConfig() before
    // that resolves. Rendering is a no-op here in that case; _build() itself
    // renders once the form actually exists, using whatever this._config
    // was last set to.
    if (this._form) {
      this._renderForm();
      this._syncDeviceSelector();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._deviceSelector) this._deviceSelector.hass = hass;
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() {
    if (!this._buildStarted) {
      this._buildStarted = true;
      this._build();
    }
  }

  async _build() {
    await Promise.all([
      customElements.whenDefined("ha-form"),
      customElements.whenDefined("ha-selector"),
    ]);
    this.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:16px; padding:8px 0;">
        <div style="background:var(--primary-color, #03a9f4); background:color-mix(in srgb, var(--primary-color, #03a9f4) 12%, transparent); border-radius:8px; padding:12px 14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-weight:600; font-size:0.95em;">Camera</div>
          <div class="picker-slot"></div>
          <div style="font-size:0.85em; color:var(--secondary-text-color, #999);">
            Fills in the fields below from this camera's entities. You can still edit any field afterward.
          </div>
        </div>
        <div class="form-slot"></div>
      </div>
    `;
    this._pickerSlot = this.querySelector(".picker-slot");
    this._formSlot = this.querySelector(".form-slot");

    this._deviceSelector = document.createElement("ha-selector");
    this._deviceSelector.hass = this._hass;
    // entity: {domain: "camera"} excludes the Home Hub device itself - it's
    // a reolink-integration device like every channel, but carries no
    // camera.* entity of its own (those belong to each channel's device),
    // so it isn't a valid pick for this card.
    this._deviceSelector.selector = {
      device: { filter: { integration: "reolink", entity: { domain: "camera" } } },
    };
    this._deviceSelector.label = "Choose a camera…";
    this._deviceSelector.addEventListener("value-changed", (ev) =>
      this._onDeviceChanged(ev.detail.value)
    );
    this._pickerSlot.appendChild(this._deviceSelector);

    this._form = document.createElement("ha-form");
    this._form.hass = this._hass;
    this._form.computeLabel = (schema) => FIELD_LABELS[schema.name] || schema.name;
    this._form.computeHelper = (schema) => FIELD_HELPERS[schema.name] || "";
    this._form.addEventListener("value-changed", (ev) => {
      this._config = { ...ev.detail.value };
      this._renderForm();
      this._fireConfigChanged();
    });
    this._formSlot.appendChild(this._form);

    this._renderForm();
    this._syncDeviceSelector();
  }

  // Reverse-derives the picker's value from the already-configured
  // live_camera_entity on open, via the entity registry (hass.entities, a
  // full snapshot always available on the hass object cards/editors
  // receive) - otherwise editing an existing card always showed the picker
  // as blank even though every field below it was already filled in.
  _syncDeviceSelector() {
    if (!this._deviceSelector || !this._hass || !this._hass.entities) return;
    const entityId = this._config.live_camera_entity;
    const entry = entityId ? this._hass.entities[entityId] : undefined;
    this._deviceSelector.value = entry ? entry.device_id : undefined;
  }

  // Recomputed on every render (not built once) since hq_default's visibility
  // depends on the current hq_available value. Only hq_available/hq_default
  // are top-level - everything the camera picker can fill in lives inside a
  // collapsed "Advanced" group, since normal use is pick-camera-and-done and
  // these fields only need attention when overriding something the picker
  // got wrong (see the naming-quirk comment in _onDeviceChanged).
  _schema() {
    const schema = [{ name: "hq_available", selector: { boolean: {} } }];
    if (this._config.hq_available) {
      schema.push({ name: "hq_default", selector: { boolean: {} } });
    }
    schema.push({
      name: "advanced",
      type: "expandable",
      title: "Advanced (auto-filled by the camera picker)",
      expanded: false,
      flatten: true,
      schema: [
        { name: "media_source_id", required: true, selector: { text: {} } },
        { name: "live_camera_entity", selector: { entity: { domain: "camera" } } },
        { name: "record_switch_entity", selector: { entity: { domain: "switch" } } },
        { name: "battery_entity", selector: { entity: { domain: "sensor" } } },
        ...PTZ_SCHEMA,
      ],
    });
    return schema;
  }

  _renderForm() {
    this._form.schema = this._schema();
    this._form.data = this._config;
  }

  async _onDeviceChanged(deviceId) {
    if (!deviceId || !this._hass) return;
    let result;
    try {
      result = await this._hass.callWS({
        type: "reolink_hub_playback_bridge/camera_config",
        device_id: deviceId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("reolink-hub-playback-bridge-card-editor: camera_config lookup failed", err);
      return;
    }

    const ptz = result.ptz || {};
    this._config = {
      ...this._config,
      media_source_id: result.media_source_id_sub,
      live_camera_entity: result.live_camera_entity || undefined,
      record_switch_entity: result.record_switch_entity || undefined,
      battery_entity: result.battery_entity || undefined,
      ptz_pad_entity_prefix: ptz.pad_entity_prefix || undefined,
      ptz_preset_entity: ptz.preset_entity || undefined,
      ptz_guard_entity: ptz.guard_entity || undefined,
      ptz_zoom_entity: ptz.zoom_entity || undefined,
    };
    // Drop keys the lookup came back empty for, rather than saving literal
    // `undefined`/blank values into the card config.
    Object.keys(this._config).forEach((key) => {
      if (this._config[key] === undefined) delete this._config[key];
    });

    this._renderForm();
    this._fireConfigChanged();
  }

  _fireConfigChanged() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }
}

customElements.define("reolink-hub-playback-bridge-card-editor", ReolinkHubPlaybackBridgeCardEditor);
customElements.define("reolink-hub-playback-bridge-card", ReolinkHubPlaybackBridgeCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "reolink-hub-playback-bridge-card",
  name: "Reolink Hub Playback Bridge Card",
  description: "Browse and play Reolink Home Hub recordings via mpegts.js (FLV/MSE), bypassing the throttled Download proxy.",
});

