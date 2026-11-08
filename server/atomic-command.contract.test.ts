import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSocketPath } from "../scripts/test-herdr.ts";
import {
  atomicCommandLaunchSupported, ping, sessionSnapshot, tabCreateWithCommand, workspaceClose,
  workspaceCreateWithCommand, worktreeCreateWithCommand, worktreeOpenWithCommand,
} from "./herdr/client.ts";

// Never opt into a default/live daemon, even when this contract is run outside `bun run check`.
const socket = process.env["HERDR_SOCKET"];
const isolated = process.env["HERDR_TEST_MODE"] !== "unit" && process.env["HERDR_TEST_LIVE"] !== "1"
  && process.platform !== "win32" && socket === testSocketPath();
const supported = isolated && await ping(socket).then((identity) => atomicCommandLaunchSupported(identity), () => false);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-atomic-real-")), workspaces: string[] = [];
  const script = join(root, "stand-in.ts");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), marker: process.env.OVIS_ATOMIC_MARKER }));
process.stdin.resume();
`);
  return {
    root, workspaces,
    marker(name: string) {
      const path = join(root, `${name}.json`);
      return { path, command: `  OVIS_ATOMIC_MARKER='  exact 世界  ' ${quote(process.execPath)} ${quote(script)} ${quote(path)} 'literal a b' '世界'  ` };
    },
    async close() {
      try { for (const id of workspaces.reverse()) await workspaceClose(id, socket, true); }
      finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}

/** Poll for complete fixture evidence, bounded as the existing process/marker contracts are. */
async function evidence(path: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return JSON.parse(readFileSync(path, "utf8")) as { args: string[]; cwd: string; marker: string }; }
    catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("atomic stand-in did not write startup evidence");
    await Bun.sleep(Math.min(25, remaining));
  }
}
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Ovis Test", "-c", "user.email=ovis-test@example.invalid", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error("isolated fixture git setup failed");
}
async function stableTree() {
  const snapshot = await sessionSnapshot(socket);
  return {
    workspaces: snapshot.workspaces.map((row) => [row.workspace_id, row.focused]).sort(),
    tabs: snapshot.tabs.map((row) => [row.tab_id, row.workspace_id, row.focused]).sort(),
    panes: snapshot.panes.map((row) => [row.pane_id, row.tab_id, row.focused]).sort(),
  };
}
const expected = (cwd: string) => ({ args: ["literal a b", "世界"], cwd: realpathSync(cwd), marker: "  exact 世界  " });

describe.skipIf(!supported)("real daemon atomic command wrappers", () => {
  it("creates workspace and tab with the command as their initial process, without appended arguments", async () => {
    const f = fixture();
    try {
      const first = f.marker("workspace");
      const workspace = await workspaceCreateWithCommand({ cwd: f.root, label: "ovis-test-atomic", command: first.command }, socket);
      f.workspaces.push(workspace.workspace.workspace_id);
      expect(workspace.type).toBe("workspace_created");
      expect(workspace.tab.workspace_id).toBe(workspace.workspace.workspace_id);
      expect(workspace.root_pane.tab_id).toBe(workspace.tab.tab_id);
      expect(await evidence(first.path)).toEqual(expected(f.root));
      const second = f.marker("tab");
      const tab = await tabCreateWithCommand({ workspaceId: workspace.workspace.workspace_id, cwd: f.root, command: second.command }, socket);
      expect(tab.type).toBe("tab_created");
      expect(tab.tab.workspace_id).toBe(workspace.workspace.workspace_id);
      expect(tab.root_pane.tab_id).toBe(tab.tab.tab_id);
      expect(tab.root_pane.pane_id).not.toBe(workspace.root_pane.pane_id);
      expect(await evidence(second.path)).toEqual(expected(f.root));
    } finally { await f.close(); }
  }, 15_000);

  it("creates and opens worktrees atomically, refusing already-open targets without changing the tree", async () => {
    const f = fixture();
    try {
      const repo = join(f.root, "repo"); mkdirSync(repo);
      git(repo, "init", "-b", "main"); writeFileSync(join(repo, "tracked"), "fixture\n");
      git(repo, "add", "tracked"); git(repo, "commit", "-m", "Fixture");
      const sourceMarker = f.marker("source");
      const source = await workspaceCreateWithCommand({ cwd: repo, command: sourceMarker.command }, socket);
      const workspaceId = source.workspace.workspace_id; f.workspaces.push(workspaceId);
      await evidence(sourceMarker.path);
      const createMarker = f.marker("created"), createdPath = join(f.root, "created-checkout");
      const created = await worktreeCreateWithCommand({ workspaceId, branch: "atomic-created", path: createdPath, command: createMarker.command }, socket);
      f.workspaces.push(created.workspace.workspace_id);
      expect(created.type).toBe("worktree_created");
      expect(created.root_pane.tab_id).toBe(created.tab.tab_id);
      expect(created.worktree.path).toBe(realpathSync(createdPath));
      expect(await evidence(createMarker.path)).toEqual(expected(createdPath));
      const openPath = join(f.root, "existing-checkout");
      git(repo, "worktree", "add", "-b", "atomic-existing", openPath);
      const openMarker = f.marker("opened");
      const opened = await worktreeOpenWithCommand({ workspaceId, path: openPath, command: openMarker.command }, socket);
      f.workspaces.push(opened.workspace.workspace_id);
      expect(opened.type).toBe("worktree_opened"); expect(opened.already_open).toBe(false);
      expect(opened.tab.workspace_id).toBe(opened.workspace.workspace_id);
      expect(await evidence(openMarker.path)).toEqual(expected(openPath));
      const before = await stableTree();
      await expect(worktreeOpenWithCommand({ workspaceId, path: openPath, command: "exit 99" }, socket)).rejects.toMatchObject({ code: "command_target_already_open" });
      expect(await stableTree()).toEqual(before);
      expect(await evidence(openMarker.path)).toEqual(expected(openPath));
    } finally { await f.close(); }
  }, 25_000);
});
