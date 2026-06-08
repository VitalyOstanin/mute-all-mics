# 0001 - The extension owns the hotkey (not a script/daemon)

## Status

Accepted.

## Context

The goal is one hotkey that mutes all microphones at once, shows the native GNOME
microphone OSD, and keeps newly connected microphones muted while mute is active.

Alternatives considered:

1. A standalone shell script bound to a GNOME custom shortcut. It can mute all
   sources via `pactl`, but it cannot show the genuine GNOME OSD: that OSD is
   produced by gnome-settings-daemon on the key press, gnome-shell does not raise
   it on an external mute-state change (`js/ui/status/volume.js` `_updateVolume`
   does not call `showOSD`), and `org.gnome.Shell.ShowOSD` is restricted by a
   `DBusSenderChecker` allow-list (`org.gnome.Settings`,
   `org.gnome.SettingsDaemon.MediaKeys`, the GNOME portal). A script also needs a
   separate background daemon for the hot-plug requirement.
2. A systemd user daemon that mirrors the default source's mute to the others.
   Restores the genuine OSD (gsd still handles the key) but adds a separate
   service to install and manage.
3. A GNOME Shell extension that does everything in-process.

## Decision

Implement a GNOME Shell extension that owns the shortcut, mutes all sources,
shows the OSD, and watches for hot-plugged devices. Running inside the
gnome-shell process is what makes the genuine OSD reachable (see
[0003](0003-native-osd-via-osdwindowmanager.md)), and it removes the need for any
external script or service.

## Consequences

- One artifact to install; no script files, no systemd unit, no extra D-Bus
  service.
- The extension must take over the stock mic-mute combo to avoid a conflict (see
  [0005](0005-manage-gsd-mic-mute.md)).
- Subject to the GNOME 45-50 API surface and its cross-version differences.
