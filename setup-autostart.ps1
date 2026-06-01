# Ratan Auto-Start Setup
# Run this ONCE as Administrator to register ratan as a Windows startup service.
# After this, ratan starts automatically on every boot — no manual steps needed.

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot

Write-Host "`n=== Ratan Auto-Start Setup ===" -ForegroundColor Cyan

# 1. Install PM2 globally (remove pm2-windows-startup — we use Task Scheduler instead)
Write-Host "`n[1/4] Installing PM2..." -ForegroundColor Yellow
npm install -g pm2

# 2. Build the Next.js frontend (required for production mode)
Write-Host "`n[2/4] Building frontend (this takes ~1 min)..." -ForegroundColor Yellow
Set-Location "$ProjectRoot\frontend"
npm run build
Set-Location $ProjectRoot

# 3. Create logs directory
New-Item -ItemType Directory -Force -Path "$ProjectRoot\logs" | Out-Null

# 4. Start both services with PM2 and save the process list
Write-Host "`n[3/4] Starting services with PM2..." -ForegroundColor Yellow
Set-Location $ProjectRoot
# Clear any previous Ratan apps first so re-running setup never stacks
# duplicate processes fighting over the same ports (the "many windows" storm).
pm2 delete ratan-backend ratan-frontend 2>$null
pm2 start ecosystem.config.js
pm2 save

# 5. Register a hidden Windows startup task via Task Scheduler
# We use a .vbs launcher so NO console window appears on boot.
Write-Host "`n[4/4] Registering silent Windows startup task..." -ForegroundColor Yellow

$pm2Path = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2Path) {
    # npm global bin fallback
    $npmBin = npm root -g 2>$null | Split-Path
    $pm2Path = Join-Path $npmBin "pm2.cmd"
}

# Create a VBScript that runs pm2 resurrect silently (no visible window)
$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$pm2Path"" resurrect", 0, False
"@
$vbsPath = "$ProjectRoot\ratan-startup.vbs"
Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII

# Register as a Task Scheduler job that runs at logon for current user
$taskName = "RatanAutoStart"
# Remove old task if it exists
schtasks /delete /tn $taskName /f 2>$null

$xmlTask = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions>
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"$vbsPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = "$env:TEMP\ratan-task.xml"
Set-Content -Path $xmlPath -Value $xmlTask -Encoding Unicode
schtasks /create /tn $taskName /xml $xmlPath /f
Remove-Item $xmlPath -Force

Write-Host "`n=== Done! ===" -ForegroundColor Green
Write-Host "Backend:  http://localhost:5000" -ForegroundColor White
Write-Host "Frontend: http://localhost:4500" -ForegroundColor White
Write-Host "`nBoth services will now start SILENTLY on every Windows boot (no console window)." -ForegroundColor Cyan
Write-Host "To check status:   pm2 status" -ForegroundColor Gray
Write-Host "To see logs:       pm2 logs" -ForegroundColor Gray
Write-Host "To stop all:       pm2 stop all" -ForegroundColor Gray
Write-Host "To restart all:    pm2 restart all" -ForegroundColor Gray
