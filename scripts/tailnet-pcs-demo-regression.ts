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
  window.tailnetProbe = { reads: 0, setups: [], state: 'running', watch: new URLSearchParams(location.search).has('tailnet_watch') };
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const p = window.tailnetProbe;
    if (path === '/api/machines/tailnet') {
      p.reads++;
      if (new Headers(init?.headers).get('x-herdr-machine') !== '1') throw new Error('missing machine header');
      if (p.state === 'error') return Response.json({error:{code:'fixture',message:'offline'}},{status:503});
      if (p.state !== 'running') return Response.json({state:p.state === 'empty' ? 'running' : p.state,peers:[]});
    }
    if (path === '/api/machines/setup' && init?.method === 'POST') {
      p.setups.push(JSON.parse(init.body));
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
type Probe = { reads: number; setups: { destination: string; name: string }[]; state: string; watch: boolean };
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
          const destination = dialog.getByLabel(label("SSH alias or user@address"), { exact: true });
          assert.equal(await destination.inputValue(), "build-box.example.ts.net");
          assert.equal(await dialog.getByLabel(label("PC name"), { exact: true }).inputValue(), "build-box");
          assert.equal((await readProbe(page)).setups.length, 0, "prefilling never submits setup");
          await destination.fill("alice@build-box.example.ts.net");
          await dialog.getByRole("button", { name: label("Connect"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { tailnetProbe: Probe }).tailnetProbe.setups.length === 1);
          assert.deepEqual((await readProbe(page)).setups[0], { destination: "alice@build-box.example.ts.net", name: "build-box" });
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
          await openRemote();
          // The original manual entry must not inherit the last discovery prefill.
          await page.locator(".settings-dialog").getByRole("button", { name: label("Add PC"), exact: true }).first().click();
          await dialog.waitFor();
          assert.equal(await destination.inputValue(), "");
          await dialog.getByRole("button", { name: label("Close PC setup"), exact: true }).click();
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
