# Mute All Microphones

A GNOME Shell extension that makes one hotkey mute (and unmute) **every**
microphone source at once, not just the default one. It shows the native GNOME
microphone OSD, and keeps microphones that are connected while mute is active
muted as well.

## Table of Contents

- [Why](#why)
- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Settings](#settings)
- [Hotkey format](#hotkey-format)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Files](#files)
- [Limitations and plans](#limitations-and-plans)

## Why

GNOME's built-in microphone mute shortcut (and the usual
`pactl set-source-mute @DEFAULT_SOURCE@ toggle` recipes) only affect the default
source. With more than one microphone in the system — for example a built-in mic
plus a Bluetooth headset — pressing mute silences one of them while the others
stay live, so a call (Google Meet, Zoom, etc.) can still pick up audio. There is
no built-in "mute all microphones" feature in PipeWire/WirePlumber or GNOME.

## What it does

- One configurable shortcut toggles mute on all real microphone sources at once
  (monitor sources, i.e. output loopbacks, are left alone).
- All microphones start muted whenever the extension is enabled (including every
  login), so nothing is live until you deliberately unmute.
- Shows the native GNOME microphone OSD (the same popup the volume keys use).
- While mute is active, a microphone that is plugged in or reconnected is muted
  automatically.
- The shortcut is set with an interactive key-capture picker, like the one in
  GNOME Settings (see [Settings](#settings)).
- Disables GNOME's built-in mic-mute shortcut so a single combo does the right
  thing (optional, see [Settings](#settings)).

## Requirements

- GNOME Shell 45-50.
- `pactl` (from `pulseaudio-utils` / `pipewire-pulse`). The extension shells out
  to `pactl` to enumerate and mute sources and to follow device changes.

## Installation

```sh
# Symlink the repo into the local extensions directory
ln -s "$(pwd)/mute-all-mics" \
  ~/.local/share/gnome-shell/extensions/mute-all-mics@VitalyOstanin

# Compile the settings schema
glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/mute-all-mics@VitalyOstanin/schemas/

# Restart GNOME Shell (X11: Alt+F2, r, Enter; Wayland: log out and back in),
# then enable:
gnome-extensions enable mute-all-mics@VitalyOstanin
```

## Settings

Open with `gnome-extensions prefs mute-all-mics@VitalyOstanin`.

| Setting                                                       | Default   | Effect                                                                          |
| ------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| Mute hotkey                                                   | `<Alt>m`  | The shortcut that toggles mute on all microphones. Click to capture, Backspace clears. |
| Disable GNOME's built-in mic-mute while this extension is active | on        | Clear GNOME's stock mic-mute on enable, restore it on disable.                  |

The second option is needed because the stock mic-mute shortcut is bound to the
same default combo (`<Alt>m`) and only mutes the default source; leaving both
bound to one combo is a conflict. The change takes effect the next time the
extension is enabled. If you turn it off, either pick a combo that the stock
shortcut does not use, or clear the stock one yourself:

```sh
gsettings set org.gnome.settings-daemon.plugins.media-keys mic-mute "['']"
```

## Hotkey format

Set the shortcut by clicking the "Mute hotkey" row and pressing the combination,
the same way GNOME Settings captures shortcuts. Backspace clears it (disables the
hotkey), Escape cancels. A plain letter or digit needs a modifier such as Alt,
Ctrl or Super; function and media keys may be used on their own. The value is
stored in GTK accelerator form (for example `<Alt>m`, `<Control><Alt>m`,
`<Super>m`).

## How it works

- The shortcut is registered with `Main.wm.addKeybinding` against the
  extension's own `as` gsettings key, so editing it in prefs re-binds live.
- Muting is done by shelling out to `pactl`: `pactl list short sources` is parsed
  (entries whose name ends in `.monitor` are skipped) and each remaining source
  gets `pactl set-source-mute <name> 1|0`.
- The OSD uses `Main.osdWindowManager` directly. Because the extension runs
  inside the gnome-shell process, this is the genuine OSD and is not subject to
  the D-Bus sender allow-list that blocks `org.gnome.Shell.ShowOSD` for external
  scripts.
- Hot-plug handling follows `pactl subscribe`; on a `new` source event, if mute
  is active, all sources are re-muted.

The rationale for each of these choices is recorded in [docs/ADR](docs/ADR).

## Compatibility

`metadata.json` declares `shell-version` 45 through 50. The OSD call differs
across versions and is selected by capability detection: `showAll(...)` since
GNOME 49, `show(-1, ...)` on GNOME 45-48.

## Files

- `extension.js` — keybinding, all-sources mute via `pactl`, the native OSD, the
  hot-plug watch, and the gnome-settings-daemon mic-mute override.
- `prefs.js` — Adwaita preferences: the key-capture hotkey picker and the
  built-in mic-mute override toggle.
- `metadata.json` — uuid, name, description, `shell-version`, `settings-schema`.
- `schemas/` — GSettings schema for all settings.
- `docs/ADR/` — architecture decision records.
- `TODO.md` — open tasks.

## Limitations and plans

- "Real microphone" is decided by excluding `.monitor` sources; this matches the
  community convention but is a heuristic.
- A microphone reconnected while muted is re-muted on its `new` event; transient
  external `change` events that unmute a source are not mirrored (to avoid
  feedback loops).
