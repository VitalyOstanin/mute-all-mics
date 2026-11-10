# 0013 - Toggle from the actual source state, not an internal flag

## Status

Accepted. Amends the hot-plug criterion of
[0004](0004-hotplug-via-pactl-subscribe.md).

## Context

The hotkey flipped `this._muted` and applied the result to all sources. The flag
was the only record of the state, so any mute change made outside the extension
left it stale. A call client whose mic button runs
`pactl set-source-mute @DEFAULT_SOURCE@ 0` unmuted the default source while the
flag stayed `true`; the next hotkey press then "unmuted" an already live
microphone, and muting took two presses. The same flag decided whether a
hot-plugged microphone was muted, so a microphone connected after such an
external unmute was muted although the others were live.

## Decision

- On every hotkey press read `pactl get-source-mute` for each real source. If
  any of them is unmuted, mute all; only when all are muted, unmute all. The
  flag is used only when no source state can be read.
- On a `new` source event read the state of the other real sources: the new
  source is muted when all of them are muted. Without other microphones the
  last known state (`this._muted`, which still starts `true`, see
  [0010](0010-start-muted-on-enable.md)) decides.
- Run `pactl` with `LC_ALL=C` so `Mute: yes|no` is parsed untranslated.
- `change` events are still ignored, so no feedback loop appears.

## Consequences

- Mute changes made by other programs are honoured: the hotkey always moves
  towards "everything muted" first when any microphone is live.
- A press costs one `pactl get-source-mute` per microphone before muting.
- Hot-plug follows the current state of the other microphones instead of the
  last hotkey press.
