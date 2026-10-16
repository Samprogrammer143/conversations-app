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
$SyncHome = Join-Path $env:LOCALAPPDATA "claude-conversation-sync"
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
$claudeDir = Join-Path $HOME ".claude"
if ($env:OneDrive -and (Test-Path $claudeDir)) {
  $real = (Get-Item $claudeDir).FullName
  try { $target = (Get-Item $claudeDir).Target } catch { $target = $null }
  if ($real.StartsWith($env:OneDrive, "OrdinalIgnoreCase") -or ($target -and "$target".StartsWith($env:OneDrive, "OrdinalIgnoreCase"))) {
    Stop-Setup "Claude Code's folder ($claudeDir) is inside OneDrive. OneDrive would copy every PC's chats over each other. Move it out of OneDrive first, then run this again."
  }
}
$config = Join-Path $SyncHome "config.json"
$machine = $null
$remote = $null
if (Test-Path $config) {
  try { $c = Get-Content $config -Raw | ConvertFrom-Json; $machine = $c.machine; $remote = $c.remote } catch {}
}
$workspace = $null
if ($machine -and (Test-Path (Join-Path $RepoDir ".git"))) { Done "Already set up as `"$machine`", with $remote" }
elseif ($Check) { Todo "You would be asked for this PC's name, the repository that holds its conversations, and a name for it" }
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
    if ($remote -notmatch '^(https://[^/]+/.+|git@[^:]+:.+)$') { Say "      That doesn't look like a repository address (https://github.com/you/repo)."; $remote = $null }
  }
  $workspace = (Read-Host "      What should Conversations call it? (e.g. Work)").Trim()
  Say "      Connecting. If a GitHub sign-in opens in the browser, sign in with the account that owns that repository."
  node (Join-Path $AppDir "_sync\install.mjs") --remote "$remote" --machine "$machine"
  if ($LASTEXITCODE -ne 0) { Stop-Setup "Connecting the repository didn't work (see the message above). Check the address and that you can open it on github.com, then run this again." }
  Done "This PC is `"$machine`" and its conversations sync with $remote"
}
# The name the app shows for this workspace (only the first time).
$registry = Join-Path $DataDir "workspaces.json"
if ($workspace -and -not (Test-Path $registry) -and -not $Check) {
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $json = @{ current = "main"; mainName = $workspace; extra = @() } | ConvertTo-Json
  [IO.File]::WriteAllText($registry, $json)
}

# ---------------------------------------------------------------- 4. the app
Step 4 "The Conversations app"
$installed = Test-Path (Join-Path $env:LOCALAPPDATA "Programs\Conversations\Conversations.exe")
$setup = Get-ChildItem $Here -Filter "Conversations Setup *.exe" | Sort-Object { [version]($_.BaseName -replace '^Conversations Setup ', '') } | Select-Object -Last 1
if ($installed) { Done "Already installed (it updates itself)" }
elseif (-not $setup) { Stop-Setup "The app's installer isn't next to this file. Copy `"Conversations Setup x.y.z.exe`" here and run this again." }
elseif ($Check) { Todo "$($setup.Name) would be installed" }
else {
  Say "      Installing $($setup.Name) ..."
  Say "      Windows may warn that it's from an unknown publisher: choose More info, then Run anyway."
  Start-Process -FilePath $setup.FullName -ArgumentList "/S" -Wait
  Done "Installed"
}

# ---------------------------------------------------------------- 5. Claude sign-in
Step 5 "Claude account"
$signedIn = (Test-Path (Join-Path $claudeDir ".credentials.json"))
if (-not $signedIn) {
  try { $signedIn = [bool](Get-Content (Join-Path $HOME ".claude.json") -Raw | ConvertFrom-Json).oauthAccount } catch {}
}
if ($signedIn) { Done "Claude Code is signed in" }
elseif ($Check) { Todo "Claude Code would open so you can sign in" }
else {
  Say "      Claude Code opens in a new window. Sign in with this PC's Claude account, then close that window."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "claude"
}

# ---------------------------------------------------------------- 6. done
Step 6 "Finished"
if ($Check) { Write-Host "      Check finished. Nothing was changed." -ForegroundColor White }
else {
  Write-Host "      All set. Open Conversations from the Start menu." -ForegroundColor White
  Write-Host ""
  Read-Host "Press Enter to close" | Out-Null
}
