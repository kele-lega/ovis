### Changed
- Ship first-time SSH setup independently of deferred custom Agent launch commands and browser-direct transport.
  Preserve saved custom commands without executing them; reject stale command edits and launches until the page reloads.

### Fixed
- Keep remote-PC reconnect retries scheduled when SSH authorization revocation fails.
- Refuse first-time Windows SSH setup when the service uses a different executable or custom startup arguments.
- Keep Settings open when a phone command palette's delayed close lands after Settings opens, without consuming the next Back.
