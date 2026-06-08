# 0009 - Hotkey config: interactive key-capture picker

## Status

Accepted. Supersedes [0008](0008-hotkey-config-text-field.md).

## Context

[0008](0008-hotkey-config-text-field.md) shipped the hotkey as a text
`Adw.EntryRow`: usable, but the user must know GTK accelerator syntax and type it
correctly, which is less discoverable than the capture row in GNOME Settings.
libadwaita still has no ready-made shortcut row, but the capture can be built from
GTK4 primitives. A working reference exists in Ubuntu's tiling-assistant
(`src/prefs/shortcutListener.js`), whose validation rules come from the
night-theme-switcher extension.

## Decision

Replace the text entry with an `Adw.ActionRow` subclass that captures a single
shortcut interactively, built programmatically (no `.ui` template, to match the
rest of `prefs.js`):

- a `Gtk.EventControllerKey` is added to the window root in the capture phase on
  `realize`; clicking the row starts listening, and a static guard keeps at most
  one row listening at a time;
- on `key-pressed` the modifier mask is `state & accelerator_get_default_mod_mask()`
  with `LOCK_MASK` stripped; Escape cancels, Backspace clears (disables);
- validity uses the GNOME Settings rule (`_isBindingValid` / `_isKeyvalForbidden`,
  copied from the reference): a bare letter/digit needs a modifier, navigation
  keys are forbidden, otherwise `Gtk.accelerator_valid`;
- the accelerator is serialised with `Gtk.accelerator_name_with_keycode(null,
  keyval, keycode, mask)` (the layout-independent form GNOME Settings stores) and
  written to the `mute-hotkey` `as` key as a single-element list;
- the current value is shown with `Gtk.ShortcutLabel`, and a clear button resets
  it to empty.

Registration is unchanged: `Main.wm.addKeybinding` against the gsettings key, so
an edit re-binds live.

## Consequences

- Discoverable, GNOME-consistent shortcut editing; no need to know accelerator
  syntax.
- More prefs code than the text field, and a dependency on stock GTK4 accelerator
  APIs.
- Only one accelerator is captured and stored, even though the schema key is `as`.
- The validation rules are copied from an external GPL extension; attribution is
  kept in `prefs.js`.
