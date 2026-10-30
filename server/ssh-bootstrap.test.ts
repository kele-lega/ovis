import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootstrapError, BOOTSTRAP_TTL_MS, bootstrapCommand, bootstrapRequest, resolveBootstrapPeer, revokeBootstrap, SshBootstrap, tailnetIP, verifyBootstrapAsset, type BootstrapDependencies, type BootstrapMetadata } from "./ssh-bootstrap.ts";
import { BOOTSTRAP_ASSETS } from "./bootstrap-assets.ts";
import { MachineManager } from "./machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { PushService } from "./push.ts";
import { CompletionTracker } from "./completion.ts";
import { SshConnection } from "./ssh.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function root() { const dir = mkdtempSync(join(tmpdir(), "ovis-bootstrap-unit-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function status(patch: Record<string, unknown> = {}) { return JSON.stringify({ BackendState: "Running", Self: { ID: "self", UserID: 9007199254740993n.toString(), TailscaleIPs: ["100.70.1.1", "fd7a:115c:a1e0::1"] }, Peer: { peer: { ID: "peer", UserID: "9007199254740993", OS: "linux", TailscaleIPs: ["100.70.1.2"], Online: true, ...patch } } }); }
const request = { peer_id: "peer", username: "alice" };
const key = (id: string) => `ssh-ed25519 ${"A".repeat(68)} ovis:${id}`;
const dependencies = (extra: BootstrapDependencies = {}): BootstrapDependencies => ({ readStatus: async () => status(), verifyAsset: async () => {}, keygen: async (path, id) => { writeFileSync(path, "FIXTURE_PRIVATE", { mode: 0o600 }); writeFileSync(path + ".pub", key(id)); }, ...extra });
function service(extra: BootstrapDependencies = {}) { const result = new SshBootstrap(root(), dependencies(extra)); cleanup.push(() => result.stop()); return result; }

describe("bootstrap authority and pinned assets", () => {
  it("accepts only single Tailnet literals", () => {
    for (const ip of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) expect(tailnetIP(ip)).toBe(true);
    for (const ip of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "fd7a:115c:a1e1::1", "fd7a:115c:a1e0::1%eth0", "100.70.1.1/32", "100.70.1.1,100.70.1.2"]) expect(tailnetIP(ip)).toBe(false);
  });
  it("derives same-owner online target OS and matching Self IP afresh", () => {
    expect(resolveBootstrapPeer(status(), request)).toEqual({ target: { destination: "alice@100.70.1.2", port: 22 }, sourceIP: "100.70.1.1", os: "linux" });
    for (const patch of [{ Online: false }, { UserID: "other" }, { Tags: ["tag:server"] }, { ShareeNode: true }, { OS: "ios" }, { TailscaleIPs: ["192.168.1.2"] }]) expect(() => resolveBootstrapPeer(status(patch), request)).toThrow();
    expect(resolveBootstrapPeer(status({ OS: "windows", TailscaleIPs: ["fd7a:115c:a1e0::2"] }), request).sourceIP).toBe("fd7a:115c:a1e0::1");
    expect(() => resolveBootstrapPeer(status().replace('"fd7a:115c:a1e0::1"', '"::1"'), request)).not.toThrow();
  });
  it("refuses browser host OS source identity and unsafe usernames", () => {
    for (const value of [null, [], {}, { ...request, host: "127.0.0.1" }, { ...request, os: "windows" }, { ...request, source_ip: "100.64.1.1" }, { ...request, identity_file: "/key" }, { ...request, username: "-oProxyCommand=bad" }, { ...request, username: "a\\b" }, { ...request, session: "bad session" }]) expect(() => bootstrapRequest(value)).toThrow();
  });
  it("Windows owner command permits the local shared-admin consent prompt", () => {
    const command = bootstrapCommand(BOOTSTRAP_ASSETS.windows, { id: "fixture", machine_id: "fixture", target: { destination: "alice@100.70.1.2", port: 22 }, os: "windows", expires_at: Date.now() + BOOTSTRAP_TTL_MS, public_key: key("fixture"), source_ip: "100.70.1.1" }, "alice");
    expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File");
    expect(command).not.toContain("-NonInteractive");
  });
  it("uses the shared PowerShell literal rules when constructing owner commands", () => {
    const attempt = { id: "fixture", machine_id: "fixture", target: { destination: "alice@100.70.1.2", port: 22 }, os: "windows" as const, expires_at: Date.now() + BOOTSTRAP_TTL_MS, public_key: key("fixture"), source_ip: "100.70.1.1" };
    const quoted = bootstrapCommand(BOOTSTRAP_ASSETS.windows, attempt, "o’brien");
    expect(quoted).toContain("-User 'o’’brien'");
    expect(() => bootstrapCommand(BOOTSTRAP_ASSETS.windows, attempt, "alice\ncommand")).toThrow("Invalid characters");
  });
  it("checks release bytes, bounded redirects and success-only cache", async () => {
    const text = "fixture release asset\n";
    const asset = { url: BOOTSTRAP_ASSETS.linux.url, sha256: createHash("sha256").update(text).digest("hex") };
    let calls = 0;
    const fetcher = (async (url: string) => { calls++; return url === asset.url ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture" } }) : new Response(text); }) as unknown as typeof fetch;
    await verifyBootstrapAsset(asset, undefined, fetcher); await verifyBootstrapAsset(asset, undefined, fetcher); expect(calls).toBe(2);
    const fresh = { ...asset, sha256: "b".repeat(64) };
    await expect(verifyBootstrapAsset(fresh, undefined, (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })) as unknown as typeof fetch)).rejects.toMatchObject({ code: "bootstrap_unavailable" });
    await expect(verifyBootstrapAsset(fresh, undefined, (async () => new Response("x".repeat(1024 * 1024 + 1))) as unknown as typeof fetch)).rejects.toBeInstanceOf(BootstrapError);
    await expect(verifyBootstrapAsset({ ...asset, url: "https://attacker.test/asset" }, undefined, fetcher)).rejects.toMatchObject({ code: "bootstrap_unavailable" });
    await expect(verifyBootstrapAsset(fresh, undefined, (async () => new Response(text)) as unknown as typeof fetch)).rejects.toMatchObject({ code: "bootstrap_unavailable" });
  });
});

describe("isolated pending credentials", () => {
  it("availability fails before credentials; public response has no private material", async () => {
    let generated = 0;
    const unavailable = service({ verifyAsset: async () => { throw new Error("SECRET_URL_FAILURE"); }, keygen: async () => { generated++; } });
    await expect(unavailable.create(request, [])).rejects.toMatchObject({ code: "bootstrap_unavailable" }); expect(generated).toBe(0);
    const pending = service(); const attempt = await pending.create(request, []);
    expect(JSON.stringify(attempt)).not.toContain("FIXTURE_PRIVATE"); expect(attempt.command).toContain("--target '100.70.1.2'");
    expect(attempt.cleanup_command).toContain("--remove"); expect(attempt.command).not.toContain("callback");
    const lease = pending.begin(attempt.id); expect(lstatSync(lease.keyPath).mode & 0o777).toBe(0o600);
    pending.finish(attempt.id, false); expect(pending.begin(attempt.id).keyPath).toBe(lease.keyPath); pending.finish(attempt.id, false);
    await pending.cancel(attempt.id); expect(existsSync(lease.keyPath)).toBe(false);
  });
  it("counts all four generation-in-progress attempts and rejects the fifth", async () => {
    const wait = Promise.withResolvers<string>(); const pending = service({ readStatus: () => wait.promise });
    const tasks = Array.from({ length: 4 }, () => pending.create(request, []));
    await expect(pending.create(request, [])).rejects.toMatchObject({ code: "bootstrap_limit" });
    wait.resolve(status()); const attempts = await Promise.all(tasks); expect(new Set(attempts.map((a) => a.machine_id)).size).toBe(4);
  });
  it("expiry cancels only pending state; active jobs finish before deletion", async () => {
    let now = Date.now(); const pending = service({ now: () => now }); const attempt = await pending.create(request, []); const lease = pending.begin(attempt.id);
    const done = Promise.withResolvers<void>(); let cancelled = false;
    pending.running(attempt.id, { cancel: () => { cancelled = true; }, finished: done.promise });
    const cancelling = pending.cancel(attempt.id); expect(cancelled).toBe(true); expect(existsSync(lease.keyPath)).toBe(true);
    done.resolve(); await cancelling; expect(existsSync(lease.keyPath)).toBe(false);
    const next = await pending.create(request, []); now += BOOTSTRAP_TTL_MS + 1;
    expect(() => pending.begin(next.id)).toThrow();
  });
  it("abort waits for keygen exit and never publishes a late key", async () => {
    const started = Promise.withResolvers<void>(); const pending = service({ keygen: async (path, id, signal) => { started.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => { writeFileSync(path, "late"); writeFileSync(path + ".pub", key(id)); resolve(); }, { once: true })); } });
    const abort = new AbortController(); const creating = pending.create(request, [], abort.signal); await started.promise; abort.abort();
    await expect(creating).rejects.toMatchObject({ code: "bootstrap_expired" }); expect(readdirSync(join(pending.stateDir, "ssh-bootstrap-pending"))).toEqual([]);
  });
  it("restart cleans dedicated stale directories but never follows symlinks", () => {
    const dir = root(); const external = root(); writeFileSync(join(external, "keep"), "keep");
    mkdirSync(join(dir, "ssh-bootstrap-pending")); mkdirSync(join(dir, "ssh-bootstrap-pending", "attempt-abc"));
    symlinkSync(external, join(dir, "ssh-bootstrap-pending", "attempt-linked"));
    const pending = new SshBootstrap(dir); cleanup.push(() => pending.stop());
    expect(existsSync(join(dir, "ssh-bootstrap-pending", "attempt-abc"))).toBe(false); expect(readFileSync(join(external, "keep"), "utf8")).toBe("keep");
  });
  it("unknown metadata versions preserve bytes and refuse writes", async () => {
    const dir = root(); const bytes = '{"version":99,"registrations":{"future":"data"}}'; writeFileSync(join(dir, "bootstrap-registrations.json"), bytes);
    expect(() => new SshBootstrap(dir)).toThrow("registrations and credentials were preserved");
    expect(readFileSync(join(dir, "bootstrap-registrations.json"), "utf8")).toBe(bytes);
  });
});

describe("normal setup integration with a reserved bootstrap identity", () => {
  function fixture() {
    const dir = root(); const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); }, { bootstrap: dependencies() }); cleanup.push(() => manager.stop());
    const start = spyOn(SshConnection.prototype, "start").mockResolvedValue(); cleanup.push(() => start.mockRestore());
    const internals = manager as unknown as { prepare(runtime: unknown, job: unknown): Promise<void>; observe(runtime: unknown): Promise<void>; jobs: Map<string, { finished: Promise<void> }>; machines: Map<string, { ssh: SshConnection }> };
    const prepare = spyOn(internals, "prepare").mockResolvedValue(); cleanup.push(() => prepare.mockRestore());
    const observe = spyOn(internals, "observe").mockResolvedValue(); cleanup.push(() => observe.mockRestore());
    return { dir, manager, internals, start, prepare, observe };
  }
  it("does not autoconnect; connects/persists/promotes the same key and updates live path", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request); expect(f.start).not.toHaveBeenCalled(); expect(f.manager.list()).toHaveLength(1);
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished; expect(job.phase).toBe("connected"); expect(job.machine_id).toBe(attempt.machine_id);
    const machine = f.manager.list()[1]!; expect(machine.can_revoke_bootstrap).toBe(true);
    expect(readFileSync(join(f.dir, "ssh", machine.id), "utf8")).toBe("FIXTURE_PRIVATE");
    expect(f.internals.machines.get(machine.id)!.ssh.keyPath).toBe(join(f.dir, "ssh", machine.id));
    expect(f.internals.machines.get(machine.id)!.ssh.exclusiveIdentity).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, "machines.json"), "utf8"))).toEqual([]);
    const stored = JSON.parse(readFileSync(join(f.dir, "bootstrap-machines.json"), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.machines[0].id).toBe(machine.id);
    expect(readdirSync(join(f.dir, "ssh-bootstrap-pending"))).toEqual([]);
  });
  it("publishes first-install progress without registering or persisting the PC", async () => {
    const f = fixture();
    const attempt = await f.manager.createBootstrap({ ...request, name: "Fixture PC" });
    const installing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const internal = f.manager as unknown as {
      stage(job: unknown, phase: string, step: string): void;
      progress(job: unknown, stage: string, done: number, total: number): void;
    };
    f.prepare.mockImplementation(async (_runtime, job) => {
      internal.stage(job, "installing", "Installing fixture bundle…");
      internal.progress(job, "download", 50, 100);
      installing.resolve();
      await finish.promise;
    });
    const job = f.manager.connectBootstrap(attempt.id);
    await installing.promise;
    const events: unknown[] = [];
    const unsubscribe = f.manager.subscribe((event) => events.push(structuredClone(event)));
    expect(events).toContainEqual({ type: "machine-setups", setups: [{
      id: job.id, machine_id: attempt.machine_id, name: "Fixture PC", phase: "installing",
      step: "Installing fixture bundle…", error: null, progress: expect.objectContaining({ stage: "download", done: 50, total: 100 }),
    }] });
    const controller = new AbortController();
    const response = await handleMachineRequest(new Request("http://localhost/api/machines/events", { signal: controller.signal }), f.manager);
    const reader = response.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      const second = new TextDecoder().decode((await reader.read()).value);
      const frames = first + second;
      expect(frames).toContain('"type":"machine-setups"');
      expect(frames).toContain('"name":"Fixture PC"');
      for (const secret of ["FIXTURE_PRIVATE", "ssh-ed25519", "source_ip", "challenge", "ssh_output"]) expect(frames).not.toContain(secret);
    } finally { controller.abort(); await reader.cancel(); }
    expect(f.manager.list()).toHaveLength(1);
    expect(existsSync(join(f.dir, "machines.json"))).toBe(false);
    expect(existsSync(join(f.dir, "bootstrap-machines.json"))).toBe(false);
    finish.resolve();
    await f.internals.jobs.get(job.id)!.finished;
    expect(job.phase).toBe("connected");
    expect(events.at(-1)).toEqual({ type: "machine-setups", setups: [] });
    unsubscribe();
  });
  it("keeps a failed background install visible until dismissed, without registering it", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const internal = f.manager as unknown as { stage(job: unknown, phase: string, step: string): void };
    f.prepare.mockImplementation(async (_runtime, job) => {
      internal.stage(job, "installing", "Installing fixture bundle…");
      throw new Error("fixture install failed");
    });
    const job = f.manager.connectBootstrap(attempt.id);
    await f.internals.jobs.get(job.id)!.finished;
    const events: unknown[] = [];
    const unsubscribe = f.manager.subscribe((event) => events.push(structuredClone(event)));
    expect(events.at(-1)).toEqual({ type: "machine-setups", setups: [expect.objectContaining({ id: job.id, phase: "failed", error: "fixture install failed" })] });
    expect(f.manager.list()).toHaveLength(1);
    f.manager.action(job.id, { action: "cancel" });
    expect(events.at(-1)).toEqual({ type: "machine-setups", setups: [] });
    expect(f.manager.bootstrapAttempt(attempt.id).machine_id).toBe(attempt.machine_id);
    unsubscribe();
  });
  it("shows manual first-install tasks too, then removes them on cancellation", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<void>();
    const internal = f.manager as unknown as { stage(job: unknown, phase: string, step: string): void };
    f.prepare.mockImplementation(async (_runtime, job) => {
      internal.stage(job, "installing", "Installing fixture bundle…");
      ready.resolve();
      await new Promise<void>((resolve) => (job as { abort: AbortController }).abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const job = f.manager.setup({ destination: "fixture-alias", name: "Manual fixture" });
    await ready.promise;
    expect(f.manager.setupSummaries()).toMatchObject([{ id: job.id, name: "Manual fixture", phase: "installing" }]);
    expect(f.manager.list()).toHaveLength(1);
    f.manager.action(job.id, { action: "cancel" });
    await f.internals.jobs.get(job.id)!.finished;
    expect(f.manager.setupSummaries()).toEqual([]);
    expect(f.manager.list()).toHaveLength(1);
  });
  it("does not publish authentication or approval as an unattended installation", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const ready = Promise.withResolvers<void>();
    const internal = f.manager as unknown as { stage(job: unknown, phase: string, step: string): void };
    f.prepare.mockImplementation(async (_runtime, job) => {
      internal.stage(job, "approval", "Review the changes on this PC");
      ready.resolve();
      await new Promise<void>((resolve) => (job as { abort: AbortController }).abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    f.manager.connectBootstrap(attempt.id); await ready.promise;
    expect(f.manager.setupSummaries()).toEqual([]);
    await f.manager.cancelBootstrap(attempt.id);
    expect(f.manager.setupSummaries()).toEqual([]);
  });
  it("does not label an ordinary registered-PC reconnect as a bridge update", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const first = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(first.id)!.finished;
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.start.mockImplementationOnce(async () => { ready.resolve(); await finish.promise; });
    const job = f.manager.setup({ ...attempt.target, machine_id: attempt.machine_id });
    await ready.promise;
    expect(job.phase).toBe("connecting");
    expect(f.manager.list().find((machine) => machine.id === attempt.machine_id)?.updating ?? null).toBeNull();
    expect(f.manager.setupSummaries()).toEqual([]);
    f.manager.action(job.id, { action: "cancel" }); finish.resolve();
    await f.internals.jobs.get(job.id)!.finished;
  });
  it("failed observation leaves no registration; retry keeps UUID/key", async () => {
    const f = fixture(); f.observe.mockRejectedValueOnce(new Error("fixture failure")); const attempt = await f.manager.createBootstrap(request);
    const failed = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(failed.id)!.finished; expect(failed.phase).toBe("failed"); expect(f.manager.list()).toHaveLength(1);
    expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(false);
    const retry = f.manager.connectBootstrap(attempt.id, true); await f.internals.jobs.get(retry.id)!.finished; expect(retry.phase).toBe("connected"); expect(retry.machine_id).toBe(failed.machine_id);
  });
  it("post-commit notification failure preserves the registered strict identity", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const unsubscribe = f.manager.subscribe((event) => { if (event.type === "machines" && event.machines.some((machine) => machine.id === attempt.machine_id)) throw new Error("fixture listener failure"); });
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished; unsubscribe();
    expect(job.phase).toBe("connected");
    await f.manager.cancelBootstrap(attempt.id);
    expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(true);
    const records = JSON.parse(readFileSync(join(f.dir, "bootstrap-registrations.json"), "utf8"));
    expect(records.registrations[attempt.machine_id].username).toBe("alice");
    expect(JSON.parse(readFileSync(join(f.dir, "machines.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.dir, "bootstrap-machines.json"), "utf8")).machines[0].id).toBe(attempt.machine_id);
  });
  it("profile persistence failure cannot leave a row that falls back to ambient SSH", async () => {
    const f = fixture();
    const state = (f.manager as unknown as { profileState: { flush(): void } }).profileState;
    const flush = spyOn(state, "flush").mockImplementation(() => { throw new Error("fixture profile persistence failure"); }); cleanup.push(() => flush.mockRestore());
    const attempt = await f.manager.createBootstrap(request);
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    expect(job.phase).toBe("failed");
    expect(f.manager.list()).toHaveLength(1);
    expect(existsSync(join(f.dir, "machines.json"))).toBe(false);
    expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(false);
    flush.mockRestore();
    const retry = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(retry.id)!.finished;
    expect(retry.phase).toBe("connected");
    expect(retry.machine_id).toBe(attempt.machine_id);
  });
  it("cancels an active setup before deleting only its pending key", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    f.prepare.mockImplementation(async (_runtime, job) => { await new Promise<void>((resolve) => (job as { abort: AbortController }).abort.signal.addEventListener("abort", () => resolve(), { once: true })); });
    const job = f.manager.connectBootstrap(attempt.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.manager.cancelBootstrap(attempt.id);
    expect(job.phase).toBe("cancelled"); expect(f.manager.list()).toHaveLength(1); expect(readdirSync(join(f.dir, "ssh-bootstrap-pending"))).toEqual([]);
  });
  it("strict metadata survives restart, rejects redirects, and remote revoke failure keeps local state", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request); const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    f.manager.patch(attempt.machine_id, { enabled: false }); f.manager.stop();
    const restored = new MachineManager(f.dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); }); cleanup.push(() => restored.stop());
    expect(restored.list()[1]!.can_revoke_bootstrap).toBe(true);
    expect(() => restored.setup({ destination: "alice@100.70.9.9", port: 22, machine_id: attempt.machine_id })).toThrow("cannot be changed");
    const run = spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("fixture permission denied")); cleanup.push(() => run.mockRestore());
    await expect(restored.revokeBootstrap(attempt.machine_id)).rejects.toMatchObject({ code: "bootstrap_revoke_failed" });
    expect(restored.list()[1]!.can_revoke_bootstrap).toBe(true); expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(true);
    run.mockResolvedValue("ovis-bootstrap-revoked"); await restored.revokeBootstrap(attempt.machine_id);
    expect(restored.list()[1]!.can_revoke_bootstrap).toBe(false); expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(true);
  });
  it("keeps reconnect scheduling when a retry meets an in-flight revocation", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    const internal = f.manager as unknown as {
      machines: Map<string, { machine: { state: string }; retry?: ReturnType<typeof setTimeout>; triedAt?: number }>;
      disconnect(runtime: unknown): void;
      retryLater(runtime: unknown): void;
      reconnect(runtime: unknown): Promise<void>;
    };
    const runtime = internal.machines.get(attempt.machine_id)!;
    internal.disconnect(runtime); internal.retryLater(runtime); runtime.triedAt = -100_000;
    const release = Promise.withResolvers<void>();
    f.start.mockImplementationOnce(async () => { await release.promise; throw new Error("fixture offline"); });
    const revoking = f.manager.revokeBootstrap(attempt.machine_id).catch((error: unknown) => error);
    const waiting = runtime.retry;
    f.manager.retryNow(attempt.machine_id);
    const demandedRetry = runtime.retry;
    clearTimeout(runtime.retry); runtime.retry = undefined;
    await internal.reconnect(runtime);
    const automaticRetry = runtime.retry;
    release.resolve();
    expect(await revoking).toMatchObject({ code: "bootstrap_revoke_failed" });
    expect(demandedRetry).toBe(waiting);
    expect(automaticRetry).toBeDefined();
    expect(runtime.machine.state).toBe("reconnecting");
    expect(runtime.retry).toBeDefined();
    expect(f.manager.list()[1]!.can_revoke_bootstrap).toBe(true);
  });
  it("keeps guided rows out of legacy storage across ordinary saves and restarts", async () => {
    const f = fixture();
    const manual = f.manager.setup({ destination: "manual-alias", name: "Manual PC" }); await f.internals.jobs.get(manual.id)!.finished;
    const attempt = await f.manager.createBootstrap(request); const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    f.manager.patch(attempt.machine_id, { enabled: false, name: "Guided PC" });
    f.manager.patch(manual.machine_id, { enabled: false }); f.manager.stop();
    const legacy = JSON.parse(readFileSync(join(f.dir, "machines.json"), "utf8"));
    expect(legacy.map((row: { id: string }) => row.id)).toEqual([manual.machine_id]);
    const restored = new MachineManager(f.dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); }); cleanup.push(() => restored.stop());
    expect(restored.list().find((machine) => machine.id === attempt.machine_id)).toMatchObject({ name: "Guided PC", can_revoke_bootstrap: true });
    expect(restored.list().find((machine) => machine.id === manual.machine_id)?.target?.destination).toBe("manual-alias");
    restored.remove(attempt.machine_id);
    expect(JSON.parse(readFileSync(join(f.dir, "bootstrap-machines.json"), "utf8")).machines).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.dir, "machines.json"), "utf8"))).toEqual(legacy);
  });
  it("refuses unsupported or unprotected guided rows without rewriting either store", () => {
    for (const document of [{ version: 99, machines: [] }, { version: 1, machines: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Unprotected", target: { destination: "alice@100.70.1.2", port: 22 }, enabled: true }] }]) {
      const dir = root(), path = join(dir, "bootstrap-machines.json"), bytes = JSON.stringify(document);
      writeFileSync(path, bytes);
      expect(() => new MachineManager(dir, {} as PushService, new CompletionTracker(null))).toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(existsSync(join(dir, "machines.json"))).toBe(false);
    }
  });
  it("rolls back a guided identity when the protected row cannot commit", async () => {
    const f = fixture(), path = join(f.dir, "bootstrap-machines.json");
    mkdirSync(path);
    const attempt = await f.manager.createBootstrap(request), job = f.manager.connectBootstrap(attempt.id);
    await f.internals.jobs.get(job.id)!.finished;
    expect(job.phase).toBe("failed");
    expect(JSON.parse(readFileSync(join(f.dir, "machines.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(f.dir, "ssh", attempt.machine_id))).toBe(false);
    expect(f.manager.list()).toHaveLength(1);
    rmSync(path, { recursive: true });
    const retry = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(retry.id)!.finished;
    expect(retry.phase).toBe("connected");
    expect(retry.machine_id).toBe(attempt.machine_id);
  });
  it("releases revocation state when the connection constructor fails", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    const path = join(f.dir, "ssh"); renameSync(path, path + ".saved"); writeFileSync(path, "fixture blocker");
    try { await expect(f.manager.revokeBootstrap(attempt.machine_id)).rejects.toMatchObject({ code: "bootstrap_revoke_failed" }); }
    finally { unlinkSync(path); renameSync(path + ".saved", path); }
    expect((f.manager as unknown as { revoking: Set<string> }).revoking.has(attempt.machine_id)).toBe(false);
    const run = spyOn(SshConnection.prototype, "run").mockResolvedValue("ovis-bootstrap-revoked"); cleanup.push(() => run.mockRestore());
    await f.manager.revokeBootstrap(attempt.machine_id);
    expect(f.manager.list()[1]!.can_revoke_bootstrap).toBe(false);
  });
  it("releases revocation state even when closing the connection throws", async () => {
    const f = fixture(); const attempt = await f.manager.createBootstrap(request);
    const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    const run = spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("fixture revoke failure")); cleanup.push(() => run.mockRestore());
    const close = spyOn(SshConnection.prototype, "close").mockImplementationOnce(() => { throw new Error("fixture close failure"); }); cleanup.push(() => close.mockRestore());
    await expect(f.manager.revokeBootstrap(attempt.machine_id)).rejects.toThrow();
    expect((f.manager as unknown as { revoking: Set<string> }).revoking.has(attempt.machine_id)).toBe(false);
  });
  it("refuses secret challenges even when an SSH double attempts one", async () => {
    const f = fixture(); f.start.mockImplementation(async (challenge) => { await challenge!("Password:", false); });
    const attempt = await f.manager.createBootstrap(request); const job = f.manager.connectBootstrap(attempt.id); await f.internals.jobs.get(job.id)!.finished;
    expect(job.phase).toBe("failed"); expect(job.challenge).toBeNull(); expect(f.prepare).not.toHaveBeenCalled();
  });
});

it("exclusive identity bypasses config and all alternate authentication without changing manual SSH", () => {
  const dir = root(), path = join(dir, "key"); writeFileSync(path, "fixture");
  const strict = new SshConnection({ destination: "alice@100.70.1.2", port: 22 }, dir, path, true, false, true);
  const manual = new SshConnection({ destination: "my-alias" }, dir);
  const options = (ssh: SshConnection) => (ssh as unknown as { options(): string[] }).options();
  try { const args = options(strict); expect(args).toContain("none"); expect(args).toContain("PreferredAuthentications=publickey"); expect(args).toContain("PasswordAuthentication=no"); expect(args.filter((arg) => arg === "-i")).toHaveLength(1); expect(options(manual)).not.toContain("-F"); }
  finally { strict.close(); manual.close(); }
});

it("exclusive multiplexed follow-up commands pin Ovis host trust even without a master", async () => {
  const dir = root(), path = join(dir, "key"); writeFileSync(path, "fixture");
  const ssh = new SshConnection({ destination: "alice@100.70.1.2", port: 22 }, dir, path, true, true, true);
  const calls: string[][] = [];
  const internal = ssh as unknown as { exec(args: string[]): Promise<string> };
  const exec = spyOn(internal, "exec").mockImplementation(async (args) => { calls.push(args); return ""; });
  try {
    await ssh.run("true"); await ssh.runPowerShell("Write-Output ok"); await ssh.upload("/tmp/fixture", "C:\\fixture");
    for (const args of calls) {
      const trust = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
      expect(trust).toContain(join(dir, "known_hosts"));
      expect(trust).not.toContain("known_hosts2");
      expect(args).toContain("StrictHostKeyChecking=yes");
    }
  } finally { exec.mockRestore(); ssh.close(); }
});

it("revocation uses exact source/key/account and Windows firewall preflight before key removal", async () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; const metadata: BootstrapMetadata = { publicKey: key(id), sourceIP: "100.70.1.1", username: "alice", os: "linux", target: { destination: "alice@100.70.1.2", port: 22 } };
  let script = ""; const ssh = { run: async (text: string) => { script = text; return ""; }, runPowerShell: async (text: string) => { script = text; return ""; } };
  await revokeBootstrap(ssh, id, metadata, false); expect(script).toContain('from="100.70.1.1",no-agent-forwarding,no-X11-forwarding,no-pty ' + key(id)); expect(script).toContain('"$(id -un)"'); expect(script).not.toContain("grep");
  await revokeBootstrap(ssh, id, { ...metadata, os: "windows" }, true); expect(script.indexOf("Elevated SSH is required")).toBeLessThan(script.indexOf("ReadToEnd")); expect(script).toContain(`Ovis bootstrap-v1 ${id}`); expect(script).toContain("LocalAddress"); expect(script).not.toContain("Stop-Service");
});
