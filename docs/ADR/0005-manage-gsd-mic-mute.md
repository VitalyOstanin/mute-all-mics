# 0005 - Take over the gnome-settings-daemon mic-mute key

## Status

Accepted.

## Context

The default mute combo `<Alt>m` is bound to
`org.gnome.settings-daemon.plugins.media-keys mic-mute`, whose stock handler
mutes only the default source — exactly the behaviour this extension replaces.
Two handlers on one combo is a conflict. The active media-keys schema stores
`mic-mute` as type `as`; the `s` variant in the same file belongs to the separate
`…media-keys.deprecated` schema and is not touched.

The override must be reversible and must survive a shell restart (extensions are
disabled and re-enabled on lock/unlock and restart), without unbalancing
save/restore if the shell crashes.

## Decision

Add a `manage-gsd-mic-mute` boolean (default on). When on, `enable()`:

1. saves the current stock value into our own `saved-gsd-mic-mute` (`as`) key;
2. clears the stock key (`set_strv([])`);
3. sets `gsd-mic-mute-overridden = true`.

`disable()` restores the stock key from `saved-gsd-mic-mute` and clears the flag.
The save/clear is skipped if already overridden, so re-enable does not overwrite
the saved value with the cleared one. All state lives in our own gsettings, so it
persists across restarts and crashes.

## Consequences

- A single combo does the right thing out of the box.
- The extension writes a key outside its own schema; mitigated by save/restore
  and the persistent flag.
- Toggling `manage-gsd-mic-mute` in prefs takes effect on the next enable, not
  immediately; documented.
- The media-keys schema is looked up defensively; if absent the override is
  skipped and the rest still works.
