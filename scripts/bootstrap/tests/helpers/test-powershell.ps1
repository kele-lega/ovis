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
