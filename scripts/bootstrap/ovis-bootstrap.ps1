# Ovis bootstrap-v1. Public-key authorization only; no callback or application install.
# Verify the artifact SHA-256, then run from the requested local user's elevated terminal.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$From,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Expires,
    [switch]$Remove
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-OvisAddress([string]$Value) {
    if ($Value -notmatch '\A[0-9A-Fa-f:.]+\z' -or $Value.Contains('%')) { throw 'Use one numeric Tailscale IP, not a hostname, CIDR or zone.' }
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$ip)) { throw 'Invalid IP address.' }
    $bytes = $ip.GetAddressBytes()
    if ($bytes.Length -eq 4) {
        if ($Value -notmatch '\A(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\z' -or $bytes[0] -ne 100 -or $bytes[1] -lt 64 -or $bytes[1] -gt 127) { throw 'IPv4 must be one Tailscale IP in 100.64/10.' }
    } elseif ($bytes.Length -ne 16 -or $bytes[0] -ne 0xfd -or $bytes[1] -ne 0x7a -or $bytes[2] -ne 0x11 -or $bytes[3] -ne 0x5c -or $bytes[4] -ne 0xa1 -or $bytes[5] -ne 0xe0) { throw 'IPv6 must be one Tailscale IP in fd7a:115c:a1e0::/48.' }
    return $ip.ToString()
}
function Test-OvisArguments {
    if ($User -cnotmatch '\A[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}\z') { throw 'Invalid local username.' }
    if ($Key -cnotmatch '\Assh-ed25519 ([A-Za-z0-9+/]{68}) ovis:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\z') { throw 'Expected one real Ed25519 public key with an ovis:UUID comment and no options/newlines.' }
    $blob = [Convert]::FromBase64String($Matches[1])
    $id = $Matches[2]
    $header = [byte[]](0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 0, 0, 0, 32)
    if ($blob.Length -ne 51) { throw 'Invalid Ed25519 SSH key blob length.' }
    for ($i = 0; $i -lt $header.Length; $i++) { if ($blob[$i] -ne $header[$i]) { throw 'Invalid Ed25519 SSH wire-format key blob.' } }
    $source = ConvertTo-OvisAddress $From
    $destination = ConvertTo-OvisAddress $Target
    if ($Expires -cnotmatch '\A[0-9]{1,11}\z') { throw 'Expires must be epoch seconds.' }
    if (-not $Remove -and [long]$Expires -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) { throw 'Bootstrap attempt expired; request a new command. Existing authorization does not expire automatically.' }
    return @{ Id = $id; Source = $source; Destination = $destination; Line = "from=`"$From`",no-agent-forwarding,no-X11-forwarding,no-pty $Key" }
}
function Assert-OvisSafePath([string]$Path, [bool]$Directory) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\') -or $Path -notmatch '\A[A-Za-z]:\\') { throw "Use a local, absolute drive path: $Path" }
    $full = [IO.Path]::GetFullPath($Path)
    $part = $full
    while ($part) {
        $item = Get-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point/symlink: $part" }
            if ($part -ne $full -and -not $item.PSIsContainer) { throw "Non-directory path component: $part" }
            if ($part -eq $full) {
                if ($item.PSIsContainer -ne $Directory) { throw "Unexpected file type: $part" }
                if (-not $Directory) {
                    # LinkType is absent in some Windows PowerShell FileInfo adapters;
                    # fsutil is the authoritative hard-link check on supported Windows.
                    $links = @(& "$env:SystemRoot\System32\fsutil.exe" hardlink list $part 2>&1)
                    if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw "Refusing hardlinked or unverifiable file: $part" }
                }
            }
        }
        $parent = [IO.Path]::GetDirectoryName($part.TrimEnd('\'))
        if ($parent -eq $part) { break }
        $part = $parent
    }
}
function Set-OvisAcl([string]$Path, [string]$AccountSid, [bool]$Directory, [bool]$SharedAdmin) {
    Assert-OvisSafePath $Path $Directory
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $owner = New-Object Security.Principal.SecurityIdentifier($AccountSid)
    if ($SharedAdmin) { $owner = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544') }
    $acl.SetOwner($owner)
    $sids = @('S-1-5-18', 'S-1-5-32-544')
    if (-not $SharedAdmin) { $sids += $AccountSid }
    foreach ($sid in $sids) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        if ($Directory) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Invoke-OvisSshCommand([string]$Command, [string[]]$Arguments) {
    # Windows PowerShell wraps redirected native stderr in NativeCommandError.
    # Capture it and the exit code without changing the caller's fail-closed policy.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = @(& $Command @Arguments 2>&1)
    return @{ Output = $output; ExitCode = $LASTEXITCODE }
}
function Initialize-OvisDefaultHostKeys([string]$Sshd, [string]$Config) {
    $template = Join-Path (Split-Path $Sshd) 'sshd_config_default'
    Assert-OvisSafePath $template $false
    if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw 'Cannot verify the packaged OpenSSH default configuration; initialize host keys manually.' }
    $contents = [IO.File]::ReadAllText($Config)
    # Do not invent a config parser or generate unused keys for a custom config.
    if ($contents -cne [IO.File]::ReadAllText($template) -or $contents -match '(?im)^\s*(HostKey|HostKeyAgent|HostCertificate|Include)\b') { throw 'Host keys are missing from a custom SSH configuration; initialize them manually. No keys were replaced.' }
    $directory = Join-Path $env:ProgramData 'ssh'
    Assert-OvisSafePath $directory $true
    $missing = @()
    # Include legacy/new default names in safety checks even when this OpenSSH
    # build does not generate those types. Never replace an empty key or lone .pub.
    foreach ($type in @('rsa', 'dsa', 'ecdsa', 'ed25519', 'mldsa44_ed25519')) {
        $private = Join-Path $directory "ssh_host_${type}_key"
        $public = "$private.pub"
        Assert-OvisSafePath $private $false
        Assert-OvisSafePath $public $false
        if (Test-Path -LiteralPath $private) {
            if ((Get-Item -LiteralPath $private -Force).Length -eq 0) { throw 'An existing SSH host key is empty; repair it manually. No keys were replaced.' }
        } elseif (Test-Path -LiteralPath $public) { throw 'An SSH host public key has no private key; repair it manually. No keys were replaced.' }
        elseif ($type -in @('rsa', 'ecdsa', 'ed25519')) { $missing += $private }
    }
    if ($missing.Count -eq 0) { throw 'Default SSH host keys exist but could not be loaded; repair them manually.' }
    $keygen = Join-Path (Split-Path $Sshd) 'ssh-keygen.exe'
    Assert-OvisSafePath $keygen $false
    if (-not (Test-Path -LiteralPath $keygen -PathType Leaf)) { throw 'Packaged ssh-keygen.exe is missing; initialize host keys manually.' }
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    # OpenSSH -A generates only absent default private keys (and their .pub files).
    # It can report individual failures on stderr even with a zero process exit.
    $result = Invoke-OvisSshCommand $keygen @('-A')
    if ($result.ExitCode -ne 0 -or @($result.Output | Where-Object { $_ -is [Management.Automation.ErrorRecord] }).Count -ne 0) { throw 'Could not initialize missing SSH host keys; repair manually or retry. Existing keys were not replaced.' }
    foreach ($private in $missing) {
        foreach ($path in @($private, "$private.pub")) {
            Assert-OvisSafePath $path $false
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path -Force).Length -eq 0) { throw 'OpenSSH did not initialize all missing default host keys; repair manually or retry.' }
        }
    }
}
function Assert-OvisSshConfig([string]$Sshd, [bool]$SharedAdmin, [bool]$InitializeMissingHostKeys = $false) {
    $config = Join-Path $env:ProgramData 'ssh\sshd_config'
    Assert-OvisSafePath (Split-Path $config) $true
    Assert-OvisSafePath $config $false
    if (-not (Test-Path -LiteralPath $config)) {
        # New OpenSSH services copy this packaged template on first start. Inspect
        # it first instead of authorizing a key against an unvalidated config.
        $config = Join-Path (Split-Path $Sshd) 'sshd_config_default'
        Assert-OvisSafePath $config $false
        if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Cannot inspect the packaged OpenSSH default configuration. Configure SSH manually before retrying.' }
    }
    $arguments = @('-T', '-f', $config, '-C', "user=$($User.ToLowerInvariant()),host=localhost,addr=$From,laddr=$Target,lport=22")
    $result = Invoke-OvisSshCommand $Sshd $arguments
    if ($result.ExitCode -ne 0 -and $InitializeMissingHostKeys -and ($result.Output -join "`n") -match '(?m)^sshd: no hostkeys available -- exiting\.\r?$') {
        Initialize-OvisDefaultHostKeys $Sshd $config
        $result = Invoke-OvisSshCommand $Sshd $arguments
    }
    if ($result.ExitCode -ne 0) { throw 'Cannot inspect sshd configuration. Fix it manually; no configuration is overwritten.' }
    $effective = @($result.Output)
    $ports = @($effective | Where-Object { "$_" -match '^port ' })
    if ($ports.Count -eq 0 -or @($ports | Where-Object { "$_" -ne 'port 22' }).Count -ne 0) { throw 'Existing SSH uses a non-22 port. Configure SSH manually.' }
    $auth = @($effective | Where-Object { "$_" -match '^authorizedkeysfile ' })
    if ($auth.Count -ne 1) { throw 'Cannot resolve effective AuthorizedKeysFile; configure manually.' }
    $path = ("$($auth[0])" -replace '^authorizedkeysfile ', '').Replace('\', '/').ToLowerInvariant()
    if ($SharedAdmin) {
        $expected = (Join-Path $env:ProgramData 'ssh/administrators_authorized_keys').Replace('\', '/').ToLowerInvariant()
        if ($path -ne '__programdata__/ssh/administrators_authorized_keys' -and $path -ne $expected) { throw 'Custom administrator AuthorizedKeysFile; authorize/remove the exact Ovis line manually.' }
    } elseif ($path -ne '.ssh/authorized_keys' -and $path -ne '.ssh/authorized_keys .ssh/authorized_keys2') { throw 'Custom AuthorizedKeysFile; authorize/remove the exact Ovis line manually.' }
    if ('pubkeyauthentication yes' -notin $effective) { throw 'Public-key authentication is disabled; configure SSH manually.' }
}
function Get-OvisOwnedRule([hashtable]$Options) {
    $name = "Ovis-SSH-$($Options.Id)"
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $rule) { return $null }
    $port = $rule | Get-NetFirewallPortFilter
    $address = $rule | Get-NetFirewallAddressFilter
    if (@($rule).Count -ne 1 -or $rule.DisplayName -cne "Ovis SSH $($Options.Id)" -or $rule.Description -cne "Ovis bootstrap-v1 $($Options.Id)" -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or "$($port.Protocol)" -notin @('TCP', '6') -or "$($port.LocalPort)" -ne '22' -or "$($address.RemoteAddress)" -ne $Options.Source -or "$($address.LocalAddress)" -ne $Options.Destination) { throw "Firewall rule name collision: $name is not the exact owned rule. Review it manually." }
    return $rule
}
function Update-OvisAuthorization([string]$Path, [string]$Line, [bool]$Removing, [string]$Sid, [bool]$SharedAdmin) {
    $directory = Split-Path $Path
    Assert-OvisSafePath $directory $true
    Assert-OvisSafePath $Path $false
    if ($Removing -and -not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    # Shared ProgramData\ssh is not an account directory: never replace its ACL.
    if (-not $SharedAdmin -and -not $Removing) { Set-OvisAcl $directory $Sid $true $false }
    if (-not (Test-Path -LiteralPath $Path)) {
        $created = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created.Dispose()
    }
    # fsutil and Set-Acl open their own handles: finish them before taking the
    # exclusive read/write handle. Never truncate until all checks have passed.
    if (-not $Removing) { Set-OvisAcl $Path $Sid $false $SharedAdmin }
    Assert-OvisSafePath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
        try { $contents = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $lines = @($contents -split '\r?\n')
        if ($lines.Count -gt 0 -and $lines[-1] -ceq '') { $lines = @($lines | Select-Object -SkipLast 1) }
        if ($Removing) {
            if ($Line -cnotin $lines) { return }
            $next = @($lines | Where-Object { $_ -cne $Line })
        } else {
            if ($Line -cin $lines) { return }
            $next = @($lines) + $Line
        }
        $text = ''
        if ($next.Count -gt 0) { $text = ($next -join "`n") + "`n" }
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
        $stream.Position = 0
        $stream.SetLength(0)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } finally { $stream.Dispose() }
}
function Invoke-OvisBootstrap {
    $options = Test-OvisArguments
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [Environment]::Is64BitProcess -ne $true) { throw 'Use 64-bit Windows PowerShell/PowerShell on Windows 10/11 or Windows Server with the OpenSSH Server capability.' }
    $version = [Environment]::OSVersion.Version
    if ($version.Major -lt 10 -or $version.Build -lt 17763) { throw 'Windows build 17763 or newer is required.' }
    $account = Get-LocalUser -Name $User -ErrorAction Stop
    if ($account.Name -ine $User -or -not $account.Enabled -or "$($account.PrincipalSource)" -ne 'Local') { throw 'Requested account must be an enabled local Windows account, not a domain/Microsoft/Entra account.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $account.SID.Value) { throw 'V1 requires the executing principal local account SID to equal the requested account SID. Sign in as that user and elevate its own terminal; another administrator cannot bootstrap this user.' }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run an elevated administrator terminal as the requested local account. A standard user needing a different administrator is not supported in v1; configure SSH manually.' }
    $localAddresses = @(Get-NetIPAddress -ErrorAction Stop | ForEach-Object { try { ConvertTo-OvisAddress $_.IPAddress } catch { } })
    if ($options.Destination -notin $localAddresses) { throw 'Selected Target Tailscale IP is not assigned locally. Run this command on the selected PC.' }
    # Resolve the group by well-known SID, not a localized name or UAC token membership.
    $adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
    $admins = @(Get-LocalGroupMember -Group $adminGroup -ErrorAction Stop)
    $sharedAdmin = @($admins | Where-Object { $_.SID.Value -eq $account.SID.Value }).Count -gt 0
    if ($sharedAdmin) {
        Write-Warning 'Administrators use a SHARED administrators_authorized_keys file. This key is NOT isolated to the requested username and may authenticate as other local administrators permitted by SSH. Continue only if you accept this broader administrator access.'
        if ((Read-Host 'Type ALLOW SHARED ADMIN KEY to continue (anything else cancels)') -cne 'ALLOW SHARED ADMIN KEY') { throw 'Cancelled; no changes made.' }
        $authPath = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    } else {
        $profile = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($account.SID.Value)" -Name ProfileImagePath -ErrorAction Stop
        $profilePath = [Environment]::ExpandEnvironmentVariables($profile.ProfileImagePath)
        Assert-OvisSafePath $profilePath $true
        if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw 'No existing local account profile was resolved by SID. Sign in once and rerun; no profile path is guessed.' }
        $authPath = Join-Path $profilePath '.ssh\authorized_keys'
    }
    Assert-OvisSafePath (Split-Path $authPath) $true
    Assert-OvisSafePath $authPath $false
    $rule = Get-OvisOwnedRule $options
    $sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
    if (Test-Path -LiteralPath $sshd) { Assert-OvisSshConfig $sshd $sharedAdmin (-not $Remove) }
    elseif (Test-Path -LiteralPath (Join-Path $env:ProgramData 'ssh\sshd_config')) { throw 'An existing sshd_config cannot be validated without sshd; install/validate OpenSSH manually first.' }
    if ($Remove) {
        # Check read/write access before removing the rule; keep authorization if
        # firewall cleanup fails, so the operator can still retry over SSH.
        if (Test-Path -LiteralPath $authPath) {
            $probe = [IO.File]::Open($authPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $probe.Dispose()
        }
        if ($null -ne $rule) { $rule | Remove-NetFirewallRule }
        Update-OvisAuthorization $authPath $options.Line $true $account.SID.Value $sharedAdmin
        Write-Output 'Removed only the exact Ovis key line and exact owned firewall rule, if present. SSH, other keys and other rules were not changed.'
        return
    }
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
    if ($null -eq $capability) { throw 'OpenSSH Server capability is unavailable; install/configure it manually.' }
    $before = @(Get-NetFirewallRule | ForEach-Object { $_.Name })
    if ($capability.State -ne 'Installed') {
        try {
            $result = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
            if ($result.RestartNeeded) { throw 'Windows requires a reboot to finish OpenSSH installation. Reboot manually and request a new bootstrap command.' }
        } finally {
            # Capability installation may add a broad default rule. Disable only the
            # known exact rule if it was not present before THIS installation.
            if ('OpenSSH-Server-In-TCP' -notin $before) {
                $created = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
                if ($null -ne $created) { $created | Disable-NetFirewallRule | Out-Null }
            }
        }
    }
    if (-not (Test-Path -LiteralPath $sshd)) { throw 'OpenSSH capability did not provide sshd.exe. Complete setup manually.' }
    Assert-OvisSshConfig $sshd $sharedAdmin $true
    Update-OvisAuthorization $authPath $options.Line $false $account.SID.Value $sharedAdmin
    if ($null -eq $rule) {
        New-NetFirewallRule -Name "Ovis-SSH-$($options.Id)" -DisplayName "Ovis SSH $($options.Id)" -Description "Ovis bootstrap-v1 $($options.Id)" -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 22 -RemoteAddress $options.Source -LocalAddress $options.Destination -Profile Any -EdgeTraversalPolicy Block | Out-Null
    }
    Write-Warning 'Existing firewall rules were preserved. Any preexisting broader SSH allow rule can allow access beyond this Ovis source/target restriction; review active inbound TCP/22 rules and all existing SSH authentication manually.'
    Set-Service -Name sshd -StartupType Automatic
    $service = Get-Service -Name sshd
    if ($service.Status -ne 'Running') { Start-Service -Name sshd } # Never restart a running daemon.
    Write-Output "SSH account: $User ; port: 22 ; target: $Target ; permitted key source: $From"
    Write-Output 'SSH host SHA-256 fingerprints (compare manually in Ovis before approving this deployment):'
    $keygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
    Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'ssh') -Filter 'ssh_host_*_key.pub' | ForEach-Object { & $keygen -lf $_.FullName -E sha256; if ($LASTEXITCODE -ne 0) { throw 'Could not print SSH host fingerprint; verify it locally before approval.' } }
    Write-Output 'The 15-minute limit concerns only the pending Ovis server private key; installed SSH authorization does NOT expire. If approval fails/expires, rerun this same command with -Remove on this PC.'
    Write-Output 'Removal needs the same local administrator and shared-admin confirmation. No SSH uninstall/stop, Tailscale SSH, public forwarding, DNS, callbacks or application installation was configured.'
}
# Dot-sourcing exposes pure helpers to the native mocked test harness without host changes.
if ($MyInvocation.InvocationName -ne '.') { Invoke-OvisBootstrap }
