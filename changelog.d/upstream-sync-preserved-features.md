### Changed
- Integrate the upstream 0.5.1 architecture while retaining this fork's SSH-managed browser LAN/Tailscale direct transport, exact atomic custom agent commands, standalone first-time SSH setup and resumable background setup progress.
- Keep native-phone direct and paired relay-PC transports on their upstream paths. Custom command creation still requires the separately delivered patched Unix Herdr; unsupported runtimes fail closed rather than typing into an existing pane.

### Fixed
- Run Vite under Bun explicitly while preserving the upstream build cache, and keep forks on hosted CI runners unless their administrator configures a runner pool.
