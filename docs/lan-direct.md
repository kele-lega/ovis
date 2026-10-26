# LAN direct session transport

The unified Ovis page and its machine roster stay on the connection server (A). Selected remote
terminals and programmatic session APIs can connect directly to the same bridge on B. Herdr
retains ownership of its existing session, PTYs and history. No second Herdr session is created.

## Quick configuration

Example: the unified page is `https://192.168.1.10:7443` (A), and the remote
machine's direct HTTPS endpoint is `https://192.168.1.20:7443` (B).

1. Deploy this modified backend on both A and B. Keep the existing SSH bridge connection
   and Herdr socket/session; do not create a new session.
2. On A, find B's stable machine ID in the authenticated `GET /api/machines` response.
   Set these variables in A's backend service environment, replacing `<machine-id>`:

   ```sh
   OVIS_DIRECT_ENDPOINTS='{"<machine-id>":"https://192.168.1.20:7443"}'
   OVIS_DIRECT_ORIGINS='https://192.168.1.10:7443'
   ```

3. Set these variables in the existing B bridge process environment:

   ```sh
   OVIS_DIRECT_HOST=127.0.0.1
   OVIS_DIRECT_PORT=17422
   ```

4. Configure B's HTTPS reverse proxy to forward `https://192.168.1.20:7443` to
   `http://127.0.0.1:17422`, including WebSocket upgrades, `Origin` and
   `Sec-WebSocket-Protocol`. Use a browser-trusted certificate matching B's IP or DNS name.
   Keep the normal bridge listener private; do not expose it instead of the ticket-only port.
5. Apply the environment changes through your normal deployment process, then reload A's page
   to obtain the updated CSP. Switching between configured machines does not reload the page.
6. In browser developer tools, select an agent on B and confirm its WebSocket connects to
   `wss://192.168.1.20:7443/ws`. With direct access unavailable, it should fall back to A's
   existing SSH relay. Do not use a write operation to check fallback.

For more machines, add entries to `OVIS_DIRECT_ENDPOINTS` and configure each remote bridge.
To disable direct access, remove A's direct endpoint mapping and reload the page after applying
that configuration. Never put the bridge token in these browser-facing addresses.

## Configuration details

Direct access is opt-in. Existing SSH connections and the UI work unchanged when these variables
are absent. No bridge is exposed or TLS certificate installed automatically.

On A, set `OVIS_DIRECT_ENDPOINTS` to a JSON object mapping the stable machine IDs from
`GET /api/machines` to browser-facing origins, for example:

```json
{"00000000-0000-4000-8000-000000000001":"https://192.168.1.20:7443"}
```

Set `OVIS_DIRECT_ORIGINS` to the exact Ovis page origins allowed to use these endpoints, separated
by commas, for example `https://192.168.1.10:7443`. These are page origins, not WebSocket URLs.
There are no wildcards and no paths. HTTP is accepted only for loopback development/testing.

On B, run this modified backend against the same Herdr socket as the existing bridge, with
`OVIS_DIRECT_PORT` naming an additional ticket-only listener. `OVIS_DIRECT_HOST` defaults to
`127.0.0.1`. A TLS reverse proxy on B should expose that listener at the configured HTTPS origin.
Keep the normal SSH bridge listener private. The additional listener shares the same backend
core; do not start a second backend to implement it.

For an SSH-managed remote bundle, these settings must be present in the bridge process environment
when it starts. Updating this source checkout does not replace an installed remote bundle. For a
separately managed backend, its normal service configuration supplies the variables.

The TLS certificate must be trusted by the browser and contain the destination IP in its SAN, or
use an internal DNS name with a matching certificate. The proxy must forward WebSocket upgrades,
Origin and Sec-WebSocket-Protocol; it must not log credential headers. Do not publish the normal
bridge token or add it to frontend configuration. Browser local-network permission policies may
also require approval depending on the page origin and browser version.

A's app-shell CSP adds only the configured HTTPS and WSS origins to `connect-src`. Changing the
mapping requires reloading the page to receive that policy; switching already-configured machines
does not reload the page or change its origin. Media and embedded file documents remain under the
existing CSP and proxy paths.

## Connection and credential lifecycle

- Each existing MachineSession retains its HerdrSocket object across pane views. Each transport
  connection resolves a fresh endpoint and a fresh one-use WS ticket. PaneCanvas remains keyed by
  machine ID so equal pane IDs on different servers cannot share terminal output or drafts.
- A authenticates the browser through its existing cookie gate, checks the exact page Origin and
  registers an ephemeral Ed25519 public key on B over the authenticated SSH bridge connection.
  Browser-facing addresses come only from administrator configuration, never from request bodies.
- `POST /api/machines/:id/direct-access` returns a 30-second one-use WS ticket and a 60-second HTTP
  bearer token. Both bind issuer, target machine, subject, role and exact page origin. The ticket
  travels in the offered `ovis.ticket.*` subprotocol; B selects only `ovis.v1`. Nothing is placed in
  a URL or browser storage. Browser HTTP credentials stay in memory and do not use cross-site cookies.
- B validates Origin, signature, audience, expiry and replay state before admission. Its dedicated
  ingress only serves the finite session API allowlist. Watching devices remain read-only even if
  they send an interact role frame. Administrative APIs and trust registration are not exposed there.
- A renews each active bridge trust lease every 25 seconds; B closes connections if the lease is not
  renewed within 90 seconds. Device revocation, logout and machine disconnect revoke direct access.
  If a control-path revocation cannot reach B, A stops renewing that lease and expiry fails closed.
- Direct HTTP provides explicit-origin CORS including authorization preflights and ETag/range headers.
  Programmatic chat, file and Git diff requests use the central machine-scoped fetch transport.
  Images, videos, PDF frames and download links that cannot carry bearer headers continue through
  A's existing authenticated file proxy. They never receive a long-lived credential in a URL.
- An unavailable direct route falls back to SSH relay, with a 60-second retry cooldown. Reads may
  retry through A; a write attempted on B is never automatically replayed on A because it may
  already have executed. Disconnected terminal input stays a draft for explicit sending.

The sidebar roster/status SSE and account/device management stay on A. This change follows the
existing Ovis machine/session ownership rather than introducing another UI or session system.
