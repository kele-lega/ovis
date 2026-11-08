import { describe, expect, it } from "bun:test";
import { agentFault } from "./agent-launch.ts";

describe("agent launch selection", () => {
  it("retains standard argument validation without requiring atomic capability", () => {
    expect(agentFault({ kind: "claude" })).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "fixture-model"] })).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "two words"] })).not.toBeNull();
  });
  it("recognizes custom commands without altering them or accepting an args fallback", () => {
    const command = "  wrapper --model 'two words'  ";
    const agent = { kind: "claude", command };
    expect(agentFault(agent, "linux")).toBeNull(); expect(agent.command).toBe(command);
    expect(agentFault({ ...agent, args: [] }, "linux")).toContain("mutually exclusive");
    expect(agentFault(agent, "win32")).toContain("not supported on Windows");
    expect(agentFault({ kind: "claude", command: undefined })).not.toBeNull();
  });
});
