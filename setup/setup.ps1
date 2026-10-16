# Sets up Conversations on a PC: the tools it needs, the app's own repository (code,
# public), this PC's conversations repository (yours, private), and the app.
# Safe to run again: every step skips what is already done.
#
# Double-click "Set up Conversations.cmd" next to this file, with the app's installer
# ("Conversations Setup x.y.z.exe") in the same folder. To only see what it would do:
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Check

param([switch]$Check)

$ErrorActionPreference = "Stop"
$AppRepo = "https://github.com/Samprogrammer143/conversations-app.git"
$AppDir = Join-Path $env:LOCALAPPDATA "conversations-app"
# The usual folders, or the ones this PC's environment already names (as the app reads them).
$SyncHome = if ($env:CLAUDE_SYNC_HOME) { $env:CLAUDE_SYNC_HOME } else { Join-Path $env:LOCALAPPDATA "claude-conversation-sync" }
$RepoDir = Join-Path $SyncHome "repo"
$DataDir = Join-Path $env:LOCALAPPDATA "Conversations"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Steps = 6

function Say($text) { Write-Host $text }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/$Steps] $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "      $text" -ForegroundColor Green }
function Todo($text) { Write-Host "      $text" -ForegroundColor Yellow }
function Stop-Setup($text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Red
  Write-Host ""
  if (-not $Check) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $local = Join-Path $HOME ".local\bin"
  if ((Test-Path $local) -and ($env:Path -notlike "*$local*")) { $env:Path += ";$local" }
}
function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install($id, $name) {
  if (-not (Has "winget")) { Stop-Setup "$name is missing, and this PC has no winget to install it. Install $name yourself, then run this again." }
  Say "      Installing $name (Windows may ask for permission) ..."
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements --silent
  Refresh-Path
}

Write-Host ""
Write-Host "Conversations setup" -ForegroundColor White
if ($Check) { Write-Host "(check only: nothing is changed)" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 1. tools
Step 1 "Git, Node and Claude Code"
Refresh-Path
foreach ($t in @(@{ cmd = "git"; id = "Git.Git"; name = "Git" }, @{ cmd = "node"; id = "OpenJS.NodeJS.LTS"; name = "Node.js" })) {
  if (Has $t.cmd) { Done "$($t.name) is installed" }
  elseif ($Check) { Todo "$($t.name) would be installed" }
  else {
    Winget-Install $t.id $t.name
    if (-not (Has $t.cmd)) { Stop-Setup "$($t.name) was installed but can't be found yet. Close this window and run the setup again." }
    Done "$($t.name) installed"
  }
}
if (Has "claude") { Done "Claude Code is installed" }
elseif ($Check) { Todo "Claude Code would be installed (Anthropic's installer, claude.ai/install.ps1)" }
else {
  Say "      Installing Claude Code ..."
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
  if (-not (Has "claude")) { Stop-Setup "Claude Code was installed but can't be found yet. Close this window and run the setup again." }
  Done "Claude Code installed"
}

# ---------------------------------------------------------------- 2. the app's repository
Step 2 "The app's code (public, read-only)"
if (Test-Path (Join-Path $AppDir ".git")) { Done "Already here" }
elseif ($Check) { Todo "The app's code would be downloaded into $AppDir" }
else {
  git -c core.longpaths=true clone --quiet $AppRepo $AppDir
  if ($LASTEXITCODE -ne 0) { Stop-Setup "The app's code couldn't be downloaded. Check the internet connection, then run this again." }
  Done "Downloaded"
}
if ($Check) { Todo "Claude's Agent SDK would be installed from npm" }
else {
  $r = node (Join-Path $AppDir "_sync\sync.mjs") app --json | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0 -or $r -notmatch '"ok":\s*true') { Stop-Setup "Setting up the app's code didn't finish: $r" }
  Done "Claude's Agent SDK is installed"
}

# ---------------------------------------------------------------- 3. this PC
Step 3 "This PC and its conversations"
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
if ($env:OneDrive -and (Test-Path $claudeDir)) {
  $real = (Get-Item $claudeDir).FullName
  try { $target = (Get-Item $claudeDir).Target } catch { $target = $null }
  if ($real.StartsWith($env:OneDrive, "OrdinalIgnoreCase") -or ($target -and "$target".StartsWith($env:OneDrive, "OrdinalIgnoreCase"))) {
    Stop-Setup "Claude Code's folder ($claudeDir) is inside OneDrive. OneDrive would copy every PC's chats over each other. Move it out of OneDrive first, then run this again."
  }
}
$config = Join-Path $SyncHome "config.json"
$registry = Join-Path $DataDir "workspaces.json"
$machine = $null
$remote = $null
if (Test-Path $config) {
  try { $c = Get-Content $config -Raw | ConvertFrom-Json; $machine = $c.machine; $remote = $c.remote } catch {}
}
# A workspace set up earlier with its own Claude folder ("keep them out" below).
$reg = $null
try { $reg = Get-Content $registry -Raw | ConvertFrom-Json } catch {}
$own = $null
if ($reg -and $reg.extra) { $own = @($reg.extra) | Where-Object { Test-Path (Join-Path "$SyncHome-$($_.id)" "repo\.git") } | Select-Object -First 1 }
# The Claude folder the app and its sign-in use: the usual one, or that workspace's own.
$activeClaude = $claudeDir
$launcher = $null
$workspace = $null
if ($machine -and (Test-Path (Join-Path $RepoDir ".git"))) { Done "Already set up as `"$machine`", with $remote" }
elseif ($own) {
  $activeClaude = "$claudeDir-$($own.id)"
  $launcher = "claude-$($own.id)"
  Done "Already set up: $($own.name), with its own Claude folder ($activeClaude)"
}
elseif ($Check) {
  $n = @(Get-ChildItem (Join-Path $claudeDir "projects") -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\subagents\\' }).Count
  Todo "You would be asked for this PC's name, the repository that holds its conversations, and a name for it"
  if ($n) { Todo "This PC already has $n Claude Code chats: you would choose to bring them in or keep them out" }
}
else {
  if (-not $machine) {
    $machine = (Read-Host "      What should this PC be called? (e.g. Work Laptop)").Trim()
    if (-not $machine) { $machine = $env:COMPUTERNAME }
  }
  Say ""
  Say "      Which GitHub repository holds this PC's conversations?"
  Say "      Paste its address. For a new one: make an empty, private repository on github.com first."
  while (-not $remote) {
    $remote = (Read-Host "      Repository address").Trim()
    if ($remote -notmatch '^(https://[^/]+/.+|git@[^:]+:.+|file:///.+)$') { Say "      That doesn't look like a repository address (https://github.com/you/repo)."; $remote = $null }
  }
  while (-not $workspace) { $workspace = (Read-Host "      What should Conversations call it? (e.g. Work)").Trim() }

  # Claude Code may have been used on this PC before (another account, other work).
  $n = @(Get-ChildItem (Join-Path $claudeDir "projects") -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\subagents\\' }).Count
  $keepOut = $false
  if ($n) {
    Say ""
    Say "      This PC already has $n Claude Code chats (in $claudeDir)."
    Say "        1  Bring them into ${workspace}: they upload to its repository."
    Say "        2  Keep them out: $workspace gets a fresh Claude folder and its own sign-in. The"
    Say "           old chats stay in Claude Code as they are, and Conversations doesn't show them."
    $pick = ""
    while ($pick -notin @("1", "2")) { $pick = (Read-Host "      1 or 2").Trim() }
    $keepOut = $pick -eq "2"
  }

  Say "      Connecting. If a GitHub sign-in opens in the browser, sign in with the account that owns that repository."
  if (-not $keepOut) {
    node (Join-Path $AppDir "_sync\install.mjs") --remote "$remote" --machine "$machine"
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Connecting the repository didn't work (see the message above). Check the address and that you can open it on github.com, then run this again." }
    # The name the app shows for this workspace (only the first time).
    if (-not (Test-Path $registry)) {
      New-Item -ItemType Directory -Force $DataDir | Out-Null
      [IO.File]::WriteAllText($registry, (@{ current = "main"; mainName = $workspace; extra = @() } | ConvertTo-Json))
    }
  } else {
    # A workspace of its own: its own Claude folder, sync folder and app data, as the app's
    # "Add workspace" makes them; the PC's usual Claude folder is left out of Conversations.
    # The id as the app makes one ("Work" -> "work"), the same on any Windows language.
    $base = ($workspace.ToLowerInvariant() -creplace '[^a-z0-9]+', '-').Trim('-')
    if ($base.Length -gt 30) { $base = $base.Substring(0, 30).Trim('-') }
    if (-not $base) { $base = "workspace" }
    $taken = @("main")
    if ($reg -and $reg.extra) { $taken += @($reg.extra | ForEach-Object { $_.id }) }
    $id = if ($base -eq "main") { "main-2" } else { $base }
    for ($i = 2; $taken -contains $id; $i++) { $id = "$base-$i" }
    $activeClaude = "$claudeDir-$id"
    $wsSync = "$SyncHome-$id"
    New-Item -ItemType Directory -Force $activeClaude | Out-Null
    $savedConfig = $env:CLAUDE_CONFIG_DIR
    $savedSync = $env:CLAUDE_SYNC_HOME
    $env:CLAUDE_CONFIG_DIR = $activeClaude
    $env:CLAUDE_SYNC_HOME = $wsSync
    node (Join-Path $AppDir "_sync\install.mjs") --remote "$remote" --machine "$machine"
    $ok = $LASTEXITCODE -eq 0
    $env:CLAUDE_CONFIG_DIR = $savedConfig
    $env:CLAUDE_SYNC_HOME = $savedSync
    if (-not $ok) { Stop-Setup "Connecting the repository didn't work (see the message above). Check the address and that you can open it on github.com, then run this again." }
    # The app starts in it, and leaves the usual Claude folder ("Main") out on this PC.
    $extra = @()
    if ($reg -and $reg.extra) { $extra = @($reg.extra | Where-Object { $_.id -ne $id }) }
    $extra += [pscustomobject]@{ id = $id; name = $workspace; remote = $remote }
    $off = @("main")
    if ($reg -and $reg.disconnected) { $off = @(@($reg.disconnected) + "main" | Where-Object { $_ -ne $id } | Select-Object -Unique) }
    # The earlier chats are listed by what they are, not as "Main".
    $mainName = if ($reg -and $reg.mainName) { $reg.mainName } else { "Earlier Claude Code chats" }
    $out = [ordered]@{ current = $id; mainName = $mainName; extra = $extra; disconnected = $off }
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    [IO.File]::WriteAllText($registry, ($out | ConvertTo-Json -Depth 4))
    # claude-<id> in any terminal: Claude Code in this workspace (plain "claude" stays as it was).
    $launcher = "claude-$id"
    $bin = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps"
    New-Item -ItemType Directory -Force $bin | Out-Null
    $claudeExe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -match '\.(exe|cmd)$' } | Select-Object -First 1).Source
    if (-not $claudeExe) { $claudeExe = "claude" }
    $esc = { param($s) $s -replace '%', '%%' }
    $cmdLines = @("@echo off", "set `"CLAUDE_CONFIG_DIR=$(& $esc $activeClaude)`"", "set `"CLAUDE_SYNC_HOME=$(& $esc $wsSync)`"", "`"$(& $esc $claudeExe)`" %*")
    [IO.File]::WriteAllText((Join-Path $bin "$launcher.cmd"), ($cmdLines -join "`r`n") + "`r`n")
    Done "$workspace has its own Claude folder. In a terminal: $launcher (plain claude keeps the old chats)"
  }
  Done "This PC is `"$machine`" and $workspace syncs with $remote"
}

# ---------------------------------------------------------------- 4. the app
Step 4 "The Conversations app"
$exe = Join-Path $env:LOCALAPPDATA "Programs\Conversations\Conversations.exe"
$setup = Get-ChildItem $Here -Filter "Conversations Setup *.exe" | Sort-Object { [version]($_.BaseName -replace '^Conversations Setup ', '') } | Select-Object -Last 1
# The version the installed copy came from (its installer's): an older one is upgraded,
# since installs before 0.5 can't take their updates from the app's own repository.
$have = $null
if (Test-Path $exe) { try { $have = [version]((Get-Item $exe).VersionInfo.ProductVersion) } catch { $have = [version]"0.0.0" } }
$want = if ($setup) { [version](($setup.BaseName -replace '^Conversations Setup ', '') + ".0") } else { $null }
if ($have -and (-not $want -or $have -ge $want)) { Done "Already installed (it updates itself)" }
elseif (-not $setup) { Stop-Setup "The app's installer isn't next to this file. Copy `"Conversations Setup x.y.z.exe`" here and run this again." }
elseif ($Check) { if ($have) { Todo "The installed app ($have) would be upgraded to $($setup.Name)" } else { Todo "$($setup.Name) would be installed" } }
else {
  if ($have) {
    Say "      Upgrading the installed app to $($setup.Name) (it closes for a moment) ..."
    Get-Process Conversations -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  } else { Say "      Installing $($setup.Name) ..." }
  Say "      Windows may warn that it's from an unknown publisher: choose More info, then Run anyway."
  Start-Process -FilePath $setup.FullName -ArgumentList "/S" -Wait
  Done "Installed"
}

# ---------------------------------------------------------------- 5. Claude sign-in
Step 5 "Claude account"
$signedIn = (Test-Path (Join-Path $activeClaude ".credentials.json"))
if (-not $signedIn) {
  # Claude Code keeps its account record beside the usual folder, inside one of its own.
  $record = if ($activeClaude -eq $claudeDir) { Join-Path $HOME ".claude.json" } else { Join-Path $activeClaude ".claude.json" }
  try { $signedIn = [bool](Get-Content $record -Raw | ConvertFrom-Json).oauthAccount } catch {}
}
if ($signedIn) { Done "Claude Code is signed in" }
elseif ($Check) { Todo "Claude Code would open so you can sign in" }
else {
  $run = if ($launcher) { $launcher } else { "claude" }
  Say "      Claude Code opens in a new window. Sign in with this workspace's Claude account, then close that window."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $run
}

# ---------------------------------------------------------------- 6. done
Step 6 "Finished"
if ($Check) { Write-Host "      Check finished. Nothing was changed." -ForegroundColor White }
else {
  Write-Host "      All set. Open Conversations from the Start menu." -ForegroundColor White
  Write-Host ""
  Read-Host "Press Enter to close" | Out-Null
}
