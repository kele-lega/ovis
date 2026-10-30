#!/bin/sh
# Ovis bootstrap-v1. Public-key authorization only; no callback or application install.
# Run from a local administrator terminal after verifying the downloaded SHA-256.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin
export PATH
LC_ALL=C
export LC_ALL
fail() { printf '%s\n' "Ovis: $*" >&2; exit 1; }
usage() { fail 'Usage: sh script --user USER --key "ssh-ed25519 BASE64 ovis:UUID" --from TAILNET_IP --target LOCAL_TAILNET_IP --expires EPOCH [--remove]'; }
user= key= from= target= expires= remove=0
seen=' '
while [ "$#" -gt 0 ]; do
  flag=$1; shift
  case "$seen" in *" $flag "*) usage;; esac
  seen="$seen$flag "
  case "$flag" in
    --remove) remove=1;;
    --user|--key|--from|--target|--expires)
      [ "$#" -gt 0 ] || usage
      value=$1; shift
      case "$flag" in --user) user=$value;; --key) key=$value;; --from) from=$value;; --target) target=$value;; --expires) expires=$value;; esac;;
    *) usage;;
  esac
done
[ -n "$user" ] && [ -n "$key" ] && [ -n "$from" ] && [ -n "$target" ] && [ -n "$expires" ] || usage
for argument in "$user" "$key" "$from" "$target" "$expires"; do
  [ "$(printf '%s' "$argument" | wc -l | tr -d ' ')" = 0 ] || fail 'Arguments must be single-line values.'
done
printf '%s\n' "$user" | grep -Eq '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$' || fail 'Invalid local username.'
printf '%s\n' "$key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]{68} ovis:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || fail 'Expected one real Ed25519 public key with an ovis:UUID comment, without options or newlines.'
[ "$(printf '%s' "$key" | wc -l | tr -d ' ')" = 0 ] || fail 'Key must be a single line.'
printf '%s\n' "$expires" | grep -Eq '^[0-9]{1,11}$' || fail 'Expires must be epoch seconds.'
# Validate and normalize a single numeric address; never accept hostnames, CIDRs or zones.
normalize_ip() {
  printf '%s\n' "$1" | awk '
  /\./ { if (split($0,a,".") != 4) exit 1; for(i=1;i<=4;i++) if(a[i]!~/^[0-9]+$/ || length(a[i])>3 || (length(a[i])>1 && substr(a[i],1,1)=="0") || a[i]+0>255) exit 1; if(a[1]!=100 || a[2]<64 || a[2]>127) exit 1; print $0; next }
  { s=tolower($0); if(s!~/^[0-9a-f:]+$/ || s~/:::/) exit 1;
    n=split(s,a,":"); if(n<4 || n>8+1) exit 1;
    p=index(s,"::"); if(p) { left=substr(s,1,p-1); right=substr(s,p+2); if(index(right,"::")) exit 1; nl=left==""?0:split(left,l,":"); nr=right==""?0:split(right,r,":"); if(nl+nr>=8) exit 1; for(i=1;i<=nl;i++) b[i]=l[i]; for(i=nl+1;i<=8-nr;i++) b[i]="0"; for(i=1;i<=nr;i++) b[8-nr+i]=r[i] }
    else { if(n!=8) exit 1; for(i=1;i<=8;i++) b[i]=a[i] }
    out=""; for(i=1;i<=8;i++) { if(b[i]!~/^[0-9a-f]+$/ || length(b[i])>4) exit 1; v=b[i]; sub(/^0+/,"",v); if(v=="") v="0"; out=out (i==1?"":":") v }
    if(b[1]!="fd7a" || b[2]!="115c" || b[3]!="a1e0") { split(out,c,":"); if(c[1]!="fd7a" || c[2]!="115c" || c[3]!="a1e0") exit 1 } print out
  }'
}
from_normal=$(normalize_ip "$from") || fail 'From must be one Tailscale IPv4 (100.64/10) or IPv6 (fd7a:115c:a1e0::/48).'
target_normal=$(normalize_ip "$target") || fail 'Target must be one Tailscale IPv4 (100.64/10) or IPv6 (fd7a:115c:a1e0::/48).'
[ "$remove" = 1 ] || [ "$expires" -gt "$(date +%s)" ] || fail 'Bootstrap attempt expired; request a new command. Existing authorization does not expire automatically.'
os=$(uname -s)
case "$os" in Linux) decode=-d;; Darwin) decode=-D;; *) fail 'Supported systems: Linux with apt/dnf and systemd, or macOS. Use the Windows script on Windows.';; esac
blob=${key#ssh-ed25519 }; blob=${blob%% *}
# SSH wire format: string("ssh-ed25519"), string(32 public-key bytes), no trailing data.
printf '%s' "$blob" | base64 "$decode" 2>/dev/null | od -An -tu1 | awk '
{ for(i=1;i<=NF;i++) a[++n]=$i }
END { split("0 0 0 11 115 115 104 45 101 100 50 53 53 49 57 0 0 0 32",e," "); if(n!=51) exit 1; for(i=1;i<=19;i++) if(a[i]!=e[i]) exit 1 }' || fail 'Invalid Ed25519 SSH key blob.'
[ "$(id -u)" = 0 ] || fail 'Run this script in a local administrator terminal using sudo (the requested user stays unchanged).'
case "$os" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || fail 'systemd is required; configure OpenSSH manually on this system.'
    systemctl show --property=Version --value >/dev/null 2>&1 || fail 'A running systemd system manager is required.'
    if command -v apt-get >/dev/null 2>&1; then package_manager=apt-get
    elif command -v dnf >/dev/null 2>&1; then package_manager=dnf
    else fail 'Supported Linux package managers are apt and dnf; configure OpenSSH manually.'; fi
    entry=$(awk -F: -v u="$user" '$1==u {print; n++} END {if(n!=1) exit 1}' /etc/passwd) || fail 'Requested account must exist in local /etc/passwd.'
    uid=$(printf '%s\n' "$entry" | cut -d: -f3); gid=$(printf '%s\n' "$entry" | cut -d: -f4); home=$(printf '%s\n' "$entry" | cut -d: -f6)
    command -v runuser >/dev/null 2>&1 || fail 'runuser is required for safe target-user file operations.';;
  Darwin)
    uid=$(dscl . -read "/Users/$user" UniqueID | cut -d ' ' -f2) || fail 'Requested local account does not exist.'
    gid=$(dscl . -read "/Users/$user" PrimaryGroupID | cut -d ' ' -f2)
    home=$(dscl . -read "/Users/$user" NFSHomeDirectory | cut -d ' ' -f2-);;
esac
case "$uid:$gid" in *[!0-9:]*|:*|*:) fail 'Cannot resolve local account UID/GID.';; esac
case "$home" in /*) ;; *) fail 'Local account must have an absolute home directory.';; esac
[ "$home" != / ] || fail 'Refusing a root-directory home.'
# Reject symlinked components, including the home itself; never guess a different home.
check_home() {
  current=$home
  while [ "$current" != / ]; do
    [ ! -L "$current" ] && [ -d "$current" ] || fail "Unsafe home path: $current (symlink or missing directory)."
    current=${current%/*}; [ -n "$current" ] || current=/
  done
}
check_home
sshd=
for candidate in /usr/sbin/sshd /usr/local/sbin/sshd; do [ ! -x "$candidate" ] || { sshd=$candidate; break; }; done
check_sshd() {
  effective=$("$sshd" -T -C "user=$user,host=localhost,addr=$from,laddr=$target,lport=22") || fail 'Cannot inspect sshd configuration. Fix it manually; no config is overwritten.'
  printf '%s\n' "$effective" | awk '$1=="port" {n++; if($2!="22") bad=1} END {exit !(n>0 && !bad)}' || fail 'Existing SSH uses a non-22 port. Configure this account and port manually.'
  auth_path=$(printf '%s\n' "$effective" | awk '$1=="authorizedkeysfile" {$1=""; sub(/^ /,""); print}')
  case "$auth_path" in '.ssh/authorized_keys'|'.ssh/authorized_keys .ssh/authorized_keys2'|'%h/.ssh/authorized_keys') ;; *) fail "Custom AuthorizedKeysFile ($auth_path). Authorize/remove the exact Ovis line manually; no paths are guessed.";; esac
  printf '%s\n' "$effective" | grep -qx 'pubkeyauthentication yes' || fail 'Public-key authentication is disabled; configure SSH manually.'
}
if [ -n "$sshd" ]; then check_sshd
elif [ -s /etc/ssh/sshd_config ]; then fail 'Existing sshd_config cannot be inspected without sshd; install/validate OpenSSH manually first.'
fi
if [ "$remove" = 0 ] && [ "$os" = Linux ]; then
  [ -n "$sshd" ] || fail "OpenSSH is not installed. First configure a firewall allowing TCP/22 only from $from to $target, then manually install openssh-server with $package_manager and enable SSH. Package installation can auto-start a public/password listener; this script will not do that. Review existing SSH access, then rerun."
  unit=$(systemctl list-unit-files ssh.service sshd.service --no-legend | awk '$1=="ssh.service" || $1=="sshd.service" {print $1; exit}')
  [ -n "$unit" ] || fail 'Cannot identify an OpenSSH systemd service; set up OpenSSH manually after reviewing Tailscale-only firewall restrictions.'
  systemctl is-active --quiet "$unit" || fail "OpenSSH is not running. Review existing SSH authentication and restrict TCP/22 to $from → $target in your firewall before manually starting $unit, then rerun. This script does not start a potentially public listener."
fi
# The selected target must be assigned to this machine before ANY modification.
if [ "$os" = Linux ]; then
  command -v ip >/dev/null 2>&1 || fail 'iproute2 is required to verify the selected local Tailscale address.'
  addresses=$(ip -o addr show | awk '{split($4,a,"/"); print a[1]}')
else addresses=$(ifconfig | awk '$1=="inet" || $1=="inet6" {sub(/%.*/,"",$2); print $2}'); fi
found=0
for address in $addresses; do
  normalized=$(normalize_ip "$address" 2>/dev/null) || continue
  [ "$normalized" != "$target_normal" ] || found=1
done
[ "$found" = 1 ] || fail 'Selected Target Tailscale IP is not assigned locally. Run this command on the selected PC.'
if [ "$remove" = 0 ] && [ "$os" = Darwin ]; then
  login=$(systemsetup -getremotelogin 2>&1) || fail 'Cannot inspect Remote Login (TCC/Full Disk Access). In System Settings > General > Sharing > Remote Login choose Only these users and add the requested account, then rerun. No users were broadened.'
  case "$login" in *': On'*) ;; *) fail "Enable Remote Login in System Settings > General > Sharing; choose Only these users and add $user, then rerun. If TCC blocks the CLI, use the GUI; this script never silently enables all users.";; esac
  printf '%s\n' 'Remote Login is already enabled. Review its allowed-user list; existing access is not changed.'
fi
if [ "$remove" = 0 ] && [ -z "$sshd" ]; then
  fail 'OpenSSH must be installed and reviewed manually before bootstrap; no service was installed or started.'
fi
managed="from=\"$from\",no-agent-forwarding,no-X11-forwarding,no-pty $key"
# Filesystem changes run AS the account, not root: a concurrent path swap cannot
# turn a privileged write into an overwrite of another account/system file.
auth_code='
set -eu
home=$1; line=$2; remove=$3; expected_uid=$4
safe() {
  p=$home
  while [ "$p" != / ]; do [ ! -L "$p" ] && [ -d "$p" ] || exit 41; p=${p%/*}; [ -n "$p" ] || p=/; done
  [ ! -L "$home/.ssh" ] || exit 41
  if [ -e "$home/.ssh" ]; then [ -d "$home/.ssh" ] && [ "$(ls -nd "$home/.ssh" | tr -s " " | cut -d " " -f3)" = "$expected_uid" ] || exit 41; fi
  if [ -e "$home/.ssh/authorized_keys" ] || [ -L "$home/.ssh/authorized_keys" ]; then
    [ ! -L "$home/.ssh/authorized_keys" ] && [ -f "$home/.ssh/authorized_keys" ] || exit 41
    [ "$(ls -nd "$home/.ssh/authorized_keys" | tr -s " " | cut -d " " -f2)" = 1 ] || exit 41
    [ "$(ls -nd "$home/.ssh/authorized_keys" | tr -s " " | cut -d " " -f3)" = "$expected_uid" ] || exit 41
  fi
}
safe
file=$home/.ssh/authorized_keys
if [ "$remove" = 1 ] && [ ! -f "$file" ]; then exit 0; fi
if [ "$remove" = 0 ]; then umask 077; mkdir -p "$home/.ssh"; chmod 700 "$home/.ssh"; safe; fi
lock=$home/.ssh/.ovis-authorized-keys.lock
umask 077
mkdir "$lock" || { printf "%s\n" "Another Ovis key update is running (or a stale lock needs manual review): $lock" >&2; exit 42; }
tmp=
trap '\''[ -z "$tmp" ] || rm -f "$tmp"; rmdir "$lock"'\'' EXIT HUP INT TERM
safe
if [ -f "$file" ]; then
  if [ "$remove" = 0 ] && grep -Fxq -- "$line" "$file"; then chmod 600 "$file"; exit 0; fi
  if [ "$remove" = 1 ] && ! grep -Fxq -- "$line" "$file"; then exit 0; fi
fi
umask 077
tmp=$(mktemp "$home/.ssh/.ovis-key.XXXXXXXX")
if [ -f "$file" ]; then
  if [ "$remove" = 1 ]; then awk -v line="$line" '\''$0 != line {print}'\'' "$file" > "$tmp"
  else cp "$file" "$tmp"; [ ! -s "$tmp" ] || printf "\n" >> "$tmp"; fi
fi
[ "$remove" = 1 ] || printf "%s\n" "$line" >> "$tmp"
chmod 600 "$tmp"
safe
mv -f "$tmp" "$file"
'
if [ "$os" = Linux ]; then runuser -u "$user" -- /bin/sh -c "$auth_code" sh "$home" "$managed" "$remove" "$uid" || fail 'Unsafe/inaccessible home, .ssh or authorized_keys (symlink, hardlink, wrong owner). Fix ownership/path manually and rerun.'
else sudo -u "#$uid" /bin/sh -c "$auth_code" sh "$home" "$managed" "$remove" "$uid" || fail 'Unsafe/inaccessible home, .ssh or authorized_keys. Fix ownership/path manually and rerun.'; fi
if [ "$remove" = 1 ]; then
  printf '%s\n' 'Removed only the exact Ovis authorization line, if present. SSH, other keys and firewall settings were not changed.'
  exit 0
fi
if [ "$os" = Linux ]; then
  # The unit was verified active before authorization. Do not start/restart it,
  # even if it became inactive meanwhile; only retain its boot enablement.
  systemctl enable "$unit"
fi
printf '\n%s\n' "SSH account: $user ; port: 22 ; target: $target ; permitted key source: $from"
printf '%s\n' 'SSH host SHA-256 fingerprints (compare manually in Ovis before approving this deployment):'
for pub in /etc/ssh/ssh_host_*_key.pub; do [ ! -f "$pub" ] || ssh-keygen -lf "$pub" -E sha256; done
printf '%s\n' 'No firewall rules were changed. If filtering is required, manually allow TCP/22 only from the Ovis Tailscale IP to this target Tailscale IP; never open it globally.'
printf '%s\n' 'The 15-minute limit concerns only the pending Ovis server private key; installed SSH authorization does NOT expire. If approval fails/expires, rerun the same command with --remove on this PC.'
printf '%s\n' 'Existing SSH authentication/access remains unchanged. No Tailscale SSH, public forwarding, DNS, callbacks or application installation was configured.'
