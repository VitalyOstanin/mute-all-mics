# 0011 - Seed the hotkey from the stock mic-mute on first run

## Status

Accepted.

## Context

The hotkey schema default is `['<Alt>m']`. That is only correct for users whose
GNOME mic-mute shortcut happens to be `<Alt>m`; anyone who had configured a
different mic-mute combo would suddenly have to use `<Alt>m` (a key they never
chose) until they reconfigured the extension. The extension already takes over
GNOME's stock mic-mute, so it knows the combo the user was actually using.

## Decision

On the very first enable, seed `mute-hotkey` from the pre-existing
gnome-settings-daemon `mic-mute` value, then set a `hotkey-initialized` flag so
later sessions never overwrite a user choice:

- `_initHotkeyFromGsd()` runs in `enable()` before `_overrideGsdMicMute()`.
- The original combo is read from `saved-gsd-mic-mute` if a previous session had
  already taken it over (`gsd-mic-mute-overridden` is true), otherwise from the
  live stock key before it is cleared.
- It is copied into `mute-hotkey` only if non-empty; if GNOME had no mic-mute
  shortcut, the schema default (`<Alt>m`) is kept as a usable fallback rather
  than leaving the extension with no shortcut.
- `hotkey-initialized` is set true afterwards; `prefs.js` also sets it whenever
  the user sets or clears the hotkey, so an explicit choice made before the first
  enable is not overwritten.

## Consequences

- Out of the box the extension responds to the same key the user already knew.
- The schema default is now only a fallback for the "no stock shortcut" case.
- One more internal gschema key (`hotkey-initialized`); seeding happens exactly
  once per installation.
