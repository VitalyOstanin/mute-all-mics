# 0010 - Start muted on enable

## Status

Accepted.

## Context

The original behaviour started the extension unmuted: `_muted` was `false` on
`enable()` and the first hotkey press muted everything. In practice the desired
default is the opposite — after every login the microphones should be off until
the user deliberately turns them on, so nothing is captured by accident during the
window between logging in and joining a call.

## Decision

On `enable()` set `this._muted = true` and call `_applyMuteToAll(true)`, so both
the internal state and the actual sources are muted as soon as the extension
loads (including every login). The hot-plug watch already mutes new sources while
`_muted` is true, so microphones connected during this initial muted state are
covered too.

## Consequences

- Microphones are off by default after login; the first hotkey press unmutes.
- `enable()` runs an extra `pactl` pass at startup.
- `disable()` does not force-unmute; restoring the stock mic-mute key lets the user
  control the inputs again if the extension is turned off while muted.
