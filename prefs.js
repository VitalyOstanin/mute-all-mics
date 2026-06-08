// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// An Adw.ActionRow that captures a single keyboard shortcut interactively, like
// the picker in GNOME Settings. Built programmatically (no .ui template) to match
// the rest of these prefs.
//
// _isBindingValid and _isKeyvalForbidden are the GNOME Settings validation rules,
// taken from the night-theme-switcher extension (via tiling-assistant):
// https://gitlab.com/rmnvgr/nightthemeswitcher-gnome-shell-extension
const ShortcutRow = GObject.registerClass(
  class MuteAllMicsShortcutRow extends Adw.ActionRow {
    // Only one row may listen at a time. With a single row this is trivially
    // true, but the guard keeps the key handler correct if more rows are added.
    static _listener = null;

    _init(settings, key, params = {}) {
      super._init(params);

      this._settings = settings;
      this._key = key;
      this._baseSubtitle = this.get_subtitle() ?? "";
      this._listening = false;

      // Current shortcut, shown the same way GNOME Settings shows it.
      this._shortcutLabel = new Gtk.ShortcutLabel({
        valign: Gtk.Align.CENTER,
        disabled_text: "Disabled",
      });

      this._clearButton = new Gtk.Button({
        icon_name: "edit-clear-symbolic",
        valign: Gtk.Align.CENTER,
        has_frame: false,
        tooltip_text: "Clear shortcut (disable)",
      });
      this._clearButton.connect("clicked", () => {
        this._stopListening();
        this._store(null);
      });

      this.add_suffix(this._shortcutLabel);
      this.add_suffix(this._clearButton);
      this.set_activatable(true);
      this.connect("activated", () => this._toggleListening());

      // The key controller lives on the window root and runs in the capture
      // phase so it sees the combination before focused widgets consume it.
      this._keyController = new Gtk.EventControllerKey();
      this._keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
      this._keyController.connect("key-pressed", this._onKeyPressed.bind(this));
      this._controllerRoot = null;
      this.connect("realize", () => {
        const root = this.get_root();
        if (root) {
          root.add_controller(this._keyController);
          this._controllerRoot = root;
        }
      });

      this._syncFromSettings();
      this._settingsChangedId = this._settings.connect(
        `changed::${key}`,
        () => this._syncFromSettings(),
      );
      this.connect("destroy", () => {
        if (this._settingsChangedId) {
          this._settings.disconnect(this._settingsChangedId);
          this._settingsChangedId = 0;
        }
        // Detach the key controller from the window root so it does not outlive
        // the row (the root can outlive the row when the prefs page is rebuilt).
        if (this._controllerRoot) {
          this._controllerRoot.remove_controller(this._keyController);
          this._controllerRoot = null;
        }
        if (ShortcutRow._listener === this) ShortcutRow._listener = null;
      });
    }

    _syncFromSettings() {
      const accels = this._settings.get_strv(this._key);
      const accel = accels.length ? accels[0] : "";
      this._shortcutLabel.set_accelerator(accel);
      this._clearButton.set_sensitive(accel !== "");
    }

    _store(accel) {
      this._settings.set_strv(this._key, accel ? [accel] : []);
      // Mark the hotkey as user-initialised so the first enable() never seeds it
      // from GNOME's stock mic-mute over an explicit choice (incl. clearing).
      this._settings.set_boolean("hotkey-initialized", true);
      // _syncFromSettings runs via the changed:: handler.
    }

    _toggleListening() {
      if (this._listening) this._stopListening();
      else this._startListening();
    }

    _startListening() {
      if (ShortcutRow._listener && ShortcutRow._listener !== this)
        ShortcutRow._listener._stopListening();

      this._listening = true;
      ShortcutRow._listener = this;
      this.add_css_class("accent");
      this.set_subtitle(
        "Press the new shortcut — Esc to cancel, Backspace to clear",
      );
    }

    _stopListening() {
      if (!this._listening) return;
      this._listening = false;
      if (ShortcutRow._listener === this) ShortcutRow._listener = null;
      this.remove_css_class("accent");
      this.set_subtitle(this._baseSubtitle);
    }

    _onKeyPressed(_controller, keyval, keycode, state) {
      if (!this._listening) return Gdk.EVENT_PROPAGATE;

      let mask = state & Gtk.accelerator_get_default_mod_mask();
      mask &= ~Gdk.ModifierType.LOCK_MASK;

      // Without modifiers, Escape cancels and Backspace clears the shortcut.
      if (mask === 0) {
        if (keyval === Gdk.KEY_Escape) {
          this._stopListening();
          return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_BackSpace) {
          this._store(null);
          this._stopListening();
          return Gdk.EVENT_STOP;
        }
      }

      // Ignore modifier-only presses and invalid combinations; keep listening so
      // the user can complete the chord.
      if (
        !this._isBindingValid({ mask, keycode, keyval }) ||
        !Gtk.accelerator_valid(keyval, mask)
      )
        return Gdk.EVENT_STOP;

      const accel = Gtk.accelerator_name_with_keycode(
        null,
        keyval,
        keycode,
        mask,
      );
      this._store(accel);
      this._stopListening();
      return Gdk.EVENT_STOP;
    }

    // A combination is valid unless it is a bare letter/digit/script character
    // (or a forbidden navigation key) with no modifier beyond Shift — those must
    // not become a shortcut because they would swallow ordinary typing.
    _isBindingValid({ mask, keycode, keyval }) {
      if ((mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK) && keycode !== 0) {
        if (
          (keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
          (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
          (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
          (keyval >= Gdk.KEY_kana_fullstop &&
            keyval <= Gdk.KEY_semivoicedsound) ||
          (keyval >= Gdk.KEY_Arabic_comma && keyval <= Gdk.KEY_Arabic_sukun) ||
          (keyval >= Gdk.KEY_Serbian_dje &&
            keyval <= Gdk.KEY_Cyrillic_HARDSIGN) ||
          (keyval >= Gdk.KEY_Greek_ALPHAaccent &&
            keyval <= Gdk.KEY_Greek_omega) ||
          (keyval >= Gdk.KEY_hebrew_doublelowline &&
            keyval <= Gdk.KEY_hebrew_taf) ||
          (keyval >= Gdk.KEY_Thai_kokai && keyval <= Gdk.KEY_Thai_lekkao) ||
          (keyval >= Gdk.KEY_Hangul_Kiyeog &&
            keyval <= Gdk.KEY_Hangul_J_YeorinHieuh) ||
          (keyval === Gdk.KEY_space && mask === 0) ||
          this._isKeyvalForbidden(keyval)
        )
          return false;
      }
      return true;
    }

    _isKeyvalForbidden(keyval) {
      const forbiddenKeyvals = [
        Gdk.KEY_Home,
        Gdk.KEY_Left,
        Gdk.KEY_Up,
        Gdk.KEY_Right,
        Gdk.KEY_Down,
        Gdk.KEY_Page_Up,
        Gdk.KEY_Page_Down,
        Gdk.KEY_End,
        Gdk.KEY_Tab,
        Gdk.KEY_KP_Enter,
        Gdk.KEY_Return,
        Gdk.KEY_Mode_switch,
      ];
      return forbiddenKeyvals.includes(keyval);
    }
  },
);

export default class MuteAllMicsPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();

    this._addHotkeyGroup(page, settings);
    this._addSystemKeyGroup(page, settings);

    window.add(page);
  }

  _addHotkeyGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: "Hotkey",
      description:
        "Keyboard shortcut that toggles mute on all microphones at once. " +
        "Click the row, then press the new shortcut. Press Backspace to clear " +
        "(disable) or Escape to cancel. A plain letter or digit needs a " +
        "modifier such as Alt, Ctrl or Super.",
    });
    page.add(group);

    const row = new ShortcutRow(settings, "mute-hotkey", {
      title: "Mute hotkey",
      subtitle: "Click to set, then press a key combination",
    });
    group.add(row);
  }

  _addSystemKeyGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: "GNOME's built-in microphone mute",
      description:
        "GNOME has its own microphone mute shortcut that mutes only the " +
        "default input. While this is on, the extension disables that " +
        "built-in shortcut so it cannot clash with the hotkey above or mute " +
        "just one microphone; the original shortcut is restored when you turn " +
        "this off or disable the extension. Keep this on when the hotkey above " +
        "is the same combination as GNOME's built-in one. Takes effect the " +
        "next time the extension is enabled.",
    });
    page.add(group);

    const row = new Adw.SwitchRow({
      title: "Disable GNOME's built-in mic-mute while this extension is active",
    });
    settings.bind(
      "manage-gsd-mic-mute",
      row,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(row);
  }
}
