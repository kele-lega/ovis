import { BRIDGE_PROTOCOL, type Machine } from "../shared/machines.ts";
import { isJsonObject } from "./http.ts";
import { discard, readCappedJson, REMOTE_LIMITS } from "./remote-json.ts";

/**
 * A selected PC's current authenticated Ovis AND daemon must approve a command before a create
 * reaches it. An older Ovis may ignore that field, even when its daemon supports atomic creation.
 * A relay endpoint's token opens the local protected tunnel, not B's bridge authentication: use
 * that paired channel's health instead. herdr-core machines cannot implement this contract yet.
 */
export async function remoteCommandLaunchSupported(
  endpoint: { url: string; token: string },
  kind: Machine["kind"] | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (kind !== "ssh" && kind !== "relay") return false;
  const ssh = kind === "ssh";
  try {
    const proof = await fetch(`${endpoint.url}/api/${ssh ? "bridge" : "health"}`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!proof.ok) { await discard(proof); return false; }
    const identity = await readCappedJson<unknown>(proof, ssh ? REMOTE_LIMITS.bridgeIdentity : REMOTE_LIMITS.health);
    if (!isJsonObject(identity) || identity["launch_command"] !== true
      || (ssh && identity["bridge_protocol"] !== BRIDGE_PROTOCOL)
      || (!ssh && identity["ok"] !== true)
      || identity["runtime"] === "herdr-core") return false;
    const herdr = identity["herdr"];
    if (!isJsonObject(herdr) || !Number.isInteger(herdr["protocol"])
      || (herdr["protocol"] as number) < 22 || herdr["runtime"] === "herdr-core") return false;
    const capabilities = herdr["capabilities"];
    return isJsonObject(capabilities) && capabilities["atomic_command_launch"] === true;
  } catch {
    // Never echo a remote answer, URL, credential or uncertain transport error to the browser.
    return false;
  }
}
