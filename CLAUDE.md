# CLAUDE.md

Guidance for AI agents and contributors working on this extension.

## Table of Contents

- [Project overview](#project-overview)
- [Hard constraint: GNOME 45-50](#hard-constraint-gnome-45-50)
- [API surface used](#api-surface-used)
- [Mute model](#mute-model)
- [OSD model](#osd-model)
- [Hot-plug model](#hot-plug-model)
- [gnome-settings-daemon mic-mute override](#gnome-settings-daemon-mic-mute-override)
- [Known API differences across versions](#known-api-differences-across-versions)
- [Procedure: verify against a GNOME version](#procedure-verify-against-a-gnome-version)
- [Reloading changed code without re-login (Wayland)](#reloading-changed-code-without-re-login-wayland)
- [Syntax check and schema](#syntax-check-and-schema)
- [Manual testing](#manual-testing)
- [Files](#files)

## Project overview

`mute-all-mics` binds one configurable shortcut that mutes/unmutes every real
microphone source at once (not only the default), shows the native GNOME
microphone OSD, and keeps hot-plugged microphones muted while mute is active. The
rationale for each approach is recorded in [docs/ADR](docs/ADR). Read the ADRs
before changing how muting, the OSD, the hot-plug watch, or the
gnome-settings-daemon override work.

## Hard constraint: GNOME 45-50

`metadata.json` declares `shell-version` 45 through 50. Every change MUST keep
the extension working across all of them. GNOME's API is not stable across major
versions, so any Meta/Shell/Clutter/St/Main symbol must be verified against each
declared version. Do not assume a symbol exists because it works on the locally
installed version. Prefer capability detection over version-number branching.

## API surface used

| Symbol                                              | Source       | Notes                                                            |
| --------------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| `Extension`, `getSettings()`                        | gnome-shell  | `js/extensions/extension.js`, since 45                           |
| `Main.wm.addKeybinding` / `removeKeybinding`        | gnome-shell  | `js/ui/windowManager.js`, signature stable 45-50                 |
| `Meta.KeyBindingFlags.IGNORE_AUTOREPEAT`            | mutter       | flag for the keybinding                                          |
| `Shell.ActionMode.ALL`                              | gnome-shell  | the shortcut works in every mode                                |
| `Main.osdWindowManager.showAll` / `.show`           | gnome-shell  | `showAll(icon,label,level,maxLevel)` since 49; `show(-1, …)` 45-48 |
| `Gio.Subprocess`, `Gio.DataInputStream`             | gio          | spawning `pactl`; `read_line_finish_utf8` for the subscribe loop |
| `Gio.Settings` (media-keys schema)                  | gio          | override / restore the stock mic-mute key                        |
| `Adw.ActionRow`, `Adw.SwitchRow`                    | libadwaita   | prefs; `SwitchRow` since libadwaita 1.4 (GNOME 45)              |
| `Gtk.EventControllerKey`, `Gtk.ShortcutLabel`       | gtk4         | interactive hotkey capture row in prefs                        |
| `Gtk.accelerator_name_with_keycode` / `_valid`      | gtk4         | serialise/validate the captured hotkey (GNOME Settings form)   |

External dependency: `pactl` (pulseaudio-utils / pipewire-pulse).

## Mute model

All muting goes through `pactl`, not Gvc, because the local gnome-shell checkout
has no vendored Gvc source to verify monitor-source handling against, while the
`pactl` source filter is concrete and verified on the target system (see
[docs/ADR/0002](docs/ADR/0002-mute-via-pactl-not-gvc.md)):

- `pactl list short sources` is parsed; entries whose name (column 2) contains
  `.monitor` are skipped (those are output loopbacks, not microphones);
- each remaining source gets `pactl set-source-mute <name> 1|0` (names, not
  indices, because names are stable);
- the desired state is held in `this._muted` (runtime only), which is also the
  source of truth for the hot-plug watch;
- `enable()` starts muted: `this._muted = true` and an initial `_applyMuteToAll(true)`,
  so all microphones are off after every login until deliberately unmuted (see
  [docs/ADR/0010](docs/ADR/0010-start-muted-on-enable.md)).

## OSD model

The extension runs inside the gnome-shell process, so it calls
`Main.osdWindowManager` directly. This is the genuine OSD and bypasses the
`DBusSenderChecker` allow-list (`org.gnome.Settings`,
`org.gnome.SettingsDaemon.MediaKeys`, the GNOME portal) that blocks
`org.gnome.Shell.ShowOSD` for external callers. To match the stock microphone OSD,
the level bar reflects the default source volume (read via `pactl
get-source-volume @DEFAULT_SOURCE@`, `maxLevel=1`) and the icon is chosen by mute
state and volume, mirroring `js/ui/status/volume.js`
(`microphone-sensitivity-muted-symbolic` … `-high-symbolic`). Only if the volume
cannot be read is `level=null` passed, which hides the bar (icon-only fallback).

## Hot-plug model

`pactl subscribe` is followed via a long-lived `Gio.Subprocess`; its stdout is
read line by line with `Gio.DataInputStream.read_line_finish_utf8`. Only `new`
source events are acted on (when `this._muted`): reacting to `change` would loop,
because our own `set-source-mute` emits `change` events. See
[docs/ADR/0004](docs/ADR/0004-hotplug-via-pactl-subscribe.md).

## gnome-settings-daemon mic-mute override

The stock `org.gnome.settings-daemon.plugins.media-keys mic-mute` shortcut (an
`as` key on the active schema; the `s` variant belongs to the separate
`…media-keys.deprecated` schema) is bound to the same default combo and only
mutes the default source. When `manage-gsd-mic-mute` is on, `enable()` saves the
current value into our own `saved-gsd-mic-mute` key, clears the stock one, and
sets `gsd-mic-mute-overridden`; `disable()` restores it. State lives in our own
gsettings so it survives shell restarts and keeps save/restore balanced. See
[docs/ADR/0005](docs/ADR/0005-manage-gsd-mic-mute.md).

## Known API differences across versions

| Aspect                       | GNOME 45-48                                  | GNOME 49-50                          |
| ---------------------------- | -------------------------------------------- | ------------------------------------ |
| OSD manager call             | `show(monitorIndex, icon, label, level, max)`, `-1` = all monitors | `showAll(icon, label, level, max)` |

Selected by `typeof Main.osdWindowManager.showAll === 'function'`. Verified by
reading `js/ui/osdWindow.js` and `js/ui/status/volume.js` on the `gnome-45` …
`gnome-50` branches.

## Procedure: verify against a GNOME version

Upstream sources are checked out locally with `gnome-45` … `gnome-50` branches:

- `~/src/gnome/gnome-shell`
- `~/src/gnome/mutter`

Use `git grep <ref>` without switching the working tree, e.g.:

```sh
cd ~/src/gnome/gnome-shell
for v in 45 46 47 48 49 50; do
  echo "=== gnome-$v ==="
  git grep -nE 'showAll\(|show\(monitorIndex' origin/gnome-$v -- js/ui/osdWindow.js | head
done
git grep -nE 'addKeybinding\(name|removeKeybinding\(name' origin/gnome-45 -- js/ui/windowManager.js
```

## Reloading changed code without re-login (Wayland)

On a Wayland session there is no supported way to reload a changed `extension.js`
for the **same** uuid without logging out. Verified against the local
`gnome-shell` checkout (`js/ui/extensionSystem.js`):

- the shell imports the module by file URI — `import(extensionJs.get_uri())` — and
  sets `extension.isImported = true`; GJS caches ESM modules by URI, so a second
  import of the same path returns the cached code. `disable()`/`enable()` does NOT
  re-import;
- bumping `metadata.json` does not help: `_canLoad` compares the stored version and
  errors with "A different version was loaded previously. You need to log out";
- the D-Bus `ReloadExtension` method is "deprecated and does not work"
  (`js/ui/shellDBus.js`); there is no `FileMonitor` on the extensions directory,
  and `gnome-extensions enable <uuid>` only acts on uuids scanned at shell
  startup, so a freshly created directory is not picked up live.

To test changed code in the running session, load it under a **new uuid**
in-process (the "dev-copy" technique):

1. Make a real copy (NOT a symlink — a symlink may resolve back to the original
   URI and hit the same cache) into a new directory, change `uuid` in its
   `metadata.json`, and keep the same `settings-schema` so it shares the dconf
   state (hotkey, gsd override):

   ```sh
   SRC=~/.local/share/gnome-shell/extensions/mute-all-mics@VitalyOstanin
   DST=~/.local/share/gnome-shell/extensions/mute-all-mics-dev@VitalyOstanin
   rm -rf "$DST"; mkdir -p "$DST/schemas"
   cp "$SRC"/extension.js "$SRC"/prefs.js "$DST"/
   cp "$SRC"/schemas/*.xml "$SRC"/schemas/gschemas.compiled "$DST"/schemas/
   jq '.uuid="mute-all-mics-dev@VitalyOstanin" | .name="Mute All Microphones (dev)"' \
     "$SRC"/metadata.json > "$DST"/metadata.json
   ```

2. `Alt`+`F2` → `lg` → Evaluator → paste **once** (`Gio`, `GLib`, `Main` are in
   the Looking Glass scope). It disables the original (to free the keybinding),
   then creates and loads the new uuid (`2` = `ExtensionType.PER_USER`):

   ```js
   const M = Main.extensionManager; M.disableExtension('mute-all-mics@VitalyOstanin'); const e = M.createExtensionObject('mute-all-mics-dev@VitalyOstanin', Gio.File.new_for_path(GLib.get_home_dir() + '/.local/share/gnome-shell/extensions/mute-all-mics-dev@VitalyOstanin'), 2); M.enableExtension('mute-all-mics-dev@VitalyOstanin'); M.loadExtension(e)
   ```

Caveats:

- Run the snippet once; a second run triggers a second `enable()` and leaves an
  orphan `pactl subscribe` plus a failed re-bind.
- Keybinding bind fails whenever the gsd `mic-mute` key was just changed from a
  non-empty value to `[]` right before `addKeybinding` (gsd releases its grab
  asynchronously). The extension's own startup is safe — on login gsd already
  holds `[]` and `gsd-mic-mute-overridden=true`, so there is no race. When
  switching dev↔canonical in-session, either rely on the 800 ms re-bind net (the
  `cleared=true` path) or pre-set `mic-mute=[]` + `gsd-mic-mute-overridden=true`
  and wait ~2 s before enabling.
- Clean up at the next natural re-login: `gnome-extensions disable
  mute-all-mics-dev@VitalyOstanin && rm -rf "$DST"`, then make sure the canonical
  `mute-all-mics@VitalyOstanin` is enabled — it loads the new code from disk
  itself. Re-login also clears the orphan `pactl subscribe` processes.
- `prefs.js` runs in a separate gjs process per open, so it is NOT URI-cached;
  editing prefs and re-opening the window is enough (no dev-copy needed for it).

## Syntax check and schema

```sh
node --check extension.js
node --check prefs.js
glib-compile-schemas schemas/
```

`node --check` validates ESM syntax without resolving `gi://` imports.

## Manual testing

1. Symlink the repo into `~/.local/share/gnome-shell/extensions/` and compile the
   schema there.
2. Restart GNOME Shell (X11: `Alt+F2`, `r`, Enter; Wayland: re-login, or use the
   dev-copy technique above to load changed code without re-login).
3. `gnome-extensions enable mute-all-mics@VitalyOstanin`.
4. Confirm the start-muted behaviour: right after enabling (or after login), all
   non-`.monitor` sources from `pactl list short sources` should already be
   `Mute: yes` (`pactl get-source-mute <name>`).
5. With at least two microphones present, press the hotkey; confirm it flips
   **all** of them together and that the OSD shows the microphone icon with the
   volume scale. Press again to toggle back.
6. With mute active, connect another microphone (e.g. a Bluetooth headset);
   confirm it comes up muted.
7. Confirm the stock mic-mute was cleared: `gsettings get
   org.gnome.settings-daemon.plugins.media-keys mic-mute` is `@as []` while
   enabled, and restored after `gnome-extensions disable …`.
8. In prefs, click the "Mute hotkey" row, press a new combination, and confirm it
   captures and the new combo works without a shell restart (Backspace clears,
   Escape cancels).
9. Check `journalctl -b /usr/bin/gnome-shell -p warning` for extension errors.

## Files

- `extension.js` — keybinding, all-sources mute via `pactl`, native OSD, hot-plug
  watch, gnome-settings-daemon mic-mute override.
- `prefs.js` — Adwaita preferences: the key-capture hotkey picker and the
  built-in mic-mute override toggle.
- `metadata.json` — uuid, name, description, `shell-version`, `settings-schema`.
- `schemas/` — GSettings schema.
- `docs/ADR/` — architecture decision records.
- `TODO.md` — open tasks (currently none).
