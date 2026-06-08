# 0002 - Mute via `pactl`, not Gvc

## Status

Accepted.

## Context

Muting all microphones from inside the shell can be done two ways:

1. Natively through `Gvc.MixerControl`: enumerate `get_sources()` and call
   `change_is_muted()` on each. No subprocess, signal-based, idempotent.
2. By shelling out to `pactl`: `pactl list short sources` + `pactl
   set-source-mute`.

The deciding question is which sources count as "microphones". The Gvc path
requires knowing whether `get_sources()` includes monitor sources and how to tell
them apart. The local gnome-shell checkout does not vendor the Gvc C source
(`subprojects/gvc` is not populated), so this behaviour cannot be verified by
reading the source, and the user's workflow values verified facts over
assumptions.

The `pactl` path has a concrete, verified rule on the target system: monitor
sources have names ending in `.monitor`, and excluding them leaves exactly the
real microphones. This is also the established community recipe.

## Decision

Do all muting through `pactl`: parse `pactl list short sources`, skip names
containing `.monitor`, and run `pactl set-source-mute <name> 1|0` for the rest.
Use names, not indices, because names are stable across reconnects.

## Consequences

- Adds a runtime dependency on `pactl` (pulseaudio-utils / pipewire-pulse).
- Spawns short-lived subprocesses per toggle; negligible for a hotkey.
- The "real microphone" decision is a documented heuristic (`.monitor`
  exclusion), not an API guarantee.
- Calls are async (`communicate_utf8_async`) and tied to one `Gio.Cancellable`
  for clean teardown.
