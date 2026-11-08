import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AGENT_COMMANDS_STORAGE_KEY, DEFAULT_SETTINGS, SettingsProvider, useSettings, type Settings } from "./settings.ts";
import { launchAgent } from "./agentLaunchMode.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("settings across tabs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderers: ReactTestRenderer[];
  let settings: Settings;
  let writes: number;
  let commandWrites: number;
  let writeAttempts: number;
  let storageBlocked: boolean;
  let quotaKey: string | null;
  type Client = Pick<ReturnType<typeof useSettings>, "settings" | "update">;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    records = new Map();
    events = new EventTarget();
    renderers = [];
    settings = DEFAULT_SETTINGS;
    writes = 0;
    commandWrites = 0;
    writeAttempts = 0;
    storageBlocked = false;
    quotaKey = null;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => {
          if (storageBlocked) throw new Error("Storage is blocked");
          return records.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          writeAttempts++;
          if (storageBlocked) throw new Error("Storage is blocked");
          if (quotaKey === "all" || quotaKey === key) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
          writes++;
          if (key === AGENT_COMMANDS_STORAGE_KEY) commandWrites++;
          records.set(key, value);
        },
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  });

  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function open(): Promise<Client> {
    const client: Client = { settings: DEFAULT_SETTINGS, update: () => { throw new Error("not mounted"); } };
    function Probe() {
      const context = useSettings();
      settings = context.settings;
      client.settings = context.settings;
      client.update = context.update;
      return null;
    }
    await act(async () => { renderers.push(create(createElement(SettingsProvider, null, createElement(Probe)))); });
    return client;
  }

  async function storage(key: string | null): Promise<void> {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      storageArea: { value: window.localStorage },
    });
    await act(async () => { events.dispatchEvent(event); });
  }

  it("updates a mounted consumer when another tab saves an override", async () => {
    // Given an already-open tab with the defaults.
    await open();
    expect(settings.shortcutOverrides).toEqual({});
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" }, terminalFontSize: 22 }));

    // When the browser announces another tab's settings write.
    await storage(SETTINGS_STORAGE_KEY);

    // Then the override is live without echoing the write or changing other settings.
    expect(settings.shortcutOverrides).toEqual({ palette: "ctrl+k" });
    expect(settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(0);
  });

  it.each([SETTINGS_STORAGE_KEY, null])("restores defaults when storage is removed with key %j", async (key) => {
    // Given an open tab with a saved override.
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));
    await open();
    records.clear();

    // When another tab removes the settings record or clears storage.
    await storage(key);

    // Then the mounted consumer returns to the default shortcuts.
    expect(settings.shortcutOverrides).toEqual({});
  });

  it("ignores storage events for unrelated keys", async () => {
    // Given an open tab and a settings record not announced by this event.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));

    // When an unrelated record changes.
    await storage("ovis:unrelated");

    // Then the shortcut state stays as it was.
    expect(settings.shortcutOverrides).toEqual({});
  });

  it("adopts another tab's saved command without echoing storage or changing unrelated settings", async () => {
    const a = await open();
    const b = await open();
    const agentCommands = { codex: "  wrapper --profile 'work profile'  " };
    await act(async () => { a.update({ agentCommands }); });
    expect(b.settings.agentCommands).toEqual({});
    const savedWrites = writes;

    await storage(AGENT_COMMANDS_STORAGE_KEY);

    expect(b.settings.agentCommands).toEqual(agentCommands);
    expect(launchAgent("codex", b.settings)).toEqual({ kind: "codex", command: agentCommands.codex });
    expect(b.settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(savedWrites);
  });

  it("keeps another tab's latest command on an unrelated edit before a storage event arrives", async () => {
    // No preferences-sync hook is mounted: shared localStorage is the only connection between tabs.
    const a = await open();
    const b = await open();
    const agentCommands = { codex: "  wrapper --profile work  " };
    await act(async () => { a.update({ agentCommands }); });
    expect(b.settings.agentCommands).toEqual({});
    expect(commandWrites).toBe(1);

    await act(async () => { b.update({ terminalFontSize: 22 }); });

    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual(agentCommands);
    expect(b.settings.agentCommands).toEqual(agentCommands);
    expect(launchAgent("codex", b.settings)).toEqual({ kind: "codex", command: agentCommands.codex });
    expect(b.settings.terminalFontSize).toBe(22);
    expect(commandWrites).toBe(1);
    const savedWrites = writes;
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    expect(b.settings.agentCommands).toEqual(agentCommands);
    expect(writes).toBe(savedWrites);
  });

  it("lets an explicit Clear win from a stale tab and does not resurrect it on a missed event", async () => {
    const a = await open();
    const b = await open();
    await act(async () => { a.update({ agentCommands: { codex: "wrapper" } }); });
    // B still has {}, but its explicit Clear must replace the newer saved command.
    await act(async () => { b.update({ agentCommands: {} }); });
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual({});
    expect(b.settings.agentCommands).toEqual({});
    expect(commandWrites).toBe(2);

    await act(async () => { a.update({ terminalFontSize: 22 }); });

    expect(a.settings.agentCommands).toEqual({});
    expect(launchAgent("codex", a.settings)).not.toHaveProperty("command");
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual({});
    expect(commandWrites).toBe(2);
  });

  it("persists an explicit remote-preferences command patch over the saved map and shares its clearing", async () => {
    const a = await open();
    const b = await open();
    await act(async () => { a.update({ agentCommands: { codex: "local-wrapper" } }); });
    const agentCommands = { claude: "  remote-wrapper --profile 'two words'  " };
    // usePreferencesSync applies remote settings through this same explicit update patch.
    await act(async () => { b.update({ agentCommands }); });
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual(agentCommands);
    expect(b.settings.agentCommands).toEqual(agentCommands);
    await act(async () => { a.update({ terminalFontSize: 22 }); });
    expect(launchAgent("claude", a.settings)).toEqual({ kind: "claude", command: agentCommands.claude });

    await act(async () => { b.update({ agentCommands: {} }); });
    const savedWrites = writes;
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    expect(a.settings.agentCommands).toEqual({});
    expect(launchAgent("claude", a.settings)).not.toHaveProperty("command");
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual({});
    expect(writes).toBe(savedWrites);
  });

  it.each([AGENT_COMMANDS_STORAGE_KEY, null])("clears mounted commands without writing when storage is removed with key %j", async (key) => {
    records.set(AGENT_COMMANDS_STORAGE_KEY, JSON.stringify({ codex: "wrapper" }));
    const client = await open();
    expect(client.settings.agentCommands).toEqual({ codex: "wrapper" });
    records.clear();

    await storage(key);

    expect(client.settings.agentCommands).toEqual({});
    expect(launchAgent("codex", client.settings)).not.toHaveProperty("command");
    expect(writes).toBe(0);
  });

  it("sanitizes a command storage event without saving a corrective map", async () => {
    const client = await open();
    records.set(AGENT_COMMANDS_STORAGE_KEY, JSON.stringify({ codex: "bad\ncommand", claude: "  wrapper  " }));

    await storage(AGENT_COMMANDS_STORAGE_KEY);

    expect(client.settings.agentCommands).toEqual({ claude: "  wrapper  " });
    expect(writes).toBe(0);
  });

  it.each(["all", AGENT_COMMANDS_STORAGE_KEY])("keeps an explicit session command through quota failures at %s until a later update persists it", async (key) => {
    const client = await open();
    quotaKey = key;
    const agentCommands = { codex: "  wrapper --profile 'session only'  " };
    await act(async () => { client.update({ agentCommands }); });
    expect(client.settings.agentCommands).toEqual(agentCommands);
    expect(window.localStorage.getItem(AGENT_COMMANDS_STORAGE_KEY)).toBeNull();

    await act(async () => { client.update({ terminalFontSize: 22 }); });
    expect(client.settings.agentCommands).toEqual(agentCommands);
    expect(launchAgent("codex", client.settings)).toEqual({ kind: "codex", command: agentCommands.codex });
    const attempts = writeAttempts;
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    await storage(null);
    expect(client.settings.agentCommands).toEqual(agentCommands);
    expect(writeAttempts).toBe(attempts);

    quotaKey = null;
    await act(async () => { client.update({ terminalFontSize: 23 }); });
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual(agentCommands);
    expect(commandWrites).toBe(1);
    // Once persisted, the map is no longer pending: a later other-tab save can replace it.
    records.set(AGENT_COMMANDS_STORAGE_KEY, JSON.stringify({ codex: "other-tab-wrapper" }));
    const persistedAttempts = writeAttempts;
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    expect(client.settings.agentCommands).toEqual({ codex: "other-tab-wrapper" });
    expect(writeAttempts).toBe(persistedAttempts);
  });

  it.each(["all", AGENT_COMMANDS_STORAGE_KEY])("keeps explicit Clear in session when the old saved map is readable but writes fail at %s", async (key) => {
    const previous = { codex: "previous-wrapper" };
    records.set(AGENT_COMMANDS_STORAGE_KEY, JSON.stringify(previous));
    const client = await open();
    quotaKey = key;
    await act(async () => { client.update({ agentCommands: {} }); });
    expect(client.settings.agentCommands).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual(previous);

    await act(async () => { client.update({ terminalFontSize: 22 }); });
    const attempts = writeAttempts;
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    await storage(null);
    expect(client.settings.agentCommands).toEqual({});
    expect(launchAgent("codex", client.settings)).not.toHaveProperty("command");
    expect(writeAttempts).toBe(attempts);

    quotaKey = null;
    await act(async () => { client.update({ terminalFontSize: 23 }); });
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual({});
    expect(commandWrites).toBe(1);
    records.set(AGENT_COMMANDS_STORAGE_KEY, JSON.stringify({ codex: "new-other-tab-wrapper" }));
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    expect(client.settings.agentCommands).toEqual({ codex: "new-other-tab-wrapper" });
  });

  it("replaces a quota-pending command with a newer explicit remote-preferences patch", async () => {
    const client = await open();
    quotaKey = AGENT_COMMANDS_STORAGE_KEY;
    await act(async () => { client.update({ agentCommands: { codex: "local-session-wrapper" } }); });
    const agentCommands = { claude: "remote-wrapper" };
    await act(async () => { client.update({ agentCommands }); });
    await storage(AGENT_COMMANDS_STORAGE_KEY);
    expect(client.settings.agentCommands).toEqual(agentCommands);
    quotaKey = null;

    await act(async () => { client.update({ terminalFontSize: 22 }); });

    expect(client.settings.agentCommands).toEqual(agentCommands);
    expect(JSON.parse(records.get(AGENT_COMMANDS_STORAGE_KEY)!)).toEqual(agentCommands);
    expect(launchAgent("claude", client.settings)).toEqual({ kind: "claude", command: agentCommands.claude });
  });

  it("keeps session-only commands on unrelated edits when storage cannot be read", async () => {
    const client = await open();
    storageBlocked = true;
    const agentCommands = { codex: "wrapper" };
    await act(async () => { client.update({ agentCommands }); });

    await act(async () => { client.update({ terminalFontSize: 22 }); });

    expect(client.settings.agentCommands).toEqual(agentCommands);
    expect(client.settings.terminalFontSize).toBe(22);
    expect(writes).toBe(0);
  });
});
