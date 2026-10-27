/** Exact launch settings and requests on fictional panes only; no shell, Herdr or model is run. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";
import { ZH } from "../src/lib/i18n.zh.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-custom-launch-demo-"));
const app = join(root, "app");
const command = "  QA_LAUNCH='two words' /opt/fixture/claude --model custom --effort high  ";
const probe = `(() => {
  window.launchProbe = { capable: true, creates: [], saves: [], prefsOffline: new URLSearchParams(location.search).has('launch_preferences_offline') };
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (path.endsWith('/agents')) return Response.json({ agents: [{kind:'claude',label:'Claude Code',installed:false}, {kind:'codex',label:'Codex'}], ...(window.launchProbe.capable ? {launch_command:true} : {}) });
    if (/\\/(workspace|tab|worktree)\\/create$/.test(path)) window.launchProbe.creates.push({path, body:JSON.parse(init.body)});
    if (path.endsWith('/preferences') && init?.method === 'PUT') window.launchProbe.saves.push(JSON.parse(init.body));
    if (path.endsWith('/preferences') && window.launchProbe.prefsOffline) return Response.json({error:{code:'fixture_offline',message:'fixture offline'}},{status:503});
    return original(input, init);
  };
})();`;
const creates = (page: Page) => page.evaluate(() => (window as unknown as { launchProbe: { creates: { path: string; body: { agent: unknown; first_message?: string } }[] } }).launchProbe.creates);
const openSettings = async (page: Page, chat: string, back: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, chat, back);
};
const openWorkspace = async (page: Page, width: number) => {
  if (width < 640) await page.locator('[aria-controls="workspace-drawer"]').click();
  await page.locator(".machine-new").first().click();
  await page.locator(".new-session-modal").waitFor();
};

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "launch-probe.js"), probe);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./launch-probe.js"></script><script type="module"'));
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
        const label = (text: string) => language === "zh" ? (ZH as Record<string, string>)[text] ?? text : text;
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 640, hasTouch: width < 640, reducedMotion: "reduce", locale: language });
        try {
          await context.addInitScript((language) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language, claudeLaunchMode: "bypassPermissions", codexLaunchMode: "fullAccess" }));
            localStorage.setItem("ovis:new-session-agent", "claude");
          }, language);
          const page = await context.newPage();
          page.setDefaultTimeout(12_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator(".conn-live").waitFor();
          await openSettings(page, label("Chat"), label("Back to settings"));
          const field = page.getByLabel(label("Full command for {agent}").replace("{agent}", "Claude Code"), { exact: true });
          const row = field.locator("xpath=../..");
          await field.fill(command);
          assert.equal((await page.evaluate(() => (window as unknown as { launchProbe: { saves: unknown[] } }).launchProbe.saves)).length, 0, "typing a command never saves it");
          await row.getByRole("button", { name: label("Save command for {agent}").replace("{agent}", "Claude Code"), exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { launchProbe: { saves: { settings?: { agentCommands?: { claude?: string } } }[] } }).launchProbe.saves.some((save) => save.settings?.agentCommands?.claude !== undefined));
          assert.equal(await page.locator("#settings-claude-launch-mode").isDisabled(), true);
          // Single-line inputs strip line breaks themselves. The paste handler must refuse first.
          await field.evaluate((node) => {
            const data = new DataTransfer(); data.setData("text/plain", "claude\nprintf side-effect");
            node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
          });
          assert.equal(await field.inputValue(), command);
          assert.equal(await field.getAttribute("aria-invalid"), "true");
          assert.equal(await row.getByRole("button", { name: label("Save command for {agent}").replace("{agent}", "Claude Code"), exact: true }).isDisabled(), true);
          // Invalid typing stays visible and cannot replace the saved value.
          await field.fill(" ");
          assert.equal(await field.inputValue(), " ");
          assert.equal(await field.getAttribute("aria-invalid"), "true");
          await field.fill(command);
          assert.equal(await page.locator(".settings-body:not([hidden])").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "command settings fit the viewport");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `custom-launch-${width}-${language}.png`) }); }
          await page.locator(".settings-dialog").getByRole("button", { name: label("Close settings"), exact: true }).click();
          await openWorkspace(page, width);
          const dialog = page.locator(".new-session-modal");
          await dialog.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
          assert.equal(await dialog.locator("#new-session-model, #new-session-effort").count(), 0);
          await dialog.locator("#new-session-cwd").fill("/fixture/project");
          await dialog.locator("#new-session-prompt").fill("fixture first message");
          await dialog.locator('button[type="submit"]').click();
          await dialog.waitFor({ state: "detached" });
          const sent = (await creates(page)).at(-1)!;
          assert.deepEqual(sent.body.agent, { kind: "claude", command });
          assert.equal(sent.body.first_message, "fixture first message");
          if (width === 1440) {
            await page.locator('.tab-strip [role="tab"][aria-selected="true"]').click({ button: "right" });
            await page.getByRole("menuitem", { name: label("New tab with agent…"), exact: true }).click();
            await dialog.waitFor();
            await dialog.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
            assert.equal(await dialog.locator("#new-session-model, #new-session-effort").count(), 0);
            await dialog.locator('button[type="submit"]').click();
            await dialog.waitFor({ state: "detached" });
            assert.equal((await creates(page)).at(-1)!.path, "/api/tab/create");
            assert.deepEqual((await creates(page)).at(-1)!.body.agent, { kind: "claude", command });
            await page.locator('.workspace-group[data-workspace="w1C"] > .workspace-header').click({ button: "right" });
            await page.getByRole("menuitem", { name: label("New worktree"), exact: true }).click();
            const worktree = page.locator(".worktree-modal");
            await worktree.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
            await worktree.locator('button[type="submit"]').click();
            await worktree.waitFor({ state: "detached" });
            assert.equal((await creates(page)).at(-1)!.path, "/api/worktree/create");
            assert.deepEqual((await creates(page)).at(-1)!.body.agent, { kind: "claude", command });
            console.log("PASS New tab and New worktree send the same exact custom command without args");
          }
          // A legacy answer still keeps the configured (installed:false) kind and refuses Start.
          await page.evaluate(() => { (window as unknown as { launchProbe: { capable: boolean } }).launchProbe.capable = false; });
          await openWorkspace(page, width);
          await dialog.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
          await dialog.locator("#new-session-command-unsupported").waitFor();
          assert.equal(await dialog.locator('button[type="submit"]').isDisabled(), true);
          const count = (await creates(page)).length;
          await dialog.evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          assert.equal((await creates(page)).length, count);
          await dialog.getByRole("button", { name: label("Close dialog"), exact: true }).click();
          if (width === 1440) {
            await page.locator('.workspace-group[data-workspace="w1C"] > .workspace-header').click({ button: "right" });
            await page.getByRole("menuitem", { name: label("New worktree"), exact: true }).click();
            const worktree = page.locator(".worktree-modal");
            await worktree.locator('[id$="-command-unsupported"]').waitFor();
            assert.equal(await worktree.locator('button[type="submit"]').isDisabled(), true);
            await worktree.evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
            assert.equal((await creates(page)).length, count);
            await worktree.getByRole("button", { name: label("Close worktree dialog"), exact: true }).click();
            console.log("PASS legacy worktree refusal blocks even a synthetic form submission");
          }
          await openSettings(page, label("Chat"), label("Back to settings"));
          await row.getByRole("button", { name: label("Clear command for {agent}").replace("{agent}", "Claude Code"), exact: true }).click();
          assert.equal(await field.inputValue(), "");
          assert.equal(await page.locator("#settings-claude-launch-mode").isEnabled(), true);
          assert.deepEqual(errors, []);
          console.log(`PASS custom launch Save/Clear, invalid paste, exact request/pending prompt and legacy refusal at ${width}px (${language})`);
        } finally { await context.close(); }
      }
      // Two current-version tabs share local storage even while preferences cannot reach the server.
      const tabs = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "en-US" });
      try {
        await tabs.addInitScript(() => {
          if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          // Drop events only in the stale tab to prove an unrelated save also handles a delayed event.
          if (new URLSearchParams(location.search).has("launch_stale_tab")) window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
        });
        const a = await tabs.newPage(), b = await tabs.newPage();
        const offline = `http://127.0.0.1:${server.port}/?launch_preferences_offline=1`;
        await Promise.all([a.goto(offline), b.goto(`${offline}&launch_stale_tab=1`)]);
        await Promise.all([a.locator(".conn-live").waitFor(), b.locator(".conn-live").waitFor()]);
        await openSettings(a, "Chat", "Back to settings");
        const aField = a.getByLabel("Full command for Claude Code", { exact: true });
        await aField.fill(command);
        await aField.locator("xpath=../..").getByRole("button", { name: "Save command for Claude Code", exact: true }).click();
        await a.waitForFunction((command) => JSON.parse(localStorage.getItem("ovis:agent-commands") ?? "{}").claude === command, command);
        await b.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(b, "Terminal", "Back to settings");
        await b.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
        assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem("ovis:agent-commands") ?? "{}").claude), command, "a stale tab's unrelated save cannot erase the command");
        await b.locator(".settings-dialog").getByRole("button", { name: "Close settings", exact: true }).click();
        await openWorkspace(b, 1440);
        await b.locator(".new-session-modal .agent-picker-trigger").click();
        await b.getByRole("option", { name: /Claude Code/ }).click();
        await b.locator(".new-session-modal").getByText("Uses the saved custom command", { exact: false }).waitFor();
        await a.reload();
        await a.locator(".conn-live").waitFor();
        await openSettings(a, "Chat", "Back to settings");
        assert.equal(await aField.inputValue(), command);
        console.log("PASS two offline-sync tabs retain a saved command across stale unrelated updates and reload");
      } finally { await tabs.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
