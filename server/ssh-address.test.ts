import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { forgetSshAddresses, literalAddress, pinLiteralSshTarget, resolveWithSsh, samePc, sshAddress, sshAddresses, warmSshAddresses } from "./ssh-address.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); forgetSshAddresses(); });

describe("guided SSH address identity", () => {
  it("never consults ambient SSH configuration even for metadata-only lookups", async () => {
    const resolve = spyOn(sshAddresses, "resolve").mockResolvedValue("mallory@elsewhere.invalid:22");
    cleanup.push(() => resolve.mockRestore());
    const target = pinLiteralSshTarget({ destination: "alice@100.70.1.2", port: 22 });
    expect(sshAddress(target)).toBe("alice@100.70.1.2:22");
    await warmSshAddresses([target]);
    expect(await resolveWithSsh(target)).toBe("alice@100.70.1.2:22");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps ordinary aliases resolved while a guided literal cannot share their cached override", async () => {
    const resolve = spyOn(sshAddresses, "resolve").mockImplementation(async (target) => target.destination === "lab" ? "alice@100.70.1.2:22" : "alice@elsewhere.invalid:22");
    cleanup.push(() => resolve.mockRestore());
    const ordinary = { destination: "alice@100.70.1.2", port: 22 };
    const guided = pinLiteralSshTarget({ ...ordinary });
    const alias = { destination: "lab" };
    await warmSshAddresses([ordinary, guided, alias]);
    expect(sshAddress(ordinary)).toBe("alice@elsewhere.invalid:22");
    expect(sshAddress(guided)).toBe(literalAddress(guided));
    expect(samePc(guided, alias)).toBe(true);
    expect(samePc(guided, ordinary)).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
