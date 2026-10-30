import { useEffect, useRef, useState } from "react";
import type { BootstrapAttempt } from "../../shared/bootstrap.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";

/** Public setup material only. Copying never executes a command or trusts a host key. */
export function MachineBootstrap({ attempt, name, acknowledged, pending, onAcknowledge, onExpired }: { attempt: BootstrapAttempt; name: string; acknowledged: boolean; pending: boolean; onAcknowledge(value: boolean): void; onExpired(): void }) {
  const t = useT();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, [attempt.id]);
  useEffect(() => {
    const left = attempt.expires_at - Date.now();
    if (left <= 0) { onExpired(); return; }
    const timer = window.setTimeout(onExpired, left);
    return () => window.clearTimeout(timer);
  }, [attempt.id, attempt.expires_at, onExpired]);
  const expired = attempt.expires_at <= Date.now();
  return <section className="machine-bootstrap" aria-labelledby="machine-bootstrap-title">
    <h3 ref={title} tabIndex={-1} id="machine-bootstrap-title">{t("First-time SSH setup")}</h3>
    <p className="field-hint">{t("Run this on {name}, not on the Ovis server. It authorizes this Ovis server’s dedicated public key.", { name })}</p>
    <p className="field-hint">{attempt.target.destination} · {t("SSH port")} 22 · {t("Ovis source: {ip}", { ip: attempt.source_ip })}</p>
    <p className="field-hint">{t("Downloads a fixed GitHub Release and verifies its SHA256 before execution. No Ovis token, password or private key is included.")}</p>
    {attempt.os === "windows" ? <>
      <p className="field-hint">{t("Open PowerShell as Administrator using the same local Windows account entered above. Other accounts and domain accounts require manual SSH setup.")}</p>
      <p className="field-hint">{t("Windows administrator accounts share an SSH key file. The script warns and asks before granting access to that shared file; the key is not restricted to one administrator username.")}</p>
    </> : <p className="field-hint">{t("First enable and review SSH manually: Linux needs a running OpenSSH service; macOS needs Remote Login in System Settings. This command does not start SSH on these systems. sudo may ask for the PC’s administrator password.")}</p>}
    {expired ? <p className="machine-error" role="alert">{t("This setup attempt expired. Go back and generate a new command; do not run the old command.")}</p> : <>
      <p className="field-hint">{t("Connect before {time}. Closing or cancelling discards the pending server key; it does not undo changes already made on the PC.", { time: new Date(attempt.expires_at).toLocaleTimeString() })}</p>
      <BootstrapCommand command={attempt.command} label={t("SSH setup command")} />
      <label className="machine-bootstrap-check"><input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => onAcknowledge(event.target.checked)} /><span>{t("I ran the command successfully on the selected PC and kept its SSH fingerprints for comparison.")}</span></label>
    </>}
    <p className="field-hint">{t("Next, compare the SSH fingerprint and review the installation list. Ovis will not trust a fingerprint or install the bridge automatically.")}</p>
    <BootstrapCleanup command={attempt.cleanup_command} />
  </section>;
}

export function BootstrapCleanup({ command }: { command: string }) {
  const t = useT();
  return <details className="machine-tailnet-help machine-bootstrap-cleanup"><summary>{t("Undo this SSH authorization")}</summary>
    <p className="field-hint">{t("Expiry only discards the pending private key on Ovis. A public key already installed on the PC does not expire. Save this cleanup command and run it there to remove only this key and its app-owned firewall rule. SSH and existing sessions remain running.")}</p>
    <BootstrapCommand command={command} label={t("SSH authorization cleanup command")} />
  </details>;
}

function BootstrapCommand({ command, label }: { command: string; label: string }) {
  const t = useT();
  const text = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { generation.current++; window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    const current = ++generation.current;
    const ok = await copyText(command, text.current);
    if (generation.current !== current) return;
    setCopied(ok); setFailed(!ok);
    window.clearTimeout(timer.current);
    if (ok) timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return <div className="machine-bootstrap-command">
    <pre tabIndex={0} aria-label={label}><code ref={text}>{command}</code></pre>
    <button type="button" className="btn" onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    <span className={copied || failed ? "field-hint" : "visually-hidden"} role="status">{copied ? t("Copied") : failed ? t("Could not copy automatically. Select the command and copy it manually.") : ""}</span>
  </div>;
}
