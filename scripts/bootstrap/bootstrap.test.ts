import { describe, expect, test } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { BOOTSTRAP_ASSETS } from '../../server/bootstrap-assets.ts';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = import.meta.dir;
const shell = join(directory, 'ovis-bootstrap.sh');
const powershell = join(directory, 'ovis-bootstrap.ps1');
const uuid = '74abb0b9-8021-4632-9d0f-14a5796c442c';
const { publicKey } = generateKeyPairSync('ed25519');
const raw = createPublicKey({ key: publicKey.export({ format: 'pem', type: 'spki' }), format: 'pem' }).export({ format: 'der', type: 'spki' }).subarray(-32);
const key = `ssh-ed25519 ${Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64')} ovis:${uuid}`;
const from = '100.64.0.10';
const target = '100.100.0.20';
const line = `from="${from}",no-agent-forwarding,no-X11-forwarding,no-pty ${key}`;
const future = '99999999999';
const args = ['--user', 'alice', '--key', key, '--from', from, '--target', target, '--expires', future];
const unix = process.platform !== 'win32';
const powershellCommand = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
function runPowerShell(arguments_: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ovis-bootstrap-pwsh-')));
  try {
    return spawnSync(powershellCommand, ['-NoLogo', '-NoProfile', ...arguments_], {
      encoding: 'utf8', cwd: root,
      env: {
        ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
        XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
        APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), OVIS_STATE_DIR: join(root, 'ovis-state'),
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const powershellAvailable = runPowerShell(['-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

// Instrument a COPY, never the publishable script. Every host-changing command
// and absolute system path is replaced; the fixture refuses unmocked commands.
function fixture(os = 'Linux') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ovis-bootstrap-')));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const etc = join(root, 'etc');
  mkdirSync(bin); mkdirSync(home); mkdirSync(join(etc, 'ssh'), { recursive: true });
  const log = join(root, 'commands.log');
  writeFileSync(log, '');
  writeFileSync(join(etc, 'passwd'), `alice:x:${process.getuid!()}:${process.getgid!()}:Alice:${home}:/bin/sh\n`);
  const mock = (name: string, content: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nset -eu\nprintf '%s\\n' '${name}' >> '${log}'\n${content}\n`);
    chmodSync(path, 0o755);
  };
  mock('uname', `printf '%s\\n' '${os}'`);
  mock('id', 'printf 0');
  mock('systemctl', `case "$1" in show) exit 0;; list-unit-files) printf 'ssh.service enabled\\n';; is-active) exit 0;; enable) exit 0;; *) exit 90;; esac`);
  mock('apt-get', 'exit 91'); mock('dnf', 'exit 91');
  mock('ip', `printf '1: tailscale0 inet ${target}/32 scope global\\n1: tailscale0 inet6 fd7a:115c:a1e0::123/128 scope global\\n'`);
  mock('ifconfig', `printf ' inet ${target} netmask 0xffffffff\\n inet6 fd7a:115c:a1e0::123 prefixlen 128\\n'`);
  mock('dscl', `case "$4" in UniqueID) printf 'UniqueID: ${process.getuid!()}\\n';; PrimaryGroupID) printf 'PrimaryGroupID: ${process.getgid!()}\\n';; NFSHomeDirectory) printf 'NFSHomeDirectory: ${home}\\n';; *) exit 92;; esac`);
  mock('systemsetup', `printf 'Remote Login: On\\n'`);
  mock('runuser', 'shift 3; exec "$@"');
  mock('sudo', 'shift 2; exec "$@"');
  const sshd = join(bin, 'sshd');
  mock('sshd', `printf 'port 22\\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2\\npubkeyauthentication yes\\n'`);
  mock('ssh-keygen', 'printf "256 SHA256:fixture (ED25519)\\n"');
  // macOS base64 uses -D; adapt only that fixture when hosted on Linux.
  if (os === 'Darwin' && process.platform === 'linux') mock('base64', 'exec /usr/bin/base64 -d');
  const script = join(root, 'script.sh');
  const text = readFileSync(shell, 'utf8')
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin', `PATH=${bin}:/usr/bin:/bin`)
    .replaceAll('/etc/passwd', join(etc, 'passwd'))
    .replaceAll('/etc/ssh/', `${etc}/ssh/`)
    .replace('for candidate in /usr/sbin/sshd /usr/local/sbin/sshd;', `for candidate in ${sshd};`);
  writeFileSync(script, text);
  return {
    root, home, log, mock, bin, script,
    run(options = args) { return spawnSync('/bin/sh', [script, ...options], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } }); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
function replaceArgument(flag: string, value: string) { const result = [...args]; result[result.indexOf(flag) + 1] = value; return result; }

(unix ? describe : describe.skip)('POSIX bootstrap (isolated commands and temp account roots)', () => {
  test('POSIX syntax is valid', () => { expect(spawnSync('/bin/sh', ['-n', shell]).status).toBe(0); });
  test('installs exact restricted line, preserves other keys and is idempotent', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.home, '.ssh')); writeFileSync(join(f.home, '.ssh/authorized_keys'), 'unrelated-key\n');
      for (let i = 0; i < 2; i++) { const r = f.run(); expect(r.stderr).toBe(''); expect(r.status).toBe(0); }
      const contents = readFileSync(join(f.home, '.ssh/authorized_keys'), 'utf8');
      expect(contents).toContain('unrelated-key\n'); expect(contents.split(line).length - 1).toBe(1);
      const commands = readFileSync(f.log, 'utf8'); expect(commands).not.toContain('apt-get'); expect(commands).not.toContain('dnf');
      expect(f.run().stdout).toContain('authorization does NOT expire');
    } finally { f.cleanup(); }
  });
  test('a concurrent/stale authorization lock refuses changes without deleting the lock', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.home, '.ssh'));
      const file = join(f.home, '.ssh/authorized_keys'); writeFileSync(file, 'unrelated-key\n');
      const lock = join(f.home, '.ssh/.ovis-authorized-keys.lock'); mkdirSync(lock);
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('unrelated-key\n');
      expect(() => mkdirSync(lock)).toThrow();
      rmSync(lock, { recursive: true }); expect(f.run().status).toBe(0);
    } finally { f.cleanup(); }
  });
  test('remove accepts expired attempt and removes only exact line without enabling service', () => {
    const f = fixture();
    try {
      expect(f.run().status).toBe(0);
      const file = join(f.home, '.ssh/authorized_keys'); const other = line.replace(from, '100.64.0.11');
      writeFileSync(file, `${line}\n${other}\nother-key\n${line}\n`); writeFileSync(f.log, '');
      expect(f.run([...replaceArgument('--expires', '1'), '--remove']).status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(`${other}\nother-key\n`);
      expect(readFileSync(f.log, 'utf8')).not.toContain('ssh-keygen');
      expect(f.run([...replaceArgument('--expires', '1'), '--remove']).status).toBe(0);
    } finally { f.cleanup(); }
  });
  for (const [flag, value] of [
    ['--user', 'a/b'], ['--user', '-root'], ['--user', 'x\nbad'], ['--user', 'a'.repeat(129)],
    ['--key', key.replace('ovis:', 'other:')], ['--key', `${key}\n`], ['--key', key.replace('AAAAC3', 'AAAAA3')],
    ['--key', `ssh-ed25519 ${Buffer.alloc(51).toString('base64')} ovis:${uuid}`],
    ['--from', '100.63.255.255'], ['--from', '100.128.0.0'], ['--from', '100.064.0.1'],
    ['--from', '100.64.0.1/32'], ['--from', '100.64.0.1,100.64.0.2'], ['--from', 'example.com'],
    ['--from', 'fd7b:115c:a1e0::1'], ['--from', 'fd7a:115c:a1e0::1%ts'], ['--from', 'fd7a:115c:a1e0:::1'],
    ['--target', '192.168.1.1'], ['--target', '100.64.99.99'], ['--expires', '1'], ['--expires', '1e10'],
  ]) test(`rejects ${flag} ${JSON.stringify(value)} before authorization`, () => {
    const f = fixture();
    try { expect(f.run(replaceArgument(flag!, value!)).status).not.toBe(0); expect(() => readFileSync(join(f.home, '.ssh/authorized_keys'))).toThrow(); expect(readFileSync(f.log, 'utf8')).not.toContain('runuser'); }
    finally { f.cleanup(); }
  });
  test('accepts canonical/expanded Tailscale IPv6, verifies equivalent local IP', () => {
    const f = fixture();
    try {
      const options = replaceArgument('--target', 'fd7a:115c:a1e0:0000:0:0:0:0123'); options[options.indexOf('--from') + 1] = 'fd7a:115c:a1e0::42';
      const r = f.run(options); expect(r.stderr).toBe(''); expect(r.status).toBe(0);
    } finally { f.cleanup(); }
  });
  test('rejects unsupported OS, custom SSH port/auth path before changes', () => {
    for (const config of ['port 2200\nauthorizedkeysfile .ssh/authorized_keys\npubkeyauthentication yes', 'port 22\nauthorizedkeysfile /custom/keys\npubkeyauthentication yes']) {
      const f = fixture();
      try { f.mock('sshd', `printf '%s\\n' '${config}'`); expect(f.run().status).not.toBe(0); expect(readFileSync(f.log, 'utf8')).not.toContain('runuser'); }
      finally { f.cleanup(); }
    }
    const f = fixture('FreeBSD'); try { expect(f.run().status).not.toBe(0); expect(readFileSync(f.log, 'utf8')).not.toContain('runuser'); } finally { f.cleanup(); }
  });
  test('refuses symlink home/.ssh/key and hardlink key without modifying victim', () => {
    for (const hazard of ['home', 'directory', 'file', 'hardlink']) {
      const f = fixture();
      try {
        const victim = join(f.root, 'victim'); writeFileSync(victim, 'unchanged\n');
        if (hazard === 'home') { rmSync(f.home, { recursive: true }); symlinkSync(f.root, f.home); }
        else if (hazard === 'directory') { symlinkSync(f.root, join(f.home, '.ssh')); }
        else { mkdirSync(join(f.home, '.ssh')); if (hazard === 'file') symlinkSync(victim, join(f.home, '.ssh/authorized_keys')); else linkSync(victim, join(f.home, '.ssh/authorized_keys')); }
        expect(f.run().status).not.toBe(0); expect(readFileSync(victim, 'utf8')).toBe('unchanged\n');
      } finally { f.cleanup(); }
    }
  });
  test('macOS GUI/TCC fallback makes no authorization changes and never broadens users', () => {
    const f = fixture('Darwin');
    try {
      f.mock('systemsetup', 'exit 1'); expect(f.run().stderr).toContain('System Settings');
      expect(readFileSync(f.log, 'utf8')).not.toContain('sudo');
      f.mock('systemsetup', "printf 'Remote Login: Off\\n'"); expect(f.run().status).not.toBe(0);
      f.mock('systemsetup', "printf 'Remote Login: On\\n'"); const r = f.run(); expect(r.stderr).toBe(''); expect(r.status).toBe(0);
    } finally { f.cleanup(); }
  });
});

describe('publishable artifact contract', () => {
  test('built-in pins match the exact publishable scripts', () => {
    for (const [os, asset] of Object.entries(BOOTSTRAP_ASSETS)) {
      const file = os === 'windows' ? powershell : shell;
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(asset.sha256);
      expect(asset.url).toBe('https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/' + (os === 'windows' ? 'ovis-bootstrap.ps1' : 'ovis-bootstrap.sh'));
    }
  });
  test('standalone scripts retain LF bytes, fixed interface and no test bypass environment', () => {
    for (const path of [shell, powershell]) {
      const text = readFileSync(path, 'utf8'); expect(text).not.toContain('\r'); expect(text).not.toContain('OVIS_TEST');
      expect(text).not.toMatch(/https?:\/\//); expect(text).not.toMatch(/Restart-Service|systemctl restart|--setremotelogin/);
      expect(text).toContain('no-agent-forwarding,no-X11-forwarding,no-pty');
    }
  });
  test('CI requires a native PowerShell parser', () => {
    if (process.env.CI || process.env.OVIS_REQUIRE_POWERSHELL) expect(powershellAvailable).toBe(true);
  });
  test.skipIf(!powershellAvailable)('native PowerShell parser and mocked helpers (no host SSH/firewall calls)', () => {
    const r = runPowerShell(['-File', resolve(directory, 'tests/helpers/test-powershell.ps1'), '-Script', powershell, '-ValidKey', key]);
    expect(r.stdout + r.stderr).toContain('PowerShell missing-host-key regressions passed');
    expect(r.stdout + r.stderr).toContain('PowerShell bootstrap mocked tests passed'); expect(r.status).toBe(0);
  });
});
