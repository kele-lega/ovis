/** Drive the real UI with fictional peers and intercepted setup requests; never open SSH. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import type { BootstrapAttempt } from "../shared/bootstrap.ts";
import type { MachineSetupSummary, SetupJob } from "../shared/machines.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-tailnet-demo-"));
const app = join(root, "app");
const probe = `(() => {
  window.tailnetProbe = { reads: 0, setups: [], bootstraps: [], bootstrapConnects: 0, bootstrapCancels: 0, bootstrapMode: 'ready', bootstrapJob: null, revokes: [], revokeFails: true, forgotten: 0, copied: '', state: 'running', fixture: null, failure: null, summaries: [], guided: true, backgroundReads: 0, watch: new URLSearchParams(location.search).has('tailnet_watch') };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.tailnetProbe.copied = text; } }, configurable: true });
  const DemoEventSource = window.EventSource;
  window.EventSource = class FixtureEventSource extends EventTarget {
    constructor(url, init) {
      super();
      this.inner = new DemoEventSource(url, init);
      this.url = this.inner.url;
      if (new URL(String(url), location.href).pathname === '/api/machines/events') window.tailnetProbe.events = this;
      this.inner.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'machines') payload.machines = guidedRoster(payload.machines);
        const next = new MessageEvent('message', { data: JSON.stringify(payload) });
        this.onmessage?.(next); this.dispatchEvent(next);
      };
      this.inner.onopen = (event) => { this.onopen?.(event); this.dispatchEvent(event); };
      this.inner.onerror = (event) => { this.onerror?.(event); this.dispatchEvent(event); };
    }
    get readyState() { return this.inner.readyState; }
    close() { this.inner.close(); }
    onmessage = null; onopen = null; onerror = null;
  };
  window.tailnetProbe.emitSetups = (setups) => {
    window.tailnetProbe.summaries = setups;
    const source = window.tailnetProbe.events;
    if (!source) throw new Error('machine event stream is not open');
    const event = new MessageEvent('message', { data: JSON.stringify({ type: 'machine-setups', setups }) });
    source.onmessage?.(event); source.dispatchEvent(event);
  };
  const guidedRoster = (machines) => machines.map((machine) => machine.id === 'laptop' ? { ...machine, can_revoke_bootstrap: window.tailnetProbe.guided } : machine);
  const backgroundJob = { id: 'fixture-background-job', machine_id: 'fixture-new-pc', phase: 'installing', step: 'Installing fictional bridge…', error: null, challenge: null, installations: [], ssh_output: null, target: { destination: 'fixture.invalid' }, progress: { stage: 'download', done: 50, total: 100, rate: null, elapsed_ms: 0 } };
  window.tailnetProbe.backgroundJob = backgroundJob;
  if (new URLSearchParams(location.search).has('tailnet_resume')) window.tailnetProbe.summaries = [{ id: backgroundJob.id, machine_id: backgroundJob.machine_id, name: 'Background fixture PC', phase: backgroundJob.phase, step: backgroundJob.step, error: null, progress: backgroundJob.progress }];
  const peers = [
    { id: 'build-peer', name: 'build-box', hostname: 'BUILD', dns_name: 'build-box.example.ts.net', destination: '100.64.0.2', addresses: ['100.64.0.2'], os: 'linux', online: true, registrations: [{ user: 'root', port: 22, session: 'default', name: 'Build account' }] },
    { id: 'windows-peer', name: 'windows-pc', hostname: 'WINDOWS', dns_name: null, destination: '100.64.0.3', addresses: ['100.64.0.3'], os: 'windows', online: false, registrations: [] },
  ];
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const path = url.pathname;
    const p = window.tailnetProbe;
    if (path === '/api/machines/setups') return Response.json({ setups: p.summaries });
    if (path === '/api/machines/setup/fixture-background-job') {
      if (init?.method === 'POST') { p.backgroundActions = (p.backgroundActions || 0) + 1; p.emitSetups([]); return Response.json({ ...backgroundJob, phase: 'cancelled' }); }
      p.backgroundReads++; return Response.json(p.backgroundJob);
    }
    if (path === '/api/machines/ssh-candidates') return Response.json({ pcs: [] });
    if (path === '/api/machines/laptop/revoke-bootstrap') {
      p.revokes.push(JSON.parse(init.body));
      if (p.revokeFails) return Response.json({ error: { code: 'bootstrap_revoke_failed', message: 'DEMO cleanup refused' } }, { status: 502 });
      p.guided = false; window.__herdrDemoOrder.publish(); return Response.json({ ok: true });
    }
    if (path === '/api/machines/laptop' && init?.method === 'DELETE') { p.forgotten++; return Response.json({ ok: true }); }
    if (path === '/api/machines/tailnet' && url.searchParams.get('ssh_bootstrap') !== '1') return Response.json({ pcs: [] });
    if (path === '/api/machines/tailnet') {
      p.reads++;
      if (new Headers(init?.headers).get('x-herdr-machine') !== '1') throw new Error('missing machine header');
      if (p.state === 'error') return Response.json({error:{code:'fixture',message:'offline'}},{status:503});
      if (p.state !== 'running') return Response.json({state:p.state === 'empty' ? 'running' : p.state,peers:[]});
      if (p.fixture) return Response.json({ state: 'running', peers: [{ id: 'fixture-peer', name: 'fixture-pc', hostname: 'HOST-PC', dns_name: 'fixture-pc.example.ts.net', destination: p.fixture.address, addresses: [p.fixture.address], os: p.fixture.os, online: true, registrations: [] }] });
      return Response.json({ state: 'running', peers });
    }
    if (path.startsWith('/api/machines/bootstrap')) {
      if (new Headers(init?.headers).get('x-herdr-machine') !== '1') throw new Error('missing bootstrap machine header');
      if (path === '/api/machines/bootstrap' && init?.method === 'POST') {
        const body = JSON.parse(init.body); p.bootstraps.push(body);
        if (p.bootstrapMode === 'unavailable') return Response.json({ error: { code: 'bootstrap_unavailable', message: 'No verified fixture asset' } }, { status: 503 });
        if (p.bootstrapMode === 'held') await new Promise((resolve) => { p.releaseBootstrap = resolve; });
        p.bootstrapAttempt = { id: 'fixture-bootstrap', machine_id: 'fixture-guided-pc', target: { destination: body.username + '@100.64.0.3', port: 22 }, os: 'windows', expires_at: Date.now() + (p.bootstrapMode === 'expired' ? -1 : 900000), command: "Write-Output 'DEMO ONLY - no installation'", cleanup_command: "Write-Output 'DEMO ONLY - cleanup'", public_key: 'DEMO-NOT-A-KEY', source_ip: '100.64.0.1' };
        return Response.json(p.bootstrapAttempt, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (path === '/api/machines/bootstrap/fixture-bootstrap' && (!init?.method || init.method === 'GET')) {
        p.bootstrapReads = (p.bootstrapReads || 0) + 1;
        return p.bootstrapMode === 'discarded' ? Response.json({ error: { code: 'bootstrap_expired', message: 'Fixture attempt was discarded' } }, { status: 410 }) : Response.json(p.bootstrapAttempt);
      }
      if (init?.method === 'DELETE') { p.bootstrapCancels++; return Response.json({ ok: true }); }
      if (path.endsWith('/connect')) {
        p.bootstrapConnects++;
        p.bootstrapUpdates = [...(p.bootstrapUpdates || []), JSON.parse(init.body)];
        p.bootstrapJob = { id: 'fixture-bootstrap-job', machine_id: 'fixture-guided-pc', bootstrap_attempt_id: 'fixture-bootstrap', name: 'fixture-pc', phase: 'authentication', step: 'Verify the server fingerprint', challenge: { id: 'fixture-host-key', kind: 'host_key', prompt: 'ED25519 key fingerprint is SHA256:FICTIONALabcdefghijklmnopqrstuvw1234567890123' }, target: { destination: 'alice@100.64.0.3', port: 22 }, installations: [], error: null, ssh_output: null };
        return Response.json(p.bootstrapJob);
      }
    }
    if (path === '/api/machines/setup/fixture-bootstrap-job') {
      if (init?.method === 'POST') {
        const action = JSON.parse(init.body);
        if (action.action === 'cancel') { p.bootstrapJob = { ...p.bootstrapJob, phase: 'cancelled', challenge: null }; p.emitSetups(p.summaries.filter((setup) => setup.id !== p.bootstrapJob.id)); }
        else if (action.action === 'answer') p.bootstrapJob = { ...p.bootstrapJob, phase: 'approval', challenge: null, installations: ['Install fictional bridge - nothing executes'] };
        else if (action.action === 'approve') p.bootstrapJob = { ...p.bootstrapJob, phase: 'connected', challenge: null };
      }
      return Response.json(p.bootstrapJob);
    }
    if (path === '/api/machines/setup' && init?.method === 'POST') {
      const target = JSON.parse(init.body);
      p.setups.push(target);
      if (p.failure) return Response.json({ id: 'fixture-job', machine_id: 'fixture-pc', phase: 'failed', step: 'Connection failed', challenge: null, installations: [], error: p.failure, ssh_output: null, target });
      return Response.json({error:{code:'fixture_refusal',message:'No SSH in this fixture'}},{status:409});
    }
    if (path.startsWith('/api/machines/') && init?.method && init.method !== 'GET') throw new Error('Unexpected fixture machine mutation: ' + path);
    const response = await original(input, init);
    if (path === '/api/machines' && response.ok) { const body = await response.json(); return Response.json({ ...body, machines: guidedRoster(body.machines) }); }
    if (path === '/api/health' && p.watch) {
      const body = await response.json(); body.auth.role = 'watch';
      return Response.json(body);
    }
    return response;
  };
})();`;
type Probe = { backgroundJob: SetupJob; bootstrapAttempt: BootstrapAttempt; bootstrapJob: SetupJob; bootstrapReads: number; bootstrapUpdates: { update_remote: boolean }[]; emitSetups(setups: MachineSetupSummary[]): void; reads: number; setups: { destination: string; name: string; port?: number }[]; bootstraps: { peer_id: string; username: string; name?: string; session?: string }[]; bootstrapConnects: number; bootstrapCancels: number; bootstrapMode: string; releaseBootstrap?: () => void; revokes: { remove_firewall: boolean }[]; revokeFails: boolean; forgotten: number; copied: string; state: string; fixture: { os: string; address: string } | null; failure: string | null; backgroundReads: number; watch: boolean };
const readProbe = (page: Page) => page.evaluate(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe);

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "tailnet-probe.js"), probe);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./tailnet-probe.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "");
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.includes("..") || file.includes("\\")) return new Response(null, { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const [width, language] of [[1440, "en"], [390, "zh"], [320, "en"]] as const) {
        const label = (key: string) => language === "zh" ? ZH[key] ?? key : key;
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 640, hasTouch: width < 640, reducedMotion: "reduce", locale: language });
        try {
          await context.addInitScript((language) => { localStorage.setItem("ovis:settings", JSON.stringify({ language })); localStorage.setItem("ovis:sidebar-filter-shown", "true"); }, language);
          const page = await context.newPage();
          page.setDefaultTimeout(12_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator(".conn-live").waitFor();
          assert.equal((await readProbe(page)).reads, 0, "no peer discovery before the first-time fold opens");
          const openConnections = async () => {
            await page.keyboard.press("ControlOrMeta+Shift+Comma");
            await openSettingsPage(page, label("Devices and PCs"), label("Back to settings"));
            await page.locator(".settings-dialog").getByRole("button", { name: label("Add a connection"), exact: true }).click();
            await page.locator(".connect-phone-dialog").waitFor();
          };
          const openRemote = async () => {
            const before = (await readProbe(page)).reads;
            await openConnections();
            await page.locator('.connect-tabs [data-tab="ssh"]').click();
            assert.equal((await readProbe(page)).reads, before, "SSH discovery stays lazy until the first-time fold opens");
            await page.locator(".connect-phone-dialog").getByText(label("First-time SSH setup"), { exact: true }).click();
          };
          await openRemote();
          const group = page.locator('[data-section="tailnet"]');
          await group.getByText("build-box", { exact: true }).waitFor();
          assert.equal((await readProbe(page)).setups.length, 0);
          assert.match(await group.innerText(), /root:22 \/ default/);
          assert.equal(await group.getByRole("button", { name: label("Add {name}").replace("{name}", "windows-pc"), exact: true }).isDisabled(), true);
          assert.equal(await page.locator(".connect-phone-body").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "connection sheet fits the viewport");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `tailnet-${width}-${language}.png`) }); }
          await group.getByRole("button", { name: label("Add another account on {name}").replace("{name}", "build-box"), exact: true }).click();
          const dialog = page.locator(".machine-dialog");
          await dialog.waitFor();
          assert.equal(await page.locator(".settings-dialog").count(), 0);
          const address = dialog.getByLabel(label("Tailscale IP"), { exact: true });
          const username = dialog.getByLabel(label("Remote username"), { exact: true });
          assert.equal(await address.inputValue(), "100.64.0.2");
          assert.equal(await address.getAttribute("readonly"), "");
          assert.equal(await username.inputValue(), "");
          assert.equal(await username.evaluate((field) => field === document.activeElement), true, "focus the account, not the read-only IP");
          assert.equal(await dialog.getByLabel(label("PC name"), { exact: true }).inputValue(), "build-box");
          assert.equal((await readProbe(page)).setups.length, 0, "prefilling never submits setup");
          await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
          assert.equal(await username.evaluate((field) => (field as HTMLInputElement).validity.valueMissing), true);
          assert.equal((await readProbe(page)).setups.length, 0, "an empty account cannot connect as the server user");
          await username.fill("alice@other-host");
          await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
          assert.equal(await username.evaluate((field) => (field as HTMLInputElement).validity.patternMismatch), true);
          assert.equal((await readProbe(page)).setups.length, 0, "the account cannot override the selected peer");
          await dialog.getByText(label("How to find the remote username"), { exact: true }).click();
          assert.equal(await dialog.locator(".machine-tailnet-help pre").first().innerText(), "whoami");
          await dialog.getByText(label("First time: enable SSH on this PC"), { exact: true }).click();
          assert.match(await dialog.innerText(), /sudo apt-get install openssh-server/);
          assert.match(await dialog.innerText(), /sudo systemctl enable --now sshd/);
          assert.equal(await dialog.locator(".modal-body").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "expanded instructions fit the viewport");
          await username.fill("alice");
          if (evidence) await page.screenshot({ path: join(evidence, `tailnet-setup-${width}-${language}.png`) });
          await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.setups.length === 1);
          assert.deepEqual((await readProbe(page)).setups[0], { destination: "alice@100.64.0.2", name: "build-box", port: 22 });
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          // The current upstream manual address flow must not inherit discovery's account/IP.
          await openConnections();
          const connection = page.locator(".connect-phone-dialog");
          await connection.locator('.connect-tabs [data-tab="ssh"]').click();
          await connection.getByLabel(label("Or type an SSH address"), { exact: true }).fill("bob@manual.example");
          await connection.locator(".connect-ssh-form").getByRole("button", { name: label("Add"), exact: true }).click();
          await dialog.waitFor();
          const destination = dialog.getByLabel(label("SSH alias or user@address"), { exact: true });
          assert.equal(await destination.inputValue(), "bob@manual.example");
          assert.equal(await dialog.getByLabel(label("Remote username"), { exact: true }).count(), 0);
          assert.equal(await dialog.getByLabel(label("Tailscale IP"), { exact: true }).count(), 0);
          await destination.fill("bob@manual.example");
          await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.setups.length === 2);
          assert.deepEqual((await readProbe(page)).setups[1], { destination: "bob@manual.example" });
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          // Each platform keeps its selected IP, shows local prerequisites, and retains raw SSH errors.
          for (const [os, ip, failure, hint] of [
            ["windows", "100.64.0.3", "ssh: connect to host 100.64.0.3 port 22: Connection refused", "The PC refused the SSH connection. Check that OpenSSH Server is running on the chosen port; see “First time: enable SSH on this PC”. A firewall can also reject the connection."],
            ["darwin", "100.64.0.4", "SSH connection timed out", "The SSH connection timed out. Check that the PC is awake and connected to Tailscale, and that its SSH port is allowed by the firewall and tailnet access rules."],
            ["linux", "fd7a:115c:a1e0::1234", "alice@fd7a:115c:a1e0::1234: Permission denied (publickey,password).", "SSH sign-in failed. Check the remote username, account password or SSH key, and whether that account is allowed to sign in over SSH."],
            ["linux", "100.64.0.5", "ssh: Could not resolve hostname old-name: Name or service not known", "The server could not resolve the SSH hostname. Tailscale setup uses an IP; check whether the server’s SSH config overrides it with HostName or a proxy."],
          ]) {
            await page.evaluate(({ os, ip, failure }) => { const probe = (window as unknown as { tailnetProbe: Probe }).tailnetProbe; probe.fixture = { os, address: ip }; probe.failure = failure; }, { os: os!, ip: ip!, failure: failure! });
            await openRemote();
            await group.getByRole("button", { name: label("Add {name}").replace("{name}", "fixture-pc"), exact: true }).click();
            await dialog.waitFor();
            assert.equal(await address.inputValue(), ip);
            await dialog.getByText(label("How to find the remote username"), { exact: true }).click();
            await dialog.getByText(label("First time: enable SSH on this PC"), { exact: true }).click();
            if (os === "windows") {
              assert.match(await dialog.innerText(), /Add-WindowsCapability -Online -Name OpenSSH.Server/);
              assert.match(await dialog.innerText(), /Write-Output \$env:USERNAME/);
              assert.doesNotMatch(await dialog.innerText(), /sudo apt-get/);
            } else if (os === "darwin") {
              assert.equal(await dialog.getByText(label("On the Mac, open System Settings → General → Sharing → Remote Login. Turn it on and allow the account you want to use."), { exact: true }).isVisible(), true);
              assert.equal(await dialog.locator(".machine-tailnet-help pre").count(), 1);
            }
            await username.fill("alice");
            const before = (await readProbe(page)).setups.length;
            await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
            await dialog.getByText(label(hint!), { exact: true }).waitFor();
            assert.deepEqual((await readProbe(page)).setups[before], { destination: `alice@${ip}`, name: "fixture-pc", port: 22 });
            assert.equal(await dialog.getByText(failure!, { exact: true }).isVisible(), true, "keep original diagnostics selectable");
            assert.equal(await username.inputValue(), "alice", "retain account for correction and retry");
            assert.equal(await address.inputValue(), ip);
            assert.equal(await dialog.locator(".modal-body").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
            if (evidence && os === "windows") await page.screenshot({ path: join(evidence, `tailnet-windows-${width}-${language}.png`) });
            await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          }
          // Bootstrap is an explicit opt-in; commands in this fixture only print a demo notice.
          await page.evaluate(() => { const p = (window as unknown as { tailnetProbe: Probe }).tailnetProbe; p.fixture = { os: "windows", address: "100.64.0.3" }; p.failure = null; });
          await openRemote();
          await group.getByRole("button", { name: label("Add {name}").replace("{name}", "fixture-pc"), exact: true }).click();
          await dialog.getByText(label("First time: generate an SSH setup command"), { exact: true }).click();
          const generate = dialog.getByRole("button", { name: label("Generate setup command"), exact: true });
          await generate.click();
          assert.equal((await readProbe(page)).bootstraps.length, 0, "bootstrap requires an explicit username");
          await username.fill("alice");
          await dialog.getByText(label("Advanced settings"), { exact: true }).click();
          const sshPort = dialog.getByLabel(label("SSH port"), { exact: true });
          await sshPort.fill("2222");
          assert.equal(await generate.isDisabled(), true, "bootstrap does not silently change a custom port");
          await sshPort.fill("22");
          const privateKey = dialog.getByLabel(label("Private key path on this web server"), { exact: true });
          await privateKey.fill("~/.ssh/custom");
          assert.equal(await generate.isDisabled(), true, "bootstrap never replaces an explicitly selected identity");
          await privateKey.fill("");
          await page.evaluate(() => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapMode = "unavailable"; });
          await generate.click();
          await dialog.getByText(label("The verified SSH setup release is not available. Ask the administrator to publish the pinned bootstrap release, or use manual SSH setup."), { exact: true }).waitFor();
          assert.equal(await username.inputValue(), "alice", "unavailable release preserves manual fields");
          await page.evaluate(() => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapMode = "ready"; });
          await generate.click();
          await dialog.getByRole("heading", { name: label("First-time SSH setup"), exact: true }).waitFor();
          assert.deepEqual((await readProbe(page)).bootstraps.at(-1), { peer_id: "fixture-peer", username: "alice", name: "fixture-pc" });
          assert.equal((await readProbe(page)).bootstrapConnects, 0, "generating commands never starts SSH");
          const continueBootstrap = dialog.getByRole("button", { name: label("I ran it — continue"), exact: true });
          assert.equal(await continueBootstrap.isDisabled(), true);
          await dialog.getByRole("button", { name: label("Copy"), exact: true }).first().click();
          await dialog.getByRole("button", { name: label("Copied"), exact: true }).waitFor();
          assert.equal((await readProbe(page)).copied, "Write-Output 'DEMO ONLY - no installation'");
          assert.equal((await readProbe(page)).bootstrapConnects, 0, "copy never starts SSH");
          await dialog.getByLabel(label("I ran the command successfully on the selected PC and kept its SSH fingerprints for comparison."), { exact: true }).check();
          assert.equal(await continueBootstrap.isEnabled(), true);
          assert.equal(await dialog.locator(".modal-body").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "bootstrap commands fit the viewport");
          if (evidence) await page.screenshot({ path: join(evidence, `tailnet-bootstrap-${width}-${language}.png`) });
          await continueBootstrap.click();
          await dialog.getByRole("button", { name: label("Trust fingerprint"), exact: true }).waitFor();
          assert.equal(await dialog.getByRole("button", { name: label("Install and connect"), exact: true }).count(), 0, "fingerprint trust is not install approval");
          await dialog.getByRole("button", { name: label("Trust fingerprint"), exact: true }).click();
          await dialog.getByRole("button", { name: label("Install and connect"), exact: true }).waitFor();
          assert.equal(await dialog.getByRole("button", { name: label("Open PC"), exact: true }).count(), 0);
          await dialog.getByRole("button", { name: label("Install and connect"), exact: true }).click();
          await dialog.getByRole("button", { name: label("Open PC"), exact: true }).waitFor();
          const cancelsBefore = (await readProbe(page)).bootstrapCancels;
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          assert.equal((await readProbe(page)).bootstrapCancels, cancelsBefore, "closing a connected setup does not revoke its key");
          // A new PC is not registered yet: its background task travels separately from the roster.
          await page.evaluate(() => {
            const p = (window as unknown as { tailnetProbe: { emitSetups(setups: unknown[]): void } }).tailnetProbe;
            p.emitSetups([{ id: "fixture-background-job", machine_id: "fixture-new-pc", name: "Background fixture PC", phase: "installing", step: "Installing fictional bridge…", error: null, progress: { stage: "download", done: 50, total: 100, rate: null, elapsed_ms: 0 } }]);
          });
          if (width < 640) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          const task = page.locator(".machine-setup-task");
          await task.getByText("Background fixture PC", { exact: true }).waitFor();
          assert.equal(await task.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
          const sidebarFilter = page.getByRole("combobox", { name: label("Filter workspaces and agents"), exact: true });
          await sidebarFilter.fill("no fixture workspace matches");
          assert.equal(await task.isVisible(), true, "filtering workspaces never hides installation tasks");
          assert.equal(await task.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "background progress fits the viewport");
          if (evidence) await page.screenshot({ path: join(evidence, `background-install-${width}-${language}.png`) });
          const beforeReopen = await readProbe(page);
          await task.getByRole("button", { name: label("Show setup"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.backgroundReads > 0);
          assert.equal(await dialog.locator("#machine-connect-form").count(), 0, "reopened setup has no second-install form");
          assert.equal((await readProbe(page)).setups.length, beforeReopen.setups.length, "reopen never posts another setup");
          assert.equal((await readProbe(page)).bootstrapConnects, beforeReopen.bootstrapConnects);
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          if (width < 640 && !await task.isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByRole("button", { name: label("Cancel install"), exact: true }).click();
          await task.waitFor({ state: "detached" });
          await page.evaluate(() => {
            const p = (window as unknown as { tailnetProbe: Probe }).tailnetProbe;
            p.backgroundJob = { ...p.backgroundJob, phase: "failed", registered: true, name: "Retained manual PC", target: { destination: "bob@manual-fixture.invalid", port: 2222, identity_file: "~/.ssh/fixture", session: "fixture-session" }, step: "Connection failed", error: "Fictional background install failed", progress: null };
            p.emitSetups([{ id: p.backgroundJob.id, machine_id: p.backgroundJob.machine_id, name: "Background fixture PC", phase: "failed", step: "Connection failed", error: p.backgroundJob.error, progress: null }]);
          });
          await task.getByText("Fictional background install failed", { exact: true }).waitFor();
          const beforeManualRetry = (await readProbe(page)).setups.length;
          await task.getByRole("button", { name: label("Show setup"), exact: true }).click();
          await dialog.getByRole("button", { name: label("Retry connection"), exact: true }).waitFor();
          assert.equal(await destination.inputValue(), "bob@manual-fixture.invalid", "resumed failure restores its SSH destination");
          assert.equal(await dialog.getByLabel(label("PC name"), { exact: true }).inputValue(), "Retained manual PC");
          await dialog.getByText(label("Advanced settings"), { exact: true }).click();
          assert.equal(await sshPort.inputValue(), "2222");
          assert.equal(await privateKey.inputValue(), "~/.ssh/fixture");
          assert.equal(await dialog.getByLabel(label("herdr session name"), { exact: true }).inputValue(), "fixture-session");
          assert.equal((await readProbe(page)).setups.length, beforeManualRetry, "reading failed setup never retries");
          await dialog.getByRole("button", { name: label("Retry connection"), exact: true }).click();
          await page.waitForFunction((before) => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.setups.length === before + 1, beforeManualRetry);
          assert.deepEqual((await readProbe(page)).setups.at(-1), { destination: "bob@manual-fixture.invalid", name: "Retained manual PC", port: 2222, identity_file: "~/.ssh/fixture", session: "fixture-session", machine_id: "fixture-new-pc" });
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          if (width < 640 && !await task.isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByRole("button", { name: label("Dismiss"), exact: true }).click();
          await task.waitFor({ state: "detached" });
          // A failed guided install retains its dedicated attempt, not an ordinary SSH retry.
          const failedGuided = async (mode = "ready") => page.evaluate((mode) => {
            const p = (window as unknown as { tailnetProbe: Probe }).tailnetProbe;
            p.bootstrapMode = mode;
            p.bootstrapAttempt = { ...p.bootstrapAttempt, expires_at: Date.now() + (mode === "expired" ? -1 : 900000) };
            p.bootstrapJob = { ...p.bootstrapJob, phase: "failed", step: "Connection failed", error: "Fictional guided install failed", challenge: null, action_required: "update_bridge", progress: null };
            p.emitSetups([{ id: p.bootstrapJob.id, machine_id: p.bootstrapJob.machine_id, name: "Retained guided PC", phase: "failed", step: "Connection failed", error: p.bootstrapJob.error, progress: null }]);
          }, mode);
          await failedGuided();
          const beforeGuidedRetry = await readProbe(page);
          await task.getByRole("button", { name: label("Show setup"), exact: true }).click();
          await dialog.getByRole("heading", { name: label("First-time SSH setup"), exact: true }).waitFor();
          const updateGuided = dialog.getByRole("button", { name: label("Update bridge and connect"), exact: true });
          assert.equal(await updateGuided.isDisabled(), true, "recovered commands need fresh acknowledgement");
          assert.equal(await dialog.locator("#machine-connect-form").count(), 0, "guided failure never offers ambient SSH");
          assert.equal((await readProbe(page)).setups.length, beforeGuidedRetry.setups.length);
          assert.equal((await readProbe(page)).bootstrapConnects, beforeGuidedRetry.bootstrapConnects, "opening a failed guided task only reads");
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          assert.equal((await readProbe(page)).bootstrapCancels, beforeGuidedRetry.bootstrapCancels, "inspecting a failure preserves its pending key");
          if (width < 640 && !await task.isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByRole("button", { name: label("Show setup"), exact: true }).click();
          await dialog.getByRole("heading", { name: label("First-time SSH setup"), exact: true }).waitFor();
          await dialog.getByLabel(label("I ran the command successfully on the selected PC and kept its SSH fingerprints for comparison."), { exact: true }).check();
          await updateGuided.click();
          await dialog.getByRole("button", { name: label("Trust fingerprint"), exact: true }).waitFor();
          assert.equal((await readProbe(page)).bootstrapConnects, beforeGuidedRetry.bootstrapConnects + 1, "only explicit retry connects the retained attempt");
          assert.deepEqual((await readProbe(page)).bootstrapUpdates.at(-1), { update_remote: true });
          assert.equal((await readProbe(page)).bootstraps.length, beforeGuidedRetry.bootstraps.length, "retry never creates a new credential");
          assert.equal((await readProbe(page)).setups.length, beforeGuidedRetry.setups.length);
          assert.equal(await dialog.getByRole("button", { name: label("Install and connect"), exact: true }).count(), 0, "retry still waits for fingerprint trust and install approval");
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          // A retained marker remains fail-closed when its attempt expired or was discarded.
          for (const mode of ["expired", "discarded"]) {
            await failedGuided(mode);
            if (width < 640 && !await task.isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
            const beforeUnavailable = await readProbe(page);
            await task.getByRole("button", { name: label("Show setup"), exact: true }).click();
            await dialog.getByText(label("This setup attempt expired. Go back and generate a new command; do not run the old command."), { exact: true }).waitFor();
            assert.equal(await updateGuided.isDisabled(), true);
            assert.equal(await dialog.locator("#machine-connect-form").count(), 0);
            assert.equal(await dialog.getByLabel(label("SSH setup command"), { exact: true }).count(), 0);
            assert.equal((await readProbe(page)).bootstrapConnects, beforeUnavailable.bootstrapConnects);
            await dialog.getByRole("button", { name: label("Discard setup and go back"), exact: true }).click();
            await destination.waitFor();
            assert.equal(await destination.inputValue(), "alice@100.64.0.3");
            assert.equal((await readProbe(page)).bootstrapCancels, beforeUnavailable.bootstrapCancels + 1);
            assert.equal((await readProbe(page)).setups.length, beforeUnavailable.setups.length, "discard returns to manual entry without connecting");
            await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          }
          if (width < 640 && !await task.isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByRole("button", { name: label("Dismiss"), exact: true }).click();
          await task.waitFor({ state: "detached" });
          // A completed background install keeps its next actions, without auto-opening anything.
          await page.evaluate(() => {
            (window as unknown as { __herdrDemoOrder: { addPc(): void } }).__herdrDemoOrder.addPc();
            (window as unknown as { tailnetProbe: { emitSetups(setups: unknown[]): void } }).tailnetProbe.emitSetups([{ id: "fixture-background-job", machine_id: "laptop", name: "Background fixture PC", phase: "connected", step: "Connected", error: null, progress: null }]);
          });
          await task.getByText(label("PC setup complete"), { exact: true }).waitFor();
          assert.equal(await task.getByRole("progressbar").count(), 0);
          assert.equal(await page.locator(".new-session-modal").count(), 0, "completion never steals focus or creates a workspace");
          assert.equal(await task.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "completion actions fit the viewport");
          if (evidence) await page.screenshot({ path: join(evidence, `background-complete-${width}-${language}.png`) });
          await task.getByRole("button", { name: label("New workspace"), exact: true }).click();
          const workspaceDialog = page.getByRole("dialog", { name: `${label("New workspace")} · laptop`, exact: true });
          await workspaceDialog.waitFor();
          await page.keyboard.press("Escape");
          await workspaceDialog.waitFor({ state: "hidden" });
          if (width < 640) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByRole("button", { name: label("Open PC"), exact: true }).click();
          if (width < 640) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await page.locator('.machine-group.is-current[aria-label="' + label("PC {name}").replace("{name}", "laptop") + '"]').waitFor();
          assert.equal(await task.isVisible(), true, "opening the PC does not dismiss its completion");
          await task.getByRole("button", { name: label("Dismiss"), exact: true }).click();
          await task.waitFor({ state: "detached" });
          await sidebarFilter.fill("");
          // Expired attempts hide runnable install commands but keep local cleanup, then return safely.
          await page.evaluate(() => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapMode = "expired"; });
          await openRemote();
          await group.getByRole("button", { name: label("Add {name}").replace("{name}", "fixture-pc"), exact: true }).click();
          await username.fill("alice");
          await dialog.getByText(label("First time: generate an SSH setup command"), { exact: true }).click();
          await generate.click();
          await dialog.getByText(label("This setup attempt expired. Go back and generate a new command; do not run the old command."), { exact: true }).waitFor();
          assert.equal(await continueBootstrap.isDisabled(), true);
          assert.equal(await dialog.getByLabel(label("SSH setup command"), { exact: true }).count(), 0);
          await dialog.getByText(label("Undo this SSH authorization"), { exact: true }).click();
          await dialog.getByLabel(label("SSH authorization cleanup command"), { exact: true }).waitFor();
          await dialog.getByRole("button", { name: label("Discard setup and go back"), exact: true }).click();
          await username.waitFor();
          await page.waitForFunction((before) => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapCancels > before, cancelsBefore);
          assert.equal(await username.inputValue(), "alice");
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          // Closing before installation approval discards the pending local key.
          for (const stopAt of ["command", "fingerprint", "approval", "late-response"]) {
            await page.evaluate((held) => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapMode = held ? "held" : "ready"; }, stopAt === "late-response");
            await openRemote();
            await group.getByRole("button", { name: label("Add {name}").replace("{name}", "fixture-pc"), exact: true }).click();
            await username.fill("alice");
            await dialog.getByText(label("First time: generate an SSH setup command"), { exact: true }).click();
            const beforeCancel = (await readProbe(page)).bootstrapCancels;
            await generate.click();
            if (stopAt === "late-response") {
              await page.waitForFunction(() => typeof (window as unknown as { tailnetProbe: Probe }).tailnetProbe.releaseBootstrap === "function");
              await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
              await page.evaluate(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.releaseBootstrap?.());
            } else {
              await dialog.getByRole("heading", { name: label("First-time SSH setup"), exact: true }).waitFor();
              if (stopAt !== "command") {
                await dialog.getByLabel(label("I ran the command successfully on the selected PC and kept its SSH fingerprints for comparison."), { exact: true }).check();
                await continueBootstrap.click();
                await dialog.getByRole("button", { name: label("Trust fingerprint"), exact: true }).waitFor();
                if (stopAt === "approval") {
                  await dialog.getByRole("button", { name: label("Trust fingerprint"), exact: true }).click();
                  await dialog.getByRole("button", { name: label("Install and connect"), exact: true }).waitFor();
                }
              }
              await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
            }
            await page.waitForFunction((before) => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.bootstrapCancels > before, beforeCancel);
          }
          await page.evaluate(() => { const probe = (window as unknown as { tailnetProbe: Probe }).tailnetProbe; probe.fixture = null; probe.failure = null; });
          await openRemote();
          for (const state of ["missing", "stopped", "unavailable", "identity_unavailable", "empty", "error", "running"]) {
            await page.evaluate((state) => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.state = state; }, state);
            const before = (await readProbe(page)).reads;
            await group.getByRole("button", { name: label("Refresh"), exact: true }).click();
            await page.waitForFunction((before) => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.reads > before, before);
            await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-section="tailnet"] button')?.disabled === false);
            if (state === "error" || state === "unavailable") assert.equal(await group.getByRole("alert").count(), 1);
            else if (state === "running") await group.getByText("build-box", { exact: true }).waitFor();
            else assert.equal(await group.locator(".settings-item").count(), 1);
          }
          // Remote revocation is explicit and separate from forgetting; failures retain the local key.
          await page.locator(".connect-phone-dialog").getByRole("button", { name: label("Close"), exact: true }).click();
          await page.locator(".settings-dialog").getByRole("button", { name: label("Close settings"), exact: true }).click();
          if (width < 640 && !await page.locator(".machine-list").isVisible()) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          const laptop = page.locator('.machine-group[aria-label="' + label("PC {name}").replace("{name}", "laptop") + '"]');
          await laptop.locator(".machine-header").hover();
          await laptop.locator(".machine-manage").click();
          await page.locator(".row-menu, .row-sheet").getByText(label("Revoke SSH key"), { exact: true }).click();
          const revoke = page.getByRole("dialog", { name: label("Revoke SSH key"), exact: true });
          const firewall = revoke.getByLabel(label("Also remove this setup’s Windows firewall rule, if present"), { exact: true });
          assert.equal(await firewall.isChecked(), false);
          await firewall.check();
          await revoke.getByRole("button", { name: label("Revoke SSH key"), exact: true }).click();
          await revoke.getByRole("alert").filter({ hasText: "DEMO cleanup refused" }).waitFor();
          assert.equal((await readProbe(page)).forgotten, 0, "failed cleanup must not discard local credentials");
          assert.deepEqual((await readProbe(page)).revokes, [{ remove_firewall: true }]);
          await page.evaluate(() => { (window as unknown as { tailnetProbe: Probe }).tailnetProbe.revokeFails = false; });
          await revoke.getByRole("button", { name: label("Revoke SSH key"), exact: true }).click();
          await revoke.waitFor({ state: "detached" });
          assert.equal((await readProbe(page)).forgotten, 0, "successful revocation does not implicitly forget the PC");
          assert.equal((await readProbe(page)).revokes.length, 2);
          await laptop.locator(".machine-header").hover();
          await laptop.locator(".machine-manage").click();
          await page.locator(".row-menu, .row-sheet").getByText(label("Remove PC…"), { exact: true }).click();
          await page.getByRole("alertdialog").getByRole("button", { name: label("Remove PC"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.forgotten === 1);
          // A fresh tab recovers server-owned progress without repeating installation.
          await page.goto(`http://127.0.0.1:${server.port}/?tailnet_resume=1`);
          await page.locator(".conn-live").waitFor();
          if (width < 640) await page.getByRole("button", { name: label("Open workspace list"), exact: true }).click();
          await task.getByText("Background fixture PC", { exact: true }).waitFor();
          assert.equal((await readProbe(page)).setups.length, 0);
          assert.equal((await readProbe(page)).bootstrapConnects, 0);
          // A fresh watch health response must not mount or request discovery.
          await page.goto(`http://127.0.0.1:${server.port}/?tailnet_watch=1`);
          await page.locator(".conn-live").waitFor();
          await openConnections();
          assert.equal(await page.locator('.connect-tabs [data-tab="ssh"]').count(), 0, "watch devices never offer SSH mutations");
          assert.equal(await group.count(), 0, "watch devices never mount discovery");
          assert.equal((await readProbe(page)).reads, 0);
          assert.deepEqual(errors, []);
          console.log(`PASS tailnet discovery, multi-account prefill, manual reset, state recovery and watch UI at ${width}px (${language})`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
