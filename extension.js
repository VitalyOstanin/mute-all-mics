// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

// Flip to true to get verbose journal logging during development.
const DEBUG = false;

// gnome-settings-daemon schema whose mic-mute shortcut we take over. Its stock
// handler toggles only the default source, which is the behaviour this extension
// replaces with an all-sources toggle.
const MEDIA_KEYS_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const MEDIA_KEYS_MIC_MUTE = "mic-mute";

// gschema key holding our configurable global shortcut (type 'as').
const MUTE_HOTKEY_KEY = "mute-hotkey";

// gschema keys for the gnome-settings-daemon mic-mute override bookkeeping.
const MANAGE_GSD_KEY = "manage-gsd-mic-mute";
const GSD_OVERRIDDEN_KEY = "gsd-mic-mute-overridden";
const SAVED_GSD_KEY = "saved-gsd-mic-mute";

// Microphone icon set, matching GNOME's own input slider
// (js/ui/status/volume.js), so the OSD is visually identical to the stock one.
// Index 0 is shown when muted or at zero volume; 1-3 by volume level.
const MIC_ICONS = [
  "microphone-sensitivity-muted-symbolic",
  "microphone-sensitivity-low-symbolic",
  "microphone-sensitivity-medium-symbolic",
  "microphone-sensitivity-high-symbolic",
];

// Number of non-muted volume levels (low/medium/high) the icon set encodes;
// index 0 is the muted icon, indices 1..MIC_LEVEL_COUNT are the volume buckets.
const MIC_LEVEL_COUNT = MIC_ICONS.length - 1;

// Delay before re-asserting the keybinding after we clear gnome-settings-daemon's
// mic-mute on the very first enable. gsd releases its accelerator grab
// asynchronously; re-registering once it has lets mutter index our binding.
const REBIND_DELAY_MS = 800;

export default class MuteAllMicsExtension extends Extension {
  _debug(msg) {
    if (DEBUG) log(`[mute-all-mics] ${msg}`);
  }

  enable() {
    this._settings = this.getSettings();
    // Desired global mute state. The extension starts MUTED: on every login the
    // microphones must be off until the user deliberately unmutes with the
    // hotkey. Also the source of truth when a microphone is hot-plugged while
    // mute is active.
    this._muted = true;
    // One cancellable for every async pactl call and the subscribe read loop, so
    // disable() can tear all of them down at once.
    this._cancellable = new Gio.Cancellable();
    this._subscribeProc = null;
    this._subscribeStream = null;
    this._rebindTimeoutId = 0;

    // Take over the mic-mute combo from gnome-settings-daemon so only our
    // all-sources handler is bound to it. Returns true if it actually cleared a
    // non-empty stock binding in this call (the only case with a grab race).
    const cleared = this._overrideGsdMicMute();

    this._registerKeybinding();

    // On the first enable gsd had grabbed the combo; it ungrabs asynchronously
    // after we cleared its key, so re-assert our binding shortly after to win the
    // accelerator once gsd has let go. On later sessions the stock key is already
    // empty, so this branch does not run.
    if (cleared) {
      this._rebindTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        REBIND_DELAY_MS,
        () => {
          this._rebindTimeoutId = 0;
          Main.wm.removeKeybinding(MUTE_HOTKEY_KEY);
          this._registerKeybinding();
          this._debug("re-asserted keybinding after gsd ungrab");
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    // Watch for newly added sources so a microphone plugged in or reconnected
    // while mute is active gets muted too.
    this._startSourceWatch();

    // Enforce the muted-at-startup state on the actual sources so the real
    // hardware matches this._muted === true right after login.
    this._applyMuteToAll(true).catch((e) =>
      logError(e, "[mute-all-mics] initial mute failed"),
    );
    this._debug("enabled");
  }

  disable() {
    if (this._rebindTimeoutId) {
      GLib.Source.remove(this._rebindTimeoutId);
      this._rebindTimeoutId = 0;
    }

    // Always attempt to remove the keybinding; it is a no-op if absent.
    Main.wm.removeKeybinding(MUTE_HOTKEY_KEY);

    this._stopSourceWatch();

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    // Restore gnome-settings-daemon's mic-mute shortcut before releasing
    // settings (the restore reads our own keys).
    this._restoreGsdMicMute();

    this._muted = false;
    this._settings = null;
  }

  _registerKeybinding() {
    // Meta re-reads the gsettings key whenever it changes, so editing the hotkey
    // in prefs applies live without a manual re-bind. IGNORE_AUTOREPEAT avoids
    // rapid toggling if the key repeats.
    const action = Main.wm.addKeybinding(
      MUTE_HOTKEY_KEY,
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.ALL,
      () => this._toggleMute(),
    );
    if (action === Meta.KeyBindingAction.NONE) {
      logError(
        new Error(
          `failed to bind ${JSON.stringify(
            this._settings.get_strv(MUTE_HOTKEY_KEY),
          )}`,
        ),
        "[mute-all-mics]",
      );
    } else {
      this._debug(`keybinding registered, action=${action}`);
    }
  }

  // --- Mute logic ----------------------------------------------------------

  _toggleMute() {
    this._muted = !this._muted;
    this._debug(`hotkey fired -> muted=${this._muted}`);
    this._applyMuteToAll(this._muted).catch((e) =>
      logError(e, "[mute-all-mics] applying mute failed"),
    );
    this._showOsd(this._muted).catch((e) =>
      logError(e, "[mute-all-mics] showing OSD failed"),
    );
  }

  // Set the mute state on every real microphone source. Monitor sources (output
  // loopbacks, name ending in .monitor) are skipped. Idempotent: re-running it
  // with the same target leaves already-correct sources untouched in practice.
  async _applyMuteToAll(muted) {
    const sources = await this._listRealSources();
    this._debug(`applyMute(${muted}) sources=${JSON.stringify(sources)}`);
    let failed = 0;
    for (const name of sources) {
      const r = await this._runPactl(["set-source-mute", name, muted ? "1" : "0"]);
      if (r === null) failed++;
    }
    // _runPactl logs each individual failure; surface an aggregate so a partial
    // failure (some sources left in the wrong state) is not silently lost.
    if (failed > 0)
      logError(
        new Error(`failed to mute ${failed}/${sources.length} source(s)`),
        "[mute-all-mics]",
      );
  }

  // Return the names of all input sources that are real microphones, excluding
  // monitor sources. Names (not indices) are used because they are stable.
  async _listRealSources() {
    const out = await this._runPactl(["list", "short", "sources"]);
    if (!out) return [];

    const names = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const name = line.split("\t")[1];
      if (name && !name.includes(".monitor")) names.push(name);
    }
    return names;
  }

  // Run `pactl <argv>` and resolve with its stdout (or null on failure). Never
  // rejects, so callers do not need their own error handling for spawn issues.
  _runPactl(argv) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = Gio.Subprocess.new(
          ["pactl", ...argv],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
      } catch (e) {
        logError(e, "[mute-all-mics] cannot spawn pactl (is it installed?)");
        resolve(null);
        return;
      }

      proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
        try {
          const [, stdout, stderr] = p.communicate_utf8_finish(res);
          const status = p.get_exit_status();
          if (status !== 0) {
            logError(
              new Error(
                `pactl ${argv.join(" ")} exit=${status}: ${(stderr ?? "").trim()}`,
              ),
              "[mute-all-mics]",
            );
            // Treat a non-zero exit as failure so callers can tell it apart from
            // a successful command with empty output.
            resolve(null);
            return;
          }
          resolve(stdout ?? "");
        } catch (e) {
          if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            logError(e, "[mute-all-mics] pactl call failed");
          resolve(null);
        }
      });
    });
  }

  // --- OSD -----------------------------------------------------------------

  // Show the native GNOME OSD. Because this runs inside the gnome-shell process,
  // it calls Main.osdWindowManager directly, which is not subject to the D-Bus
  // sender allow-list that guards org.gnome.Shell.ShowOSD for external callers.
  //
  // To match the stock microphone OSD exactly (js/ui/status/volume.js), the level
  // bar reflects the default source volume and the icon is chosen by mute state
  // and volume level. If the volume cannot be read, fall back to icon-only.
  async _showOsd(muted) {
    const level = await this._getDefaultSourceLevel(); // 0..1, or null
    const icon = new Gio.ThemedIcon({ name: this._iconForState(muted, level) });

    // API change across supported versions, detected by capability rather than
    // version number: showAll(icon, label, level, maxLevel) exists since GNOME
    // 49; on GNOME 45-48 the call is show(monitorIndex, icon, label, level,
    // maxLevel) with monitorIndex -1 meaning all monitors.
    const osdLevel = level ?? null; // null hides the bar (fallback only)
    const maxLevel = level === null ? -1 : 1;

    const mgr = Main.osdWindowManager;
    if (typeof mgr.showAll === "function")
      mgr.showAll(icon, null, osdLevel, maxLevel);
    else mgr.show(-1, icon, null, osdLevel, maxLevel);
  }

  // Mirror StreamSlider.getIcon(): muted or zero volume -> muted icon, otherwise
  // one of low/medium/high by volume.
  _iconForState(muted, level) {
    if (muted || level === null || level <= 0) return MIC_ICONS[0];
    let n = Math.ceil(MIC_LEVEL_COUNT * level);
    n = Math.max(1, Math.min(n, MIC_LEVEL_COUNT));
    return MIC_ICONS[n];
  }

  // Read the default source volume as a 0..1 fraction (1.0 == 100%), or null if
  // it cannot be determined. Parses `pactl get-source-volume @DEFAULT_SOURCE@`.
  async _getDefaultSourceLevel() {
    const out = await this._runPactl([
      "get-source-volume",
      "@DEFAULT_SOURCE@",
    ]);
    if (!out) return null;

    // A stereo (or multi-channel) source prints one percentage per channel; take
    // the loudest so the bar matches what GNOME shows for an unbalanced source.
    const matches = [...out.matchAll(/(\d+)%/g)];
    if (!matches.length) return null;
    const pct = Math.max(...matches.map((mm) => parseInt(mm[1], 10)));
    return Math.min(1, pct / 100);
  }

  // --- Hot-plug watch ------------------------------------------------------

  // Follow `pactl subscribe` so a microphone added while mute is active is muted
  // too. Only 'new' source events are acted on: reacting to 'change' would loop,
  // because our own set-source-mute emits 'change' events.
  _startSourceWatch() {
    try {
      this._subscribeProc = Gio.Subprocess.new(
        ["pactl", "subscribe"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
    } catch (e) {
      logError(e, "[mute-all-mics] cannot start pactl subscribe");
      this._subscribeProc = null;
      return;
    }

    this._subscribeStream = new Gio.DataInputStream({
      base_stream: this._subscribeProc.get_stdout_pipe(),
    });
    this._readNextEvent(this._subscribeStream);
  }

  _readNextEvent(stream) {
    stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
      let line;
      try {
        [line] = s.read_line_finish_utf8(res);
      } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
          logError(e, "[mute-all-mics] subscribe read failed");
        return;
      }

      if (line === null) return; // EOF: the subprocess exited.
      this._handleEvent(line);
      this._readNextEvent(stream);
    });
  }

  // Event lines look like: Event 'new' on source #62
  _handleEvent(line) {
    if (!this._muted) return;
    if (line.includes("'new'") && line.includes("on source")) {
      this._debug(`new source while muted: ${line.trim()}`);
      this._applyMuteToAll(true).catch((e) =>
        logError(e, "[mute-all-mics] muting new source failed"),
      );
    }
  }

  _stopSourceWatch() {
    if (this._subscribeProc) {
      try {
        this._subscribeProc.force_exit();
      } catch {
        // Already gone; nothing to do.
      }
      this._subscribeProc = null;
    }
    this._subscribeStream = null;
  }

  // --- gnome-settings-daemon mic-mute override -----------------------------

  // Returns a Gio.Settings for the media-keys schema, or null if the schema is
  // not installed (defensive: the extension still works without the override).
  _getMediaKeysSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source || !source.lookup(MEDIA_KEYS_SCHEMA, true)) return null;
    return new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });
  }

  // Clear the stock mic-mute shortcut. Returns true if a non-empty binding was
  // actually cleared in this call (caller uses this to handle the grab race).
  _overrideGsdMicMute() {
    if (!this._settings.get_boolean(MANAGE_GSD_KEY)) return false;
    if (this._settings.get_boolean(GSD_OVERRIDDEN_KEY)) return false;

    const gsd = this._getMediaKeysSettings();
    if (!gsd) return false;

    // Save the current value, then clear the stock shortcut. The saved value and
    // the flag live in our own gsettings, so they survive a shell restart and a
    // later disable() can still restore the original binding.
    const current = gsd.get_strv(MEDIA_KEYS_MIC_MUTE);
    this._settings.set_strv(SAVED_GSD_KEY, current);
    gsd.set_strv(MEDIA_KEYS_MIC_MUTE, []);
    this._settings.set_boolean(GSD_OVERRIDDEN_KEY, true);
    this._debug(`cleared gsd mic-mute (was ${JSON.stringify(current)})`);

    return current.length > 0;
  }

  _restoreGsdMicMute() {
    if (!this._settings) return;
    if (!this._settings.get_boolean(GSD_OVERRIDDEN_KEY)) return;

    const gsd = this._getMediaKeysSettings();
    if (gsd) {
      // Only restore the saved binding if the key is still empty (what we left
      // it). If it is non-empty, the user re-bound mic-mute themselves after we
      // cleared it (e.g. following a shell crash with no disable()), so keep
      // their value instead of clobbering it with our stale saved one.
      const current = gsd.get_strv(MEDIA_KEYS_MIC_MUTE);
      if (current.length === 0)
        gsd.set_strv(MEDIA_KEYS_MIC_MUTE, this._settings.get_strv(SAVED_GSD_KEY));
    }
    this._settings.set_boolean(GSD_OVERRIDDEN_KEY, false);
  }
}
