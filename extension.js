// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const DEBUG = false;

const MEDIA_KEYS_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const MEDIA_KEYS_MIC_MUTE = "mic-mute";

const MUTE_HOTKEY_KEY = "mute-hotkey";

const MANAGE_GSD_KEY = "manage-gsd-mic-mute";
const GSD_OVERRIDDEN_KEY = "gsd-mic-mute-overridden";
const SAVED_GSD_KEY = "saved-gsd-mic-mute";
const HOTKEY_INIT_KEY = "hotkey-initialized";

// Mirrors GNOME's input slider (js/ui/status/volume.js): index 0 is muted/zero,
// 1-3 by volume level, so the OSD matches the stock one.
const MIC_ICONS = [
  "microphone-sensitivity-muted-symbolic",
  "microphone-sensitivity-low-symbolic",
  "microphone-sensitivity-medium-symbolic",
  "microphone-sensitivity-high-symbolic",
];
const MIC_LEVEL_COUNT = MIC_ICONS.length - 1;

// gsd releases its accelerator grab asynchronously; wait before re-asserting.
const REBIND_DELAY_MS = 800;

export default class MuteAllMicsExtension extends Extension {
  _debug(msg) {
    if (DEBUG) log(`[mute-all-mics] ${msg}`);
  }

  enable() {
    this._settings = this.getSettings();
    // Start MUTED: microphones stay off after every login until the user
    // unmutes. Also the source of truth when a mic is hot-plugged.
    this._muted = true;
    this._cancellable = new Gio.Cancellable();
    this._subscribeProc = null;
    this._subscribeStream = null;
    this._rebindTimeoutId = 0;

    // Must run before _overrideGsdMicMute clears the stock key.
    this._initHotkeyFromGsd();

    // Returns true only when it actually cleared a non-empty stock binding.
    const cleared = this._overrideGsdMicMute();

    this._registerKeybinding();

    // gsd had grabbed the combo and ungrabs asynchronously after we cleared its
    // key, so re-assert our binding once it has let go.
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

    this._startSourceWatch();

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

    Main.wm.removeKeybinding(MUTE_HOTKEY_KEY);

    this._stopSourceWatch();

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    // Restore before releasing settings (the restore reads our own keys).
    this._restoreGsdMicMute();

    this._muted = false;
    this._settings = null;
  }

  _registerKeybinding() {
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

  async _applyMuteToAll(muted) {
    const sources = await this._listRealSources();
    this._debug(`applyMute(${muted}) sources=${JSON.stringify(sources)}`);
    let failed = 0;
    for (const name of sources) {
      const r = await this._runPactl(["set-source-mute", name, muted ? "1" : "0"]);
      if (r === null) failed++;
    }
    // Surface an aggregate so a partial failure is not silently lost.
    if (failed > 0)
      logError(
        new Error(`failed to mute ${failed}/${sources.length} source(s)`),
        "[mute-all-mics]",
      );
  }

  async _listRealSources() {
    const out = await this._runPactl(["list", "short", "sources"]);
    if (!out) return [];

    const names = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const name = line.split("\t")[1];
      // Skip monitor sources (output loopbacks); names are stable, indices not.
      if (name && !name.includes(".monitor")) names.push(name);
    }
    return names;
  }

  // Resolves with pactl's stdout, or null on failure. Never rejects.
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

  // Calls Main.osdWindowManager directly (in-process), so it is not subject to
  // the D-Bus sender allow-list that guards org.gnome.Shell.ShowOSD.
  async _showOsd(muted) {
    const level = await this._getDefaultSourceLevel(); // 0..1, or null
    const icon = new Gio.ThemedIcon({ name: this._iconForState(muted, level) });

    // showAll(icon, label, level, maxLevel) since GNOME 49; on 45-48 it is
    // show(monitorIndex, ...) with monitorIndex -1 meaning all monitors.
    const osdLevel = level ?? null;
    const maxLevel = level === null ? -1 : 1;

    const mgr = Main.osdWindowManager;
    if (typeof mgr.showAll === "function")
      mgr.showAll(icon, null, osdLevel, maxLevel);
    else mgr.show(-1, icon, null, osdLevel, maxLevel);
  }

  _iconForState(muted, level) {
    if (muted || level === null || level <= 0) return MIC_ICONS[0];
    let n = Math.ceil(MIC_LEVEL_COUNT * level);
    n = Math.max(1, Math.min(n, MIC_LEVEL_COUNT));
    return MIC_ICONS[n];
  }

  async _getDefaultSourceLevel() {
    const out = await this._runPactl([
      "get-source-volume",
      "@DEFAULT_SOURCE@",
    ]);
    if (!out) return null;

    // A multi-channel source prints one percentage per channel; take the loudest.
    const matches = [...out.matchAll(/(\d+)%/g)];
    if (!matches.length) return null;
    const pct = Math.max(...matches.map((mm) => parseInt(mm[1], 10)));
    return Math.min(1, pct / 100);
  }

  // --- Hot-plug watch ------------------------------------------------------

  // Only 'new' source events are acted on: reacting to 'change' would loop,
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

      if (line === null) return; // EOF
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
        // Already gone.
      }
      this._subscribeProc = null;
    }
    this._subscribeStream = null;
  }

  // --- gnome-settings-daemon mic-mute override -----------------------------

  // Returns null if the schema is not installed (the extension still works).
  _getMediaKeysSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source || !source.lookup(MEDIA_KEYS_SCHEMA, true)) return null;
    return new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });
  }

  // Seed mute-hotkey from the pre-existing GNOME mic-mute shortcut, once.
  _initHotkeyFromGsd() {
    if (this._settings.get_boolean(HOTKEY_INIT_KEY)) return;

    // If we already took it over in a previous session it lives in saved-gsd;
    // otherwise read the stock key live, before _overrideGsdMicMute clears it.
    let original;
    if (this._settings.get_boolean(GSD_OVERRIDDEN_KEY)) {
      original = this._settings.get_strv(SAVED_GSD_KEY);
    } else {
      const gsd = this._getMediaKeysSettings();
      original = gsd ? gsd.get_strv(MEDIA_KEYS_MIC_MUTE) : [];
    }

    // Only adopt a real binding; otherwise keep the schema default.
    if (original.length > 0) {
      this._settings.set_strv(MUTE_HOTKEY_KEY, original);
      this._debug(`seeded hotkey from gsd: ${JSON.stringify(original)}`);
    }
    this._settings.set_boolean(HOTKEY_INIT_KEY, true);
  }

  // Clear the stock mic-mute shortcut. Returns true if a non-empty binding was
  // actually cleared in this call (caller uses this to handle the grab race).
  _overrideGsdMicMute() {
    if (!this._settings.get_boolean(MANAGE_GSD_KEY)) return false;
    if (this._settings.get_boolean(GSD_OVERRIDDEN_KEY)) return false;

    const gsd = this._getMediaKeysSettings();
    if (!gsd) return false;

    // Saved value and flag live in our own gsettings, so they survive a shell
    // restart and a later disable() can still restore the original binding.
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
      // Restore only if the key is still empty (what we left it). If the user
      // re-bound mic-mute themselves, keep their value instead of clobbering it.
      const current = gsd.get_strv(MEDIA_KEYS_MIC_MUTE);
      if (current.length === 0)
        gsd.set_strv(MEDIA_KEYS_MIC_MUTE, this._settings.get_strv(SAVED_GSD_KEY));
    }
    this._settings.set_boolean(GSD_OVERRIDDEN_KEY, false);
  }
}
