import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { LaunchCommandField } from "./LaunchSettings.tsx";

describe("LaunchCommandField", () => {
  let renderer: ReactTestRenderer;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });
  const input = () => renderer.root.findByType("input");
  const buttons = () => renderer.root.findAllByType("button");
  const submit = async () => act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  const type = async (value: string) => act(async () => { input().props.onChange({ target: { value } }); });

  it("starts empty, saves exact explicit text only on Save, and clears back to defaults", async () => {
    const saved: string[] = [];
    let cleared = 0;
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(LaunchCommandField, { label: "Codex", value: "", onSave: (value) => saved.push(value), onClear: () => { cleared++; } }))); });
    expect(input().props.value).toBe("");
    expect(buttons()[0]!.props.disabled).toBeTrue();
    expect(input().props["aria-describedby"]).toBeTruthy();
    await type("  wrapper --flag 'two words'  ");
    expect(saved).toEqual([]);
    expect(input().props.value).toBe("  wrapper --flag 'two words'  ");
    await submit();
    expect(saved).toEqual(["  wrapper --flag 'two words'  "]);
    await act(async () => { renderer.update(createElement(SettingsProvider, null, createElement(LaunchCommandField, { label: "Codex", value: saved[0]!, onSave: (value) => saved.push(value), onClear: () => { cleared++; } }))); });
    expect(buttons()[0]!.props.disabled).toBeTrue();
    await act(async () => { buttons()[1]!.props.onClick(); });
    expect(cleared).toBe(1);
  });

  it("keeps invalid typed text visible without saving or overwriting it on a remote update", async () => {
    const saved: string[] = [];
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(LaunchCommandField, { label: "Codex", value: "previous", onSave: (value) => saved.push(value), onClear: () => {} }))); });
    await type("x".repeat(2001));
    expect(input().props.value).toHaveLength(2001);
    expect(input().props["aria-invalid"]).toBeTrue();
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await submit();
    expect(saved).toEqual([]);
    await act(async () => { renderer.update(createElement(SettingsProvider, null, createElement(LaunchCommandField, { label: "Codex", value: "other-device", onSave: (value) => saved.push(value), onClear: () => {} }))); });
    expect(input().props.value).toHaveLength(2001);
    await type("   ");
    await submit();
    expect(saved).toEqual([]);
  });

  it("visibly refuses invalid pasted lines instead of the browser silently deleting their newline", async () => {
    const saved: string[] = [];
    let prevented = false;
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(LaunchCommandField, { label: "Claude Code", value: "old", onSave: (value) => saved.push(value), onClear: () => {} }))); });
    await act(async () => { input().props.onPaste({ currentTarget: { selectionStart: 0, selectionEnd: 3 }, clipboardData: { getData: () => "wrapper\nsecond command" }, preventDefault: () => { prevented = true; } }); });
    expect(prevented).toBeTrue();
    expect(input().props.value).toBe("old");
    expect(input().props["aria-invalid"]).toBeTrue();
    await submit();
    expect(saved).toEqual([]);
    await type("wrapper");
    expect(input().props["aria-invalid"]).toBeUndefined();
    await submit();
    expect(saved).toEqual(["wrapper"]);
  });
});
