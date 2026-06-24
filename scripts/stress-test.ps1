#Requires -Version 5.1
<#
.SYNOPSIS
    HTTP stress test for the ratan-core backend API.

.DESCRIPTION
    Hammers the key endpoints with concurrent requests and reports latency
    percentiles + error counts. Designed to surface regressions on low-end
    devices (budget Celeron / Pentium CPUs, 4 GB RAM).

    The backend must already be running. Start it with:
        cargo run -p ratan-core --release
    or via the Tauri dev shell.

.PARAMETER BaseUrl
    Root URL of the backend (default: http://127.0.0.1:3001)

.PARAMETER Concurrency
    Number of parallel workers per endpoint batch (default: 8)

.PARAMETER Iterations
    Total requests per endpoint (default: 100)

.EXAMPLE
    .\scripts\stress-test.ps1
    .\scripts\stress-test.ps1 -BaseUrl http://127.0.0.1:3001 -Concurrency 4 -Iterations 50
#>
param(
    [string]$BaseUrl    = 'http://127.0.0.1:3001',
    [int]   $Concurrency = 8,
    [int]   $Iterations  = 100
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helper: fire $Iterations GET requests against $Url with up to $Concurrency
# in-flight at once; return an array of elapsed milliseconds.
# ---------------------------------------------------------------------------
function Invoke-LoadTest {
    param([string]$Url, [string]$Label)

    Write-Host "`n--- $Label ---" -ForegroundColor Cyan
    Write-Host "    $Url  ($Iterations requests, concurrency $Concurrency)"

    $results   = [System.Collections.Concurrent.ConcurrentBag[object]]::new()
    $semaphore = [System.Threading.SemaphoreSlim]::new($Concurrency, $Concurrency)
    $jobs      = @()

    for ($i = 0; $i -lt $Iterations; $i++) {
        $semaphore.Wait()
        $jobs += Start-ThreadJob -ScriptBlock {
            param($url, $sem, $bag)
            try {
                $sw  = [System.Diagnostics.Stopwatch]::StartNew()
                $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -Method GET -TimeoutSec 10
                $sw.Stop()
                $bag.Add([PSCustomObject]@{ Ms = $sw.ElapsedMilliseconds; Status = [int]$resp.StatusCode; Ok = $true })
            } catch {
                $bag.Add([PSCustomObject]@{ Ms = 0; Status = 0; Ok = $false; Err = $_.Exception.Message })
            } finally {
                $sem.Release() | Out-Null
            }
        } -ArgumentList $Url, $semaphore, $results
    }

    $jobs | Wait-Job | Out-Null
    $jobs | Remove-Job

    $ok    = $results | Where-Object Ok
    $fail  = $results | Where-Object { -not $_.Ok }
    $times = ($ok | ForEach-Object { $_.Ms }) | Sort-Object

    if ($times.Count -gt 0) {
        $p50  = $times[[int]($times.Count * 0.50)]
        $p95  = $times[[int]($times.Count * 0.95)]
        $p99  = $times[[int]($times.Count * 0.99)]
        $mean = [int](($times | Measure-Object -Sum).Sum / $times.Count)
        $max  = $times[-1]

        Write-Host ("    OK: {0,4}  Fail: {1,4}" -f $ok.Count, $fail.Count)
        Write-Host ("    mean={0}ms  p50={1}ms  p95={2}ms  p99={3}ms  max={4}ms" -f $mean, $p50, $p95, $p99, $max)

        if ($fail.Count -gt 0) {
            $fail | Select-Object -First 3 | ForEach-Object {
                Write-Host "    ERROR: $($_.Err)" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "    ALL REQUESTS FAILED" -ForegroundColor Red
        $fail | Select-Object -First 5 | ForEach-Object {
            Write-Host "    $($_.Err)" -ForegroundColor Red
        }
    }

    return $results
}

# ---------------------------------------------------------------------------
# Verify the server is reachable before hammering it.
# ---------------------------------------------------------------------------
Write-Host "Ratan backend stress test" -ForegroundColor Yellow
Write-Host "Base URL : $BaseUrl"
Write-Host "Workers  : $Concurrency"
Write-Host "Requests : $Iterations per endpoint"

try {
    $ping = Invoke-WebRequest -Uri "$BaseUrl/system/status" -UseBasicParsing -TimeoutSec 5
    Write-Host "Server reachable (HTTP $([int]$ping.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "Cannot reach $BaseUrl/system/status — is the backend running?" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Run each endpoint.
# ---------------------------------------------------------------------------
$endpoints = @(
    @{ Url = "$BaseUrl/system/status";   Label = 'GET /system/status (lightweight)' },
    @{ Url = "$BaseUrl/system/printers"; Label = 'GET /system/printers (OS enumerate)' },
    @{ Url = "$BaseUrl/jobs?limit=50";   Label = 'GET /jobs?limit=50 (DB list)' },
    @{ Url = "$BaseUrl/jobs?limit=200";  Label = 'GET /jobs?limit=200 (DB heavy list)' },
    @{ Url = "$BaseUrl/activity";        Label = 'GET /activity (activity log)' }
)

foreach ($ep in $endpoints) {
    Invoke-LoadTest -Url $ep.Url -Label $ep.Label | Out-Null
}

Write-Host "`nDone." -ForegroundColor Green
