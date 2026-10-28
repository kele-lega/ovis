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

const root = mkdtempSync(join(tmpdir(), "ovis-tailnet-demo-"));
const app = join(root, "app");
const probe = `(() => {
  window.tailnetProbe = { reads: 0, setups: [], state: 'running', fixture: null, failure: null, watch: new URLSearchParams(location.search).has('tailnet_watch') };
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const p = window.tailnetProbe;
    if (path === '/api/machines/tailnet') {
      p.reads++;
      if (new Headers(init?.headers).get('x-herdr-machine') !== '1') throw new Error('missing machine header');
      if (p.state === 'error') return Response.json({error:{code:'fixture',message:'offline'}},{status:503});
      if (p.state !== 'running') return Response.json({state:p.state === 'empty' ? 'running' : p.state,peers:[]});
      if (p.fixture) return Response.json({ state: 'running', peers: [{ id: 'fixture-peer', name: 'fixture-pc', hostname: 'HOST-PC', dns_name: 'fixture-pc.example.ts.net', destination: p.fixture.address, addresses: [p.fixture.address], os: p.fixture.os, online: true, registrations: [] }] });
    }
    if (path === '/api/machines/setup' && init?.method === 'POST') {
      const target = JSON.parse(init.body);
      p.setups.push(target);
      if (p.failure) return Response.json({ id: 'fixture-job', machine_id: 'fixture-pc', phase: 'failed', step: 'Connection failed', challenge: null, installations: [], error: p.failure, ssh_output: null, target });
      return Response.json({error:{code:'fixture_refusal',message:'No SSH in this fixture'}},{status:409});
    }
    const response = await original(input, init);
    if (path === '/api/health' && p.watch) {
      const body = await response.json(); body.auth.role = 'watch';
      return Response.json(body);
    }
    return response;
  };
})();`;
type Probe = { reads: number; setups: { destination: string; name: string; port?: number }[]; state: string; fixture: { os: string; address: string } | null; failure: string | null; watch: boolean };
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
          await context.addInitScript((language) => localStorage.setItem("ovis:settings", JSON.stringify({ language })), language);
          const page = await context.newPage();
          page.setDefaultTimeout(12_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator(".conn-live").waitFor();
          assert.equal((await readProbe(page)).reads, 0, "no background discovery before settings opens");
          const openRemote = async () => {
            await page.keyboard.press("ControlOrMeta+Shift+Comma");
            await openSettingsPage(page, label("Remote PCs"), label("Back to settings"));
          };
          await openRemote();
          const group = page.locator('[data-section="tailnet"]');
          await group.getByText("build-box", { exact: true }).waitFor();
          assert.equal((await readProbe(page)).setups.length, 0);
          assert.match(await group.innerText(), /root:22 \/ default/);
          assert.equal(await group.getByRole("button", { name: label("Add {name}").replace("{name}", "windows-pc"), exact: true }).isDisabled(), true);
          assert.equal(await page.locator(".settings-body:not([hidden])").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "settings fit the viewport");
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
          await openRemote();
          // The original manual entry must not inherit the last discovery prefill.
          await page.locator(".settings-dialog").getByRole("button", { name: label("Add PC"), exact: true }).first().click();
          await dialog.waitFor();
          const destination = dialog.getByLabel(label("SSH alias or user@address"), { exact: true });
          assert.equal(await destination.inputValue(), "");
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
          // A fresh watch health response must not mount or request discovery.
          await page.goto(`http://127.0.0.1:${server.port}/?tailnet_watch=1`);
          await page.locator(".conn-live").waitFor();
          await openRemote();
          assert.equal(await group.count(), 0, "watch devices never mount discovery");
          assert.equal((await readProbe(page)).reads, 0);
          assert.deepEqual(errors, []);
          console.log(`PASS tailnet discovery, multi-account prefill, manual reset, state recovery and watch UI at ${width}px (${language})`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
