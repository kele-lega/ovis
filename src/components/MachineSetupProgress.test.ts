import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineSetupSummary } from "../../shared/machines.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSetupProgress } from "./MachineSidebar.tsx";

const setup: MachineSetupSummary = {
  id: "fixture-job", machine_id: "fixture-pc", name: "Fixture PC", phase: "installing",
  step: "Installing verified fixture bundle…", error: null,
  progress: { stage: "download", done: 50, total: 100, rate: null, elapsed_ms: 0 },
};
const render = (value = setup, watching = false) => renderToStaticMarkup(createElement(SettingsProvider, {
  children: createElement(MachineSetupProgress, { setup: value, watching }),
}));

describe("first PC installation sidebar task", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
  afterEach(() => { if (languages) Object.defineProperty(navigator, "languages", languages); else Reflect.deleteProperty(navigator, "languages"); });

  test("shows the PC, current byte progress and cancellation without registered-PC controls", () => {
    const html = render();
    expect(html).toContain("Fixture PC");
    expect(html).toContain("Setting up PC");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("Cancel install");
    for (const control of ["New workspace", "Reconnect", "Remove PC", "Manage PC"]) expect(html).not.toContain(control);
  });
  test("keeps the failure reason visible with a dismiss action instead of live progress", () => {
    const html = render({ ...setup, phase: "failed", error: "fixture install failed" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("fixture install failed");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("Cancel install");
  });
  test("completed setup keeps explicit next steps, not a progress bar or cancellation", () => {
    const html = render({ ...setup, phase: "connected", step: "Connected", progress: null });
    expect(html).toContain("PC setup complete");
    expect(html).toContain("Open PC");
    expect(html).toContain("New workspace");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Cancel install");
    expect(html).not.toContain('role="progressbar"');
  });
  test("a watching device cannot invoke completion actions", () => {
    const html = render({ ...setup, phase: "connected", progress: null }, true);
    expect(html).toContain("PC setup complete");
    expect(html).not.toContain("New workspace");
    expect(html).not.toContain("Open PC");
    expect(html).not.toContain("Dismiss");
  });
  test("a watching device sees progress but cannot cancel the setup", () => {
    expect(render(setup, true)).toContain("Fixture PC");
    expect(render(setup, true)).not.toContain("Cancel install");
  });
});
