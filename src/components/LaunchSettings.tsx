import { useId, useState } from "react";
import { launchCommandFault } from "../../shared/launch-rules.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import { agentCommand, CLAUDE_LAUNCH_MODES, CODEX_LAUNCH_MODES, type ClaudeLaunchMode, type CodexLaunchMode } from "../lib/agentLaunchMode.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { useLaunchAgents } from "../lib/useLaunchAgents.ts";
import { SettingsGroup, SettingsRow, SettingsSelect } from "./SettingsControls.tsx";

function claudeModeName(mode: ClaudeLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "acceptEdits" ? t("Accept edits") : mode === "auto" ? t("Auto") : mode === "plan" ? t("Plan")
    : mode === "dontAsk" ? t("Don't ask") : mode === "bypassPermissions" ? t("Bypass permissions") : t("Agent default");
}
function codexModeName(mode: CodexLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "readOnly" ? t("Read only") : mode === "auto" ? t("Auto") : mode === "fullAccess" ? t("Full access") : t("Agent default");
}

/** An unsaved/invalid draft stays here, not in sanitized preferences. Nothing is enabled by a placeholder. */
export function LaunchCommandField({ label, value, onSave, onClear }: { label: string; value: string; onSave: (command: string) => void; onClear: () => void }) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState(false);
  const text = draft ?? value;
  const invalid = pasteError || ((draft !== null || text !== "") && launchCommandFault(text) !== null);
  const save = () => {
    if (invalid || launchCommandFault(text) !== null) return;
    onSave(text);
    setDraft(null);
  };
  return <div className="settings-item launch-command-field">
    <label className="settings-label" htmlFor={id}>{t("Full command for {agent}", { agent: label })}</label>
    <form className="launch-command-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input id={id} className="input" type="text" value={text} placeholder={t("Agent default")}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        aria-invalid={invalid || undefined} aria-describedby={`${id}-status`}
        onChange={(event) => { setDraft(event.target.value); setPasteError(false); }}
        onPaste={(event) => {
          const field = event.currentTarget;
          const candidate = text.slice(0, field.selectionStart ?? text.length) + event.clipboardData.getData("text") + text.slice(field.selectionEnd ?? text.length);
          // Text inputs silently remove pasted line breaks. Refuse visibly instead of saving a different command.
          if (launchCommandFault(candidate) !== null) { event.preventDefault(); setPasteError(true); }
        }}
        onDrop={(event) => { event.preventDefault(); setPasteError(true); }} />
      <div className="settings-actions">
        <button type="submit" className="btn" disabled={invalid || !text.trim() || text === value} aria-label={t("Save command for {agent}", { agent: label })}>{t("Save")}</button>
        <button type="button" className="btn btn-ghost" disabled={draft === null && !value && !pasteError} aria-label={t("Clear command for {agent}", { agent: label })}
          onClick={() => { onClear(); setDraft(null); setPasteError(false); }}>{t("Clear command")}</button>
      </div>
    </form>
    <p id={`${id}-status`} className={`settings-hint${invalid ? " launch-command-error" : ""}`} role={invalid ? "alert" : "status"}>
      {invalid ? t("Use one nonblank line, at most 2000 characters, with no control characters. Invalid text is not saved.")
        : text !== value ? t("Not saved. The previous launch setting is still used.")
          : value ? t("Saved custom command. No permission, model or effort flags are added.") : t("No custom command. Uses the agent's default launch.")}
    </p>
  </div>;
}

/** Settings > Chat > New agents. Zed's explicit per-agent launch configuration, in Ovis's existing rows. */
export function LaunchSettings() {
  const { settings, update } = useSettings();
  const t = useT();
  const { fetchAgentKinds } = useMachineApi();
  const { agents } = useLaunchAgents(true, fetchAgentKinds, settings.agentCommands);
  const clear = (kind: string) => update({ agentCommands: Object.fromEntries(Object.entries(settings.agentCommands).filter(([key]) => key !== kind)) });
  return <SettingsGroup title={t("New agents")} section="launch-modes" note={t("Applies to New workspace, New tab and New worktree only. Resume is unchanged. Save a full command to replace the normal launch; clear it to use the agent's defaults again.")}>
    <SettingsRow label="Claude Code" description={t("Permission mode")} htmlFor="settings-claude-launch-mode">
      <SettingsSelect id="settings-claude-launch-mode" value={settings.claudeLaunchMode} disabled={agentCommand("claude", settings) !== null} onChange={(event) => update({ claudeLaunchMode: event.target.value as ClaudeLaunchMode })}>
        {CLAUDE_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{claudeModeName(mode, t)}</option>)}
      </SettingsSelect>
    </SettingsRow>
    <SettingsRow label="Codex" description={t("Sandbox and approvals")} htmlFor="settings-codex-launch-mode">
      <SettingsSelect id="settings-codex-launch-mode" value={settings.codexLaunchMode} disabled={agentCommand("codex", settings) !== null} onChange={(event) => update({ codexLaunchMode: event.target.value as CodexLaunchMode })}>
        {CODEX_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{codexModeName(mode, t)}</option>)}
      </SettingsSelect>
    </SettingsRow>
    <p className="settings-item settings-hint">{t("Commands are stored in plaintext and shared across devices. Do not include passwords, API keys or other secrets. Use a wrapper script or environment variables on the PC instead.")}</p>
    {[...SUPPORTED_AGENT_KINDS].map((kind) => <LaunchCommandField key={kind} label={agents.find((agent) => agent.kind === kind)?.label ?? (kind === "claude" ? "Claude Code" : kind === "codex" ? "Codex" : kind)}
      value={agentCommand(kind, settings) ?? ""} onSave={(command) => update({ agentCommands: { ...settings.agentCommands, [kind]: command } })} onClear={() => clear(kind)} />)}
  </SettingsGroup>;
}
