# 0012 - Support GNOME 45-51 by capability detection

## Status

Accepted. Supersedes [0007](0007-support-gnome-45-to-50.md).

## Context

GNOME 51 was released. Every symbol in the CLAUDE.md API table was re-checked
against gnome-shell and mutter tags 51.0 and 51.1, and against the
gnome-settings-daemon 51.0 media-keys schema:

- `Main.wm.addKeybinding(name, settings, flags, modes, handler)` and
  `removeKeybinding(name)` are unchanged (`js/ui/windowManager.js`);
- `Main.osdWindowManager.showAll(icon, label, level, maxLevel)` is unchanged
  (`js/ui/osdWindow.js`), so the capability check from ADR 0007 keeps selecting
  it;
- the active media-keys `mic-mute` key is still of type `as`
  (`org.gnome.settings-daemon.plugins.media-keys.gschema.xml.in`).

## Decision

Add `"51"` to `shell-version`. No code change is needed; the OSD call stays
selected by capability.

## Consequences

- One code path still covers 45-51.
- The verification procedure in CLAUDE.md must be re-run for the next GNOME
  release.
