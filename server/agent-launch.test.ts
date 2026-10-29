import { describe, expect, it } from "bun:test";
import type { AgentPayload } from "./agent-launch.ts";
import { agentFault } from "./agent-launch.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";

describe("deferred custom agent commands", () => {
  it("refuses any supplied command instead of silently launching the default", () => {
    for (const command of ["fixture-custom", "", null, false, 42, undefined]) {
      expect(agentFault({ kind: "claude", command } as AgentPayload)).toContain("Custom agent commands are unavailable");
      expect(agentFault({ kind: "claude", command, args: [] } as AgentPayload)).toContain("Custom agent commands are unavailable");
    }
    expect(agentFault({ kind: "claude" })).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "fixture-model"] })).toBeNull();
  });

  it("refuses stale create requests before contacting Herdr or creating anything", async () => {
    const unexpected = (): never => { throw new Error("Must not create or launch anything"); };
    for (const pathname of ["/api/workspace/create", "/api/tab/create", "/api/worktree/create"]) {
      const url = new URL(pathname, "http://localhost");
      const request = new Request(url, { method: "POST", body: JSON.stringify({
        workspace_id: "not-a-real-workspace", branch: "fixture", agent: { kind: "claude", command: "fixture-custom" },
      }) });
      const response = await handleWorkspaceRequest(request, url, pathname, { timeout: unexpected }, unexpected, unexpected, unexpected);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: {
        code: "invalid_agent", message: "Custom agent commands are unavailable in this release; reload Ovis before creating an agent",
      } });
    }
  });
});
