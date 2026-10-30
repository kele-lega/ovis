### Changed
- Ship first-time SSH setup independently of deferred custom Agent launch commands and browser-direct transport.
  Preserve saved custom commands without executing them; reject stale command edits and launches until the page reloads.

### Fixed
- Keep remote-PC reconnect retries scheduled when SSH authorization revocation fails.
- Keep guided SSH registrations separate from legacy manual PCs so code rollback cannot drop their strict identity policy.
- Release SSH revocation state after connection construction or cleanup fails, allowing retry without a server restart.
- Refuse first-time Windows SSH setup when the service uses a different executable or custom startup arguments.
- Keep Settings open when a phone command palette's delayed close lands after Settings opens, without consuming the next Back.
