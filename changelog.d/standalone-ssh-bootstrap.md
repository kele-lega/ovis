### Changed
- Ship first-time SSH setup independently of deferred custom Agent launch commands and browser-direct transport.
  Preserve saved custom commands without executing them; reject stale command edits and launches until the page reloads.
