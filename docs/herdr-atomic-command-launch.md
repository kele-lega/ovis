# Companion Herdr atomic command launch

Custom commands need both this Ovis bridge and a running Herdr with an explicit
`ping.capabilities.atomic_command_launch: true`. An Ovis update alone is insufficient.
The normal launch/resume paths remain compatible with older daemons. Native Windows
and the upstream `herdr-core` runtime do not support this custom-command contract and
fail closed; Ovis never falls back to typing into a terminal. Having a `terminal.run`
argv API does not establish atomic worktree creation, no-replay or completed-pane retention.
The supported implementation is the patched Unix Herdr path below. Ping still preserves the
upstream runtime and layout identity; a core runtime does not acquire atomic support merely by
carrying a capability bit. The runtime is not switched to enable this feature.

## Source delivery

`patches/herdr-atomic-command-launch.patch` is a source patch for
[`herdrdev/herdr`](https://github.com/herdrdev/herdr) at exactly
`ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` (the checkout's package version is 0.9.5).
It is not an upstream release, a prebuilt binary, or an automatic installer.
Patch SHA-256: `2f7fa6d0c60642ab526191d7089ed6486073338c49a1436507670dc32063ad86`.
It does not modify Ovis's pinned default Herdr installer or runtime bundle version.

Apply it in a separate development clone at the pinned commit:

```sh
git checkout --detach ee5bfb5041bb3e4a49d591c72308aae3c81ecdde
git apply --check /absolute/path/to/ovis/patches/herdr-atomic-command-launch.patch
git apply /absolute/path/to/ovis/patches/herdr-atomic-command-launch.patch
```

Read that repository's contribution/build instructions first. Native verification here
uses Rust 1.96.1, Zig 0.16.0, just 1.59.0 and cargo-nextest 0.9.151. Use Herdr's
`just` recipes for formatting, linting, tests and builds. The native build does not
require a Windows SDK. Windows cross checks need an independently provisioned SDK;
these instructions do not accept Microsoft's SDK license on anyone's behalf.

Do not replace or restart a production daemon as part of applying or reviewing this
patch. Build/test a disposable session first. Installing the resulting binary and
switching an existing Herdr service are separate operator actions, outside this merge.
Never stop the user's current session to validate it.

## Native verification limits

Native `just lint`, six architecture tests and 62 focused nextest tests passed.
The attempted full native suite stopped at
`tests/api_ping.rs::agent_start_targets_existing_pane_over_socket` (82 tests had passed).
The same compiled test also failed at the same `agent_started` assertion against the
cached, unpatched Herdr 0.9.5 binary, using a disposable config and socket. That establishes
a baseline reproduction, not the root cause or a complete-suite pass. Windows SDK/cross
checks and native macOS companion execution were not performed.

## Contract

Four additive methods use the existing create params flattened together with a required
`command` string:

- `workspace.create_with_command`
- `tab.create_with_command`
- `worktree.create_with_command`
- `worktree.open_with_command`

The command becomes a private creation-time launch policy for the new pane's initial
process. It is not sent with `pane.send_text` or `agent.start`, stored in the saved session,
or replayed on restore. Completed commands retain their pane and output for inspection, including
shell diagnostics for missing executables; they are never automatically respawned. The retention
flag is ephemeral and does not persist the command. The existing methods/params and frozen binary endpoint codecs
are unchanged. The capability is an additive JSON `ping` extension.

The command must be nonblank, single-line, at most 2,000 UTF-16 code units, and contain
no control characters or Unicode line/paragraph separators. Its bytes, including leading
and trailing spaces, are preserved. It is a complete shell command: Ovis appends no
model, permission, effort or first-message arguments. A first message is queued only when the
launched process is safely identified; an ambiguous wrapper leaves it in the client's draft for
an explicit send rather than risking delivery to a replacement agent. Do not put secrets in it.

Ovis checks live daemon support before creation, and checks an authenticated selected
remote bridge's protocol and daemon capability before forwarding a remote command.
Missing/false support fails closed. A creation whose result is uncertain is never retried.
Only the explicit pre-create `linked_worktree_source` refusal permits a single reroute
to the parent source. Opening a worktree that is already open refuses before changing
focus or membership; it never launches into that existing pane.

## Ovis schema and isolated verification

The committed Ovis schema retains its existing baseline and imports only the four new
request variants and their generated parameter definitions. Regenerate TypeScript with
`bun run generate:types`; never edit `shared/herdr-api.generated.ts` by hand.

With a locally built patched binary, run the real wrapper contracts on an isolated test
session from the Ovis checkout:

```sh
OVIS_HERDR_BIN=/absolute/path/to/patched/herdr \
  bun run check run bun test server/atomic-command.contract.test.ts
```

The check runner owns the temporary config/state, session and cleanup. The command above
assumes a release-layout binary. Herdr debug builds use `herdr-dev` instead of `herdr` beneath
`XDG_CONFIG_HOME`; use a separately reviewed disposable-only compatibility wrapper or a release
build rather than linking or changing the operator's real config. Native debug evidence here
used a wrapper that refused non-`/tmp/hwc-*/config` paths, required the check runner's
`.ovis-check-run` file and an explicit `check-*` session, and linked `herdr-dev` to `herdr` only
inside that temporary config. It was not installed as the system binary.

The tests launch
only harmless marker processes in temporary repositories, never real agent CLIs or paid
model calls. They skip rather than touch a default/live socket or assume a missing
capability. The separate fake-socket contracts cover old-daemon rejection, no text-input
fallback, PID-bound first messages, redacted errors and no uncertain-create retries.
