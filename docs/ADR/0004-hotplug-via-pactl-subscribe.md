# 0004 - Hot-plug handling via `pactl subscribe`

## Status

Accepted.

## Context

A microphone connected (or reconnected) while mute is active must come up muted.
That requires reacting to source additions. Options: Gvc `stream-added` signals,
or following `pactl subscribe`. Since muting already goes through `pactl` (see
[0002](0002-mute-via-pactl-not-gvc.md)), staying on one audio tool keeps the
behaviour consistent and avoids depending on Gvc internals.

`pactl subscribe` emits lines such as `Event 'new' on source #62`,
`Event 'change' on source #62`, `Event 'remove' on source #62`. Our own
`set-source-mute` emits `change` events, so reacting to `change` would feed back
into itself.

## Decision

Follow `pactl subscribe` with a long-lived `Gio.Subprocess`, reading stdout line
by line with `Gio.DataInputStream.read_line_finish_utf8`. Act only on `new`
source events, and only while `this._muted`: re-apply mute to all sources. Ignore
`change` and `remove`.

## Consequences

- Hot-plugged and reconnected microphones are muted (they emit `new`).
- No feedback loop, because `change` is ignored.
- A source that some external policy unmutes mid-session (a `change` without a
  `new`) is not re-muted; documented as a limitation.
- The subprocess and its read loop are torn down in `disable()` (the shared
  `Gio.Cancellable` cancels the pending read; the process is `force_exit()`-ed).
