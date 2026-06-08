# 0007 - Support GNOME 45-50 by capability detection

## Status

Accepted.

## Context

`metadata.json` declares `shell-version` 45-50. The OSD manager API changed
within that range. Verified by reading the upstream branches:

- GNOME 45-48: `Main.osdWindowManager.show(monitorIndex, icon, label, level,
  maxLevel)`, where `monitorIndex === -1` shows on all monitors
  (`js/ui/status/volume.js` calls `show(-1, gicon, null, level, maxLevel)`).
- GNOME 49-50: `Main.osdWindowManager.showAll(icon, label, level, maxLevel)`.

`Main.wm.addKeybinding` / `removeKeybinding`, `setLevel(null)` hiding the bar, and
the `as` type of the active media-keys `mic-mute` key are stable across the range.

## Decision

Select the OSD call by capability, not by version number:

```js
const mgr = Main.osdWindowManager;
if (typeof mgr.showAll === "function") mgr.showAll(icon, null, null, -1);
else mgr.show(-1, icon, null, null, -1);
```

When adding a new GNOME version: confirm the branch exists, re-verify every
symbol in the CLAUDE.md API table on that branch, add it to `shell-version`, and
record any new difference in an ADR.

## Consequences

- One code path adapts to both OSD APIs without branching on version strings.
- New cross-version differences must be found by the verification procedure in
  CLAUDE.md before bumping `shell-version`.
