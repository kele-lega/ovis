import { useEffect, useRef, useState } from "react";
import type { MachineSetupInitial, TailnetPeers } from "../../shared/tailnet.ts";
import { machineRequest } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

/** This Host's network map, read only when the page opens or Refresh is chosen. */
export function TailnetPcs({ onAdd }: { onAdd: (initial: MachineSetupInitial) => void }) {
  const t = useT();
  const [result, setResult] = useState<TailnetPeers | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const load = async () => {
    const current = ++generation.current;
    setLoading(true); setFailed(false); setResult(null);
    try { const next = await machineRequest<TailnetPeers>("/tailnet"); if (generation.current === current) setResult(next); }
    catch { if (generation.current === current) setFailed(true); }
    finally { if (generation.current === current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { generation.current++; }; }, []);
  return <SettingsGroup title={t("Tailscale network")} section="tailnet" note={t("PCs owned by this Host’s Tailscale account. Nothing connects until you choose Add PC and confirm the SSH setup.")}>
    <SettingsRow label={t("Discover PCs")} description={t("Reads Tailscale on the web server, not on this browser’s device.")}>
      <button type="button" className="btn" disabled={loading} onClick={() => void load()}>{t("Refresh")}</button>
    </SettingsRow>
    {loading && <p className="settings-item settings-hint" role="status">{t("Loading PCs…")}</p>}
    {(failed || result?.state === "unavailable") && <p className="settings-item settings-hint" role="alert">{t("Could not read Tailscale. Check its service on the web server, then refresh.")}</p>}
    {result?.state === "missing" && <p className="settings-item settings-hint">{t("Tailscale is not installed on the web server. You can still add a PC manually.")}</p>}
    {result?.state === "stopped" && <p className="settings-item settings-hint">{t("Start Tailscale and sign in on the web server, then refresh.")}</p>}
    {result?.state === "identity_unavailable" && <p className="settings-item settings-hint">{t("This Tailscale node has no personal owner. Add PCs manually; other members’ devices are not listed.")}</p>}
    {result?.state === "running" && result.peers.length === 0 && <p className="settings-item settings-hint">{t("No other PCs owned by this Tailscale account were found.")}</p>}
    {result?.peers.map((peer) => <SettingsRow key={peer.id} label={peer.name} wide description={<>
      {peer.os} · {peer.online ? t("Online") : t("Offline")} · {peer.destination}
      {(peer.hostname || peer.dns_name) && <><br />{[peer.hostname, peer.dns_name].filter(Boolean).join(" · ")}</>}
      {peer.registrations.length > 0 && <><br />{t("Already added: {accounts}", { accounts: peer.registrations.map((item) => `${item.user ?? t("SSH default account")}${item.port === null ? "" : `:${item.port}`} / ${item.session} (${item.name})`).join(", ") })}</>}
      {peer.os === "windows" && <><br />{t("Requires OpenSSH Server on this PC.")}</>}
    </>}>
      <button type="button" className="btn" disabled={!peer.online} aria-label={peer.registrations.length ? t("Add another account on {name}", { name: peer.name }) : t("Add {name}", { name: peer.name })} onClick={() => onAdd({ destination: peer.destination, name: peer.name, hostname: peer.hostname, dns_name: peer.dns_name, os: peer.os })}>{peer.registrations.length ? t("Add another account…") : t("Add PC")}</button>
    </SettingsRow>)}
  </SettingsGroup>;
}
