# 0008 - Hotkey config: text field now, picker later

## Status

Superseded by [0009](0009-hotkey-capture-picker.md). The text field was the
initial implementation; the interactive key-capture picker has since replaced it.

## Context

The hotkey must be user-configurable. A GNOME-Settings-style key-capture picker
is the best UX, but libadwaita has no ready-made shortcut row and the
gnome-control-center editor is internal C; extensions reimplement the capture
from GTK4 primitives (`Gtk.EventControllerKey`, `Gtk.accelerator_*`). A working
reference exists (Ubuntu's tiling-assistant `shortcutListener.js`).

The simpler option is a text field where the user types the accelerator, validated
with `Gtk.accelerator_parse`.

## Decision

Ship the text-field option now: an `Adw.EntryRow` with an apply button. On apply,
`Gtk.accelerator_parse` validates the input, a modifier is required (so a bare
letter cannot be bound), the value is normalised with `Gtk.accelerator_name`, and
stored into the `mute-hotkey` `as` key; invalid input reverts the field. Defer the
interactive capture picker (variant C) to [TODO.md](../../TODO.md).

The shortcut is registered with `Main.wm.addKeybinding` against the gsettings key,
so an edit re-binds live without a shell restart.

## Consequences

- Minimal prefs code; the hotkey is configurable immediately.
- Entering an accelerator as text is less discoverable than a capture picker;
  tracked as planned work.
- The schema key is `as` (string list), required by `Main.wm.addKeybinding`, even
  though only one accelerator is stored.
