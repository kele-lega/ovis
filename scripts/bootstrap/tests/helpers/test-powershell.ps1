param([Parameter(Mandatory = $true)][string]$Script, [Parameter(Mandatory = $true)][string]$ValidKey)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
. $Script -User 'alice' -Key $ValidKey -From '100.64.0.10' -Target '100.100.0.20' -Expires '99999999999'
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Rejected([scriptblock]$Operation, [string]$Message) {
    $failed = $false
    try { & $Operation | Out-Null } catch { $failed = $true }
    Assert-True $failed $Message
}
$options = Test-OvisArguments
Assert-True ($options.Line -ceq "from=`"100.64.0.10`",no-agent-forwarding,no-X11-forwarding,no-pty $ValidKey") 'Exact managed line differs.'
foreach ($bad in @('100.63.255.255', '100.128.0.0', '100.064.0.1', '100.64.0.1/32', '100.64.0.1,100.64.0.2', '100.64.0.1%ts', 'example.com', 'fd7a:115c:a1e1::1', 'fd7a:115c:a1e0:::1', "100.64.0.1`n")) {
    Assert-Rejected { ConvertTo-OvisAddress $bad } "Accepted invalid address $bad"
}
foreach ($good in @('100.64.0.0', '100.127.255.255', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:0000:0000:0000:0000:0001')) { ConvertTo-OvisAddress $good | Out-Null }
$originalUser = $User
foreach ($bad in @('-root', 'a/b', 'a\b', 'a@b', ('a' * 129), "alice`n")) { $User = $bad; Assert-Rejected { Test-OvisArguments } 'Accepted invalid username' }
$User = $originalUser
$Key = $ValidKey.Replace('AAAAC3', 'AAAAA3'); Assert-Rejected { Test-OvisArguments } 'Accepted invalid SSH wire header'
$Key = 'ssh-ed25519 ' + [Convert]::ToBase64String((New-Object byte[] 51)) + ' ovis:74abb0b9-8021-4632-9d0f-14a5796c442c'
Assert-Rejected { Test-OvisArguments } 'Accepted non-Ed25519 blob'
$Key = "$ValidKey`n"; Assert-Rejected { Test-OvisArguments } 'Accepted newline key'
$Key = $ValidKey; $Expires = '1'; Assert-Rejected { Test-OvisArguments } 'Accepted expired install'
$Remove = $true; Test-OvisArguments | Out-Null
$Remove = $false; $Expires = '99999999999'

# All system/firewall/auth effects below are fakes. Invoke no actual service,
# capability, account, registry, filesystem-ACL, SSH or firewall mutation.
$script:removes = 0
function Get-NetFirewallRule { param($Name, $ErrorAction) return $script:fakeRule }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { return $script:fakePort } }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { return $script:fakeAddress } }
$script:fakeRule = $null
Assert-True ($null -eq (Get-OvisOwnedRule $options)) 'Absent firewall rule was not absent'
$script:fakeRule = [pscustomobject]@{ Name = "Ovis-SSH-$($options.Id)"; DisplayName = "Ovis SSH $($options.Id)"; Description = "Ovis bootstrap-v1 $($options.Id)"; Direction = 'Inbound'; Action = 'Allow' }
$script:fakePort = [pscustomobject]@{ Protocol = 'TCP'; LocalPort = '22' }
$script:fakeAddress = [pscustomobject]@{ RemoteAddress = $options.Source; LocalAddress = $options.Destination }
Assert-True ($null -ne (Get-OvisOwnedRule $options)) 'Exact owned rule rejected'
$script:fakeRule.Description = 'not owned'; Assert-Rejected { Get-OvisOwnedRule $options } 'Accepted unowned rule'
$script:fakeRule.Description = "Ovis bootstrap-v1 $($options.Id)"
$script:fakePort.LocalPort = '2222'; Assert-Rejected { Get-OvisOwnedRule $options } 'Accepted wrong rule port'
$script:fakePort.LocalPort = '22'; $script:fakeAddress.RemoteAddress = 'Any'
Assert-Rejected { Get-OvisOwnedRule $options } 'Accepted broad firewall rule as owned'

# Native AST policy: default-deny shared-admin confirmation, target verification
# and local principal SID checks precede the first capability/key/firewall change.
$invoke = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-OvisBootstrap' }, $true).Body.Extent.Text
foreach ($required in @('identity.User.Value -ne $account.SID.Value', "Get-LocalGroup -SID 'S-1-5-32-544'", 'Read-Host', "-cne 'ALLOW SHARED ADMIN KEY'", 'ProfileList', 'options.Destination -notin', "'OpenSSH-Server-In-TCP' -notin", 'Disable-NetFirewallRule', 'Assert-OvisSshConfig')) { Assert-True ($invoke.Contains($required)) "Missing safety gate: $required" }
Assert-True ($invoke.IndexOf('options.Destination -notin') -lt $invoke.IndexOf('Add-WindowsCapability')) 'Target verification happens too late'
Assert-True ($invoke.IndexOf('Read-Host') -lt $invoke.IndexOf('Update-OvisAuthorization')) 'Shared admin consent happens too late'
Assert-True (-not $invoke.Contains('Restart-Service')) 'Restarts a running service'
Assert-True (-not $invoke.Contains('Set-NetFirewallProfile')) 'Changes global firewall settings'
# Verify the native capture seam itself using only a child PowerShell, never SSH.
$native = Invoke-OvisSshCommand (Get-Process -Id $PID).Path @('-NoLogo', '-NoProfile', '-Command', '[Console]::Error.WriteLine("sshd: no hostkeys available -- exiting."); exit 1')
Assert-True ($native.ExitCode -eq 1) 'Lost the native failure exit code'
Assert-True (($native.Output -join "`n") -match 'sshd: no hostkeys available -- exiting\.') 'Lost redirected native stderr'
Assert-True ($ErrorActionPreference -eq 'Stop') 'Native capture weakened the caller error policy'

# Exercise config selection, native failures and the install/remove suffix using
# disposable files and a default-deny native seam. No real sshd/keygen is invoked.
$script:realSafePath = ${function:Assert-OvisSafePath}
$script:realAuthorization = ${function:Update-OvisAuthorization}
$hostFixture = Join-Path ([IO.Path]::GetTempPath()) ('ovis-bootstrap-hostkeys-' + [guid]::NewGuid())
$oldProgramData = $env:ProgramData
$oldSystemRoot = $env:SystemRoot
$script:commands = @()
$script:keygenMode = 'success'
$script:configMode = 'missing'
$script:configCalls = 0
$script:unsafePath = ''
function Assert-OvisSafePath {
    param($Path, $Directory)
    Assert-True ($Path.StartsWith($hostFixture)) "Mock escaped fixture: $Path"
    if ($Path -ceq $script:unsafePath) { throw 'Mocked unsafe path' }
}
function Invoke-OvisSshCommand {
    param($Command, $Arguments)
    if ($Command -ceq $script:fakeSshd) {
        Assert-True ($Arguments.Count -eq 5 -and $Arguments[0] -ceq '-T' -and $Arguments[1] -ceq '-f' -and $Arguments[3] -ceq '-C') 'Unexpected sshd arguments'
        Assert-True ($Arguments[2] -in @($script:config, $script:template)) 'Unexpected config path'
        Assert-True ($Arguments[4] -ceq 'user=alice,host=localhost,addr=100.64.0.10,laddr=100.100.0.20,lport=22') 'Lost Match connection arguments'
        $script:commands += "validate:$($Arguments[2])"
        $script:configCalls++
        if ($script:configMode -eq 'syntax') { return @{ ExitCode = 255; Output = @('Bad configuration option: broken') } }
        if ($script:configMode -eq 'missing' -and $script:configCalls -eq 1) {
            $record = [Management.Automation.ErrorRecord]::new([Exception]::new('sshd: no hostkeys available -- exiting.'), 'NativeCommandError', [Management.Automation.ErrorCategory]::NotSpecified, $null)
            return @{ ExitCode = 1; Output = @($record) }
        }
        if ($script:configMode -eq 'retry-fails' -or ($script:configMode -eq 'missing-always')) { return @{ ExitCode = 1; Output = @('sshd: no hostkeys available -- exiting.') } }
        $auth = '.ssh/authorized_keys'
        if ($script:configMode -eq 'admin') { $auth = '__PROGRAMDATA__/ssh/administrators_authorized_keys' }
        if ($script:configMode -eq 'custom-auth') { $auth = '/custom/keys' }
        $port = '22'; if ($script:configMode -eq 'custom-port') { $port = '2222' }
        $pubkey = 'yes'; if ($script:configMode -eq 'no-pubkey') { $pubkey = 'no' }
        return @{ ExitCode = 0; Output = @("port $port", "authorizedkeysfile $auth", "pubkeyauthentication $pubkey") }
    }
    if ($Command -ceq $script:fakeKeygen) {
        Assert-True ($Arguments.Count -eq 1 -and $Arguments[0] -ceq '-A') 'Unexpected keygen arguments'
        $script:commands += 'keygen'
        foreach ($type in @('rsa', 'ecdsa', 'ed25519')) {
            if ($script:keygenMode -eq 'partial' -and $type -ne 'rsa') { continue }
            $private = Join-Path $script:hostDirectory "ssh_host_${type}_key"
            if (-not (Test-Path -LiteralPath $private)) {
                [IO.File]::WriteAllText($private, "fixture-private-$type")
                [IO.File]::WriteAllText("$private.pub", "fixture-public-$type")
            }
        }
        if ($script:keygenMode -eq 'exit-failure') { return @{ ExitCode = 1; Output = @() } }
        if ($script:keygenMode -eq 'stderr-failure') {
            $record = [Management.Automation.ErrorRecord]::new([Exception]::new('Could not save host key'), 'NativeCommandError', [Management.Automation.ErrorCategory]::NotSpecified, $null)
            return @{ ExitCode = 0; Output = @($record) }
        }
        if ($script:configMode -eq 'retry-fails') { $script:configMode = 'missing-always' }
        return @{ ExitCode = 0; Output = @('ssh-keygen: generating new host keys: RSA ECDSA ED25519') }
    }
    throw "Unmocked native command: $Command"
}
function Reset-HostFixture {
    if (Test-Path -LiteralPath $hostFixture) { Remove-Item -LiteralPath $hostFixture -Recurse -Force }
    $env:ProgramData = Join-Path $hostFixture 'data'
    $env:SystemRoot = Join-Path $hostFixture 'windows'
    $script:hostDirectory = Join-Path $env:ProgramData 'ssh'
    $script:fakeSshd = Join-Path $env:SystemRoot 'System32/OpenSSH/sshd.exe'
    $script:fakeKeygen = Join-Path (Split-Path $script:fakeSshd) 'ssh-keygen.exe'
    $script:template = Join-Path (Split-Path $script:fakeSshd) 'sshd_config_default'
    $script:config = Join-Path $script:hostDirectory 'sshd_config'
    [IO.Directory]::CreateDirectory((Split-Path $script:fakeSshd)) | Out-Null
    [IO.Directory]::CreateDirectory($script:hostDirectory) | Out-Null
    [IO.File]::WriteAllText($script:fakeSshd, 'not an executable')
    [IO.File]::WriteAllText($script:fakeKeygen, 'not an executable')
    [IO.File]::WriteAllText($script:template, "# Packaged default fixture`nPort 22`n")
    $script:commands = @(); $script:configCalls = 0
    $script:configMode = 'missing'; $script:keygenMode = 'success'; $script:unsafePath = ''
    $script:capabilityState = 'Installed'; $script:serviceStatus = 'Stopped'
    $script:fakeRule = $null; $script:capabilityRuleCreated = $false
}
function Assert-NoHostEffects {
    Assert-True (@($script:commands | Where-Object { $_ -in @('authorize', 'firewall', 'set-service', 'start-service') }).Count -eq 0) 'Failure reached an authorization/firewall/service change'
}
# All Windows principal/consent checks stay in the AST policy above. Run the exact
# remaining install/removal statements with their host-changing cmdlets mocked.
$body = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-OvisBootstrap' }, $true).Body.EndBlock
$tail = @($body.Statements | Where-Object { $_.Extent.StartOffset -ge ($body.Statements | Where-Object { $_.Extent.Text.StartsWith('$sshd = ') } | Select-Object -First 1).Extent.StartOffset } | ForEach-Object { $_.Extent.Text }) -join "`n"
$installTail = [scriptblock]::Create($tail)
function Update-OvisAuthorization { param($Path, $Line, $Removing, $Sid, $SharedAdmin) $script:commands += 'authorize' }
function Get-WindowsCapability { param([switch]$Online, $Name) return [pscustomobject]@{ State = $script:capabilityState } }
function New-NetFirewallRule { param($Name, $DisplayName, $Description, $Direction, $Action, $Enabled, $Protocol, $LocalPort, $RemoteAddress, $LocalAddress, $Profile, $EdgeTraversalPolicy) $script:commands += 'firewall' }
function Set-Service { param($Name, $StartupType) $script:commands += 'set-service' }
function Get-Service { param($Name) return [pscustomobject]@{ Status = $script:serviceStatus } }
function Start-Service { param($Name) $script:commands += 'start-service' }
function Add-WindowsCapability {
    param([switch]$Online, $Name)
    Assert-True ($Name -ceq 'OpenSSH.Server~~~~0.0.1.0') 'Unexpected capability name'
    $script:commands += 'install-capability'
    [IO.File]::WriteAllText($script:fakeSshd, 'not an executable')
    $script:capabilityRuleCreated = $true
    return [pscustomobject]@{ RestartNeeded = $false }
}
function Get-NetFirewallRule { param($Name, $ErrorAction) if (-not $Name) { return @() }; if ($Name -ceq 'OpenSSH-Server-In-TCP' -and $script:capabilityRuleCreated) { return [pscustomobject]@{ Name = $Name } }; return $null }
function Disable-NetFirewallRule { param([Parameter(ValueFromPipeline = $true)]$Rule) process { $script:commands += 'disable-new-broad-rule' } }
function Remove-NetFirewallRule { throw 'Unexpected firewall removal' }
function Get-ChildItem { param($LiteralPath, $Filter) Assert-True ($LiteralPath.StartsWith($hostFixture)) 'Fingerprint scan escaped fixture'; return @() }
try {
    Reset-HostFixture
    Remove-Item -LiteralPath $script:hostDirectory -Recurse
    Assert-OvisSshConfig $script:fakeSshd $false $true
    Assert-True ($script:commands.Count -eq 3 -and $script:commands[0] -ceq "validate:$script:template" -and $script:commands[1] -ceq 'keygen' -and $script:commands[2] -ceq "validate:$script:template") 'Fresh installation did not generate then revalidate packaged config'
    Assert-True (-not (Test-Path -LiteralPath $script:config)) 'Validation wrote sshd_config'
    $before = @{}
    foreach ($type in @('rsa', 'ecdsa', 'ed25519')) { foreach ($suffix in @('', '.pub')) { $path = Join-Path $script:hostDirectory "ssh_host_${type}_key$suffix"; $before[$path] = [IO.File]::ReadAllText($path) } }
    $script:configMode = 'valid'; $script:commands = @()
    Assert-OvisSshConfig $script:fakeSshd $false $true
    Assert-True ($script:commands.Count -eq 1) 'Successful validation generated host keys'
    foreach ($path in $before.Keys) { Assert-True ([IO.File]::ReadAllText($path) -ceq $before[$path]) 'Repeated install replaced an existing key' }

    Reset-HostFixture
    [IO.File]::Copy($script:template, $script:config)
    $rsa = Join-Path $script:hostDirectory 'ssh_host_rsa_key'
    [IO.File]::WriteAllText($rsa, 'existing-private-sentinel'); [IO.File]::WriteAllText("$rsa.pub", 'existing-public-sentinel')
    Assert-OvisSshConfig $script:fakeSshd $false $true
    Assert-True ([IO.File]::ReadAllText($rsa) -ceq 'existing-private-sentinel' -and [IO.File]::ReadAllText("$rsa.pub") -ceq 'existing-public-sentinel') 'Missing-only generation replaced existing keys'
    Assert-True ($script:commands[0] -ceq "validate:$script:config") 'Existing default config was not selected'

    foreach ($mode in @('syntax', 'custom-port', 'custom-auth', 'no-pubkey')) {
        Reset-HostFixture; $script:configMode = $mode
        Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false $true } "Accepted $mode config"
        Assert-True ('keygen' -notin $script:commands) 'Unrelated validation failure generated keys'
    }
    Reset-HostFixture; $script:configMode = 'admin'
    Assert-OvisSshConfig $script:fakeSshd $true $true
    foreach ($custom in @('HostKey /custom/key', 'HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key', 'HostKeyAgent agent', 'HostCertificate /custom/cert', 'Include custom.conf')) {
        Reset-HostFixture
        [IO.File]::AppendAllText($script:template, "$custom`n")
        Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false $true } "Initialized unsupported directive: $custom"
        Assert-True ('keygen' -notin $script:commands) 'Custom host key config generated keys'
    }
    Reset-HostFixture
    [IO.File]::WriteAllText($script:config, "# operator custom configuration`nPort 22`n")
    Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false $true } 'Initialized operator config'
    Assert-True ('keygen' -notin $script:commands) 'Nondefault config generated keys'
    $script:configMode = 'valid'
    Assert-OvisSshConfig $script:fakeSshd $false $true
    Assert-True ('keygen' -notin $script:commands) 'Working custom config generated keys'

    foreach ($hazard in @('empty-private', 'orphan-public', 'unsafe-private', 'unsafe-public', 'missing-keygen', 'missing-template', 'all-existing')) {
        Reset-HostFixture
        $private = Join-Path $script:hostDirectory 'ssh_host_ed25519_key'
        if ($hazard -eq 'empty-private') { [IO.File]::WriteAllText($private, '') }
        if ($hazard -eq 'orphan-public') { [IO.File]::WriteAllText("$private.pub", 'preserved-orphan-public') }
        if ($hazard -eq 'unsafe-private') { $script:unsafePath = $private }
        if ($hazard -eq 'unsafe-public') { $script:unsafePath = "$private.pub" }
        if ($hazard -eq 'missing-keygen') { Remove-Item -LiteralPath $script:fakeKeygen }
        if ($hazard -eq 'missing-template') { Remove-Item -LiteralPath $script:template; [IO.File]::WriteAllText($script:config, '# missing template') }
        if ($hazard -eq 'all-existing') { foreach ($type in @('rsa', 'ecdsa', 'ed25519')) { [IO.File]::WriteAllText((Join-Path $script:hostDirectory "ssh_host_${type}_key"), 'existing-unloadable-private') } }
        Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false $true } "Initialized unsafe/unavailable fixture: $hazard"
        Assert-True ('keygen' -notin $script:commands) 'Unsafe fixture generated keys'
        if ($hazard -eq 'orphan-public') { Assert-True ([IO.File]::ReadAllText("$private.pub") -ceq 'preserved-orphan-public') 'Replaced orphan public key' }
    }
    Reset-HostFixture
    Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false } 'Default config inspection unexpectedly repaired host keys'
    Assert-True ('keygen' -notin $script:commands) 'Default inspection generated keys'

    $account = [pscustomobject]@{ SID = [pscustomobject]@{ Value = 'fixture-sid' } }
    $sharedAdmin = $false; $rule = $null
    foreach ($failure in @('exit-failure', 'stderr-failure', 'partial', 'retry-fails')) {
        Reset-HostFixture
        $authPath = Join-Path $hostFixture 'authorization'
        $script:keygenMode = $failure
        if ($failure -eq 'retry-fails') { $script:configMode = 'retry-fails' }
        Assert-Rejected { & $installTail } "Install accepted $failure"
        Assert-NoHostEffects
    }
    # Retry a partial -A result without replacing the private/public pair it made.
    Reset-HostFixture; $script:keygenMode = 'partial'
    Assert-Rejected { Assert-OvisSshConfig $script:fakeSshd $false $true } 'Accepted partial generation'
    $rsa = Join-Path $script:hostDirectory 'ssh_host_rsa_key'; $savedRsa = [IO.File]::ReadAllText($rsa)
    $script:keygenMode = 'success'; $script:configMode = 'missing'; $script:configCalls = 0
    Assert-OvisSshConfig $script:fakeSshd $false $true
    Assert-True ([IO.File]::ReadAllText($rsa) -ceq $savedRsa) 'Retry overwrote a partially generated key'

    Reset-HostFixture
    $authPath = Join-Path $hostFixture 'authorization'
    & $installTail | Out-Null
    $validation = @($script:commands | Where-Object { $_ -like 'validate:*' })[-1]
    Assert-True ([Array]::IndexOf($script:commands, 'authorize') -gt [Array]::LastIndexOf($script:commands, $validation)) 'Authorized before final validation'
    Assert-True ([Array]::IndexOf($script:commands, 'start-service') -gt [Array]::IndexOf($script:commands, 'authorize')) 'Started before authorization validation'
    Reset-HostFixture
    $script:capabilityState = 'NotPresent'
    Remove-Item -LiteralPath $script:fakeSshd
    $authPath = Join-Path $hostFixture 'authorization'
    & $installTail | Out-Null
    Assert-True ($script:commands[0] -ceq 'install-capability') 'Fresh capability was not installed before validation'
    Assert-True ($script:commands[1] -ceq 'disable-new-broad-rule') 'New broad default firewall rule was not disabled before host-key initialization'
    $validation = @($script:commands | Where-Object { $_ -like 'validate:*' })[-1]
    Assert-True ([Array]::IndexOf($script:commands, 'keygen') -gt [Array]::IndexOf($script:commands, 'install-capability')) 'Generated keys before capability installation'
    Assert-True ([Array]::IndexOf($script:commands, 'authorize') -gt [Array]::LastIndexOf($script:commands, $validation)) 'Fresh capability authorization preceded final validation'
    Assert-True ([Array]::IndexOf($script:commands, 'start-service') -gt [Array]::IndexOf($script:commands, 'authorize')) 'Fresh capability started before authorization'
    Reset-HostFixture; $script:configMode = 'valid'; $script:serviceStatus = 'Running'
    $authPath = Join-Path $hostFixture 'authorization'
    & $installTail | Out-Null
    Assert-True ('keygen' -notin $script:commands -and 'start-service' -notin $script:commands) 'Working daemon was reinitialized or started again'
    Reset-HostFixture; $Remove = $true
    Assert-Rejected { & $installTail } 'Cleanup accepted unloadable keys'
    Assert-True ('keygen' -notin $script:commands) 'Cleanup generated host keys'
    Assert-NoHostEffects
    $Remove = $false
} finally {
    $env:ProgramData = $oldProgramData; $env:SystemRoot = $oldSystemRoot
    if (Test-Path -LiteralPath $hostFixture) { Remove-Item -LiteralPath $hostFixture -Recurse -Force }
    Set-Item -LiteralPath Function:Assert-OvisSafePath -Value $script:realSafePath
    Set-Item -LiteralPath Function:Update-OvisAuthorization -Value $script:realAuthorization
}
Write-Output 'PowerShell missing-host-key regressions passed'

# Exercise the real file updater only inside a disposable directory. OS-specific
# ACL/link inspection is mocked; no real account or SSH path is used.
function Assert-OvisSafePath { param($Path, $Directory) }
function Set-OvisAcl { param($Path, $AccountSid, $Directory, $SharedAdmin) }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ovis-bootstrap-ps-' + [guid]::NewGuid())
try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $file = Join-Path $fixture 'keys'
    [IO.File]::WriteAllText($file, "unrelated-key`n")
    Update-OvisAuthorization $file $options.Line $false 'fixture-sid' $true
    Update-OvisAuthorization $file $options.Line $false 'fixture-sid' $true
    $lines = @([IO.File]::ReadAllLines($file))
    Assert-True (@($lines | Where-Object { $_ -ceq $options.Line }).Count -eq 1) 'Authorization is not idempotent'
    $held = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-Rejected { Update-OvisAuthorization $file $options.Line $true 'fixture-sid' $true } 'Concurrent writer was not refused' } finally { $held.Dispose() }
    Update-OvisAuthorization $file $options.Line $true 'fixture-sid' $true
    Assert-True ([IO.File]::ReadAllText($file) -ceq "unrelated-key`n") 'Removal changed unrelated keys'
} finally { if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force } }
Write-Output 'PowerShell bootstrap mocked tests passed'
