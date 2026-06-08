# 0003 - Native OSD via `Main.osdWindowManager`

## Status

Accepted.

## Context

The OSD must look exactly like GNOME's stock microphone OSD. External callers
cannot trigger it: `org.gnome.Shell.ShowOSD` is guarded by a `DBusSenderChecker`
that allows only `org.gnome.Settings`, `org.gnome.SettingsDaemon.MediaKeys`, and
the GNOME portal (`js/ui/shellDBus.js`). gnome-shell also does not raise the OSD
on an external mute-state change (`js/ui/status/volume.js` `_updateVolume`
updates only the icon, it does not call `showOSD`).

An extension, however, runs in the gnome-shell process and can call
`Main.osdWindowManager` directly, with no sender check.

## Decision

Show the OSD with `Main.osdWindowManager`, using a `Gio.ThemedIcon` with the same
icon names the stock input slider uses
(`microphone-sensitivity-muted-symbolic` / `…-high-symbolic`). Pass `level=null`
so the level bar is hidden and only the icon is shown (`setLevel(null)` sets the
bar invisible, verified on all supported branches).

## Consequences

- The OSD is the genuine one, visually identical to the stock popup.
- The manager method differs across versions and is chosen by capability
  detection (see [0007](0007-support-gnome-45-to-50.md)).
- No level bar is shown; this is a mute toggle, not a volume change.
