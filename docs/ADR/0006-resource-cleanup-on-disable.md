# 0006 - Resource cleanup on disable

## Status

Accepted.

## Context

GNOME requires extensions to fully undo their effects in `disable()` (called on
lock, restart, and uninstall). This extension holds: a registered keybinding, a
long-lived `pactl subscribe` subprocess with an async read loop, async `pactl`
calls in flight, and an override of an external gsettings key.

## Decision

`disable()` tears everything down, in order:

1. `Main.wm.removeKeybinding(MUTE_HOTKEY_KEY)` (no-op if absent).
2. Stop the hot-plug watch: `force_exit()` the subscribe subprocess and drop the
   stream reference.
3. Cancel the shared `Gio.Cancellable`, which aborts the pending `read_line`
   call and any in-flight `pactl` `communicate_utf8_async`.
4. Restore the stock mic-mute key (reads our settings, so it runs before settings
   are released — see [0005](0005-manage-gsd-mic-mute.md)).
5. Null out `this._muted` and `this._settings`.

A single `Gio.Cancellable` is shared by every async operation so one `cancel()`
covers them all. All async callbacks ignore `Gio.IOErrorEnum.CANCELLED`.

## Consequences

- No leaked subprocess, stream, keybinding, or pending async callback.
- The external mic-mute key is always restored.
- Re-enabling starts from a clean state (`this._muted` resets to `false`).
