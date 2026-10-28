import type { MachineSetupInitial } from "../../shared/tailnet.ts";
import { useT } from "../lib/i18n.ts";
import { sshSetupFailure } from "../lib/tailnetSetup.ts";

/** Instructions run on the selected PC, never on the web server or while discovering it. */
export function TailnetSetupHelp({ peer }: { peer: MachineSetupInitial }) {
  const t = useT();
  const windows = peer.os === "windows";
  const mac = peer.os === "darwin" || peer.os === "macos";
  return <>
    <details className="machine-tailnet-help">
      <summary>{t("How to find the remote username")}</summary>
      <p className="field-hint">{t("Run this on the PC you want to add, not on the Ovis server.")}</p>
      <pre><code>{windows ? "whoami\nWrite-Output $env:USERNAME" : "whoami"}</code></pre>
      <p className="field-hint">{windows ? t("In PowerShell, use the local SSH account name shown by $env:USERNAME (usually the part after the backslash in whoami), not the PC name, Microsoft email or Windows Hello PIN. Domain accounts need the manual SSH setup.") : t("Enter the account name printed by whoami, not the computer name.")}</p>
    </details>
    <details className="machine-tailnet-help">
      <summary>{t("First time: enable SSH on this PC")}</summary>
      <p className="field-hint">{t("Tailscale online does not mean SSH is enabled. These instructions change the selected PC only when you run them yourself.")}</p>
      {windows ? <>
        <p className="field-hint">{t("Run in PowerShell as Administrator on the Windows PC:")}</p>
        <pre><code>{"Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0\nStart-Service sshd\nSet-Service -Name sshd -StartupType Automatic"}</code></pre>
        <p className="field-hint">{t("Sign in with the account password or an SSH key, not a Windows Hello PIN.")}</p>
        <p className="field-hint">{t("Windows currently uses a mirrored terminal; the cursor is not shown.")}</p>
      </> : mac ? <p className="field-hint">{t("On the Mac, open System Settings → General → Sharing → Remote Login. Turn it on and allow the account you want to use.")}</p> : <>
        <p className="field-hint">{t("Debian / Ubuntu:")}</p>
        <pre><code>{"sudo apt-get update\nsudo apt-get install openssh-server\nsudo systemctl enable --now ssh"}</code></pre>
        <p className="field-hint">{t("Fedora / RHEL:")}</p>
        <pre><code>{"sudo dnf install openssh-server\nsudo systemctl enable --now sshd"}</code></pre>
        <p className="field-hint">{t("Other Linux distributions: install and start your distribution’s OpenSSH server.")}</p>
      </>}
      <p className="field-hint">{t("Allow the chosen SSH port from the Ovis server over Tailscale in the PC’s firewall and tailnet access rules. No public port forwarding is needed.")}</p>
    </details>
    <p className="field-hint">{t("No Ovis token is needed. Existing SSH keys are tried first; otherwise you may be asked for a password. Verify the host fingerprint and review installation and dedicated-key registration before approving. The key allows later reconnection without a password.")}</p>
  </>;
}

/** Keep SSH's original words visible; the hint names checks, not an unproved diagnosis. */
export function TailnetSetupError({ words }: { words: string }) {
  const t = useT();
  const kind = sshSetupFailure(words);
  const message = kind === "refused" ? t("The PC refused the SSH connection. Check that OpenSSH Server is running on the chosen port; see “First time: enable SSH on this PC”. A firewall can also reject the connection.")
    : kind === "timeout" ? t("The SSH connection timed out. Check that the PC is awake and connected to Tailscale, and that its SSH port is allowed by the firewall and tailnet access rules.")
    : kind === "authentication" ? t("SSH sign-in failed. Check the remote username, account password or SSH key, and whether that account is allowed to sign in over SSH.")
    : kind === "dns" ? t("The server could not resolve the SSH hostname. Tailscale setup uses an IP; check whether the server’s SSH config overrides it with HostName or a proxy.")
    : null;
  return message ? <p className="field-hint" role="alert">{message}</p> : null;
}
