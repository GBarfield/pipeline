# Consolidated morning status check for the EN download/load pipeline.
# Replaces the ad-hoc round of separate Get-Content/Select-String commands
# we've been running fresh (and re-guessing paths for) most mornings this
# week. Reads the same underlying files, just in one place with the correct
# paths baked in and the noisy bits (repeated unresolved-hold lines, raw
# stdout grepping) cleaned up.
#
# Usage: powershell.exe -File morning_report.ps1
#        powershell.exe -File morning_report.ps1 -Date "2026-08-27"   # a past day

param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd')
)

$flagPath        = "C:\BenAdmin\EN-Reports\download-complete.flag"
$renameDebugLog  = "C:\temp\rename_debug.log"
$flagDebugLog    = "C:\temp\flag_debug.log"
$enLogDir        = "C:\BenAdmin\EN-Reports\logs"
$failedDir       = "C:\BenAdmin\EN-Reports\failed"
$possibleDupLog  = Join-Path $enLogDir "possible-duplicates.log"
$serviceStderr   = "C:\Projects\benadmin\apps\api\service-stderr.log"

# Optional: if you export companies.csv from UI.Vision to this path, the
# report will also flag which companies never even got attempted last night.
# Safe to leave missing - this section is skipped gracefully if it's not there.
$companiesReference = "C:\BenAdmin\EN-Reports\companies_reference.csv"

function Section($title) {
    Write-Host ""
    Write-Host "==== $title ====" -ForegroundColor Cyan
}

Section "1. Completion flag"
if (Test-Path $flagPath) {
    $flagTime = (Get-Item $flagPath).LastWriteTime
    $ageHours = [math]::Round(((Get-Date) - $flagTime).TotalHours, 1)
    Write-Host "Flag written: $flagTime ($ageHours h ago)"
} else {
    Write-Host "NO FLAG FOUND at $flagPath - downloader did not report completion." -ForegroundColor Red
}
if (Test-Path $flagDebugLog) {
    $lastFlagWrite = Get-Content $flagDebugLog | Select-Object -Last 1
    Write-Host "Last flag-writer log entry: $lastFlagWrite"
}

Section "2. Rename script scoreboard ($Date)"
if (Test-Path $renameDebugLog) {
    $lines = Get-Content $renameDebugLog | Where-Object { $_ -match "^$Date" }
    $successLines = $lines | Select-String "SUCCESS"
    $failedLines  = $lines | Select-String "FAILED"
    $circuitLines = $lines | Select-String "CIRCUIT BREAKER"
    Write-Host "SUCCESS: $($successLines.Count)   FAILED: $($failedLines.Count)   CIRCUIT BREAKER TRIPPED: $($circuitLines.Count)"
    if ($failedLines.Count -gt 0) {
        Write-Host "Failed attempts:" -ForegroundColor Yellow
        $failedLines | ForEach-Object { Write-Host "  $_" }
    }
    if ($circuitLines.Count -gt 0) {
        Write-Host "CIRCUIT BREAKER fired - run was likely cut short:" -ForegroundColor Red
        $circuitLines | ForEach-Object { Write-Host "  $_" }
    }
    # Slow-wait outliers - anything that didn't resolve near-instantly, worth
    # knowing about even when it technically succeeded.
    $slow = $successLines | Where-Object { $_ -match 'waited (\d+)s' -and [int]$Matches[1] -ge 30 }
    if ($slow.Count -gt 0) {
        Write-Host "Slow successes (waited >=30s):" -ForegroundColor Yellow
        $slow | ForEach-Object { Write-Host "  $_" }
    }
} else {
    Write-Host "rename_debug.log not found at $renameDebugLog" -ForegroundColor Red
}

Section "3. loadElections.ts result (latest substantive run)"
if (Test-Path $enLogDir) {
    # Most ticks fire every 15 minutes and process nothing (files already
    # archived from the last real run) - "latest by file time" was landing on
    # one of those empty ticks instead of the run that actually did the work.
    # Show both: proof the scheduler is alive, and the last run that mattered.
    $allRunFiles = Get-ChildItem $enLogDir -Filter "run-*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 200

    if ($allRunFiles.Count -gt 0) {
        $mostRecentTick = Get-Content $allRunFiles[0].FullName -Raw | ConvertFrom-Json
        Write-Host "Scheduler last ticked: $($mostRecentTick.finishedAt) (batch $($mostRecentTick.batchId), $($mostRecentTick.filesTotal) file(s) that tick)"

        $latestSubstantive = $null
        foreach ($rf in $allRunFiles) {
            $s = Get-Content $rf.FullName -Raw | ConvertFrom-Json
            if ($s.filesTotal -gt 0) { $latestSubstantive = $s; break }
        }

        if ($latestSubstantive) {
            $summary = $latestSubstantive
            Write-Host ""
            Write-Host "Most recent run that processed files: batch $($summary.batchId), finished $($summary.finishedAt)"
            Write-Host "Files: $($summary.filesLoaded)/$($summary.filesTotal) loaded, $($summary.totalRowsLoaded) rows, $($summary.totalEmployeesUpserted) employees, $($summary.filesFailed) not loaded"
            $notLoaded = $summary.outcomes | Where-Object { $_.status -ne "loaded" }
            if ($notLoaded.Count -gt 0) {
                Write-Host "Not loaded:" -ForegroundColor Yellow
                foreach ($o in $notLoaded) {
                    $detail = switch ($o.status) {
                        "possible_duplicate" { "held - $([math]::Round($o.similarityScore*100))% similar to existing group #$($o.possibleDuplicateGroupId) `"$($o.possibleDuplicateGroupName)`"" }
                        "ambiguous"          { "held - multiple existing groups matched" }
                        "parse_error"        { "parse error: $($o.error)" }
                        "load_error"         { "load error: $($o.error)" }
                        default              { $o.status }
                    }
                    Write-Host "  $($o.file) -> $detail"
                }
            }
        } else {
            Write-Host "No run in the last $($allRunFiles.Count) tick(s) processed any files."
        }
    } else {
        Write-Host "No run-*.json summary files found in $enLogDir yet."
    }
} else {
    Write-Host "$enLogDir not found." -ForegroundColor Red
}

Section "4. Unresolved holds (deduped by company, across all pending dates)"
if (Test-Path $failedDir) {
    $held = Get-ChildItem $failedDir -Directory | ForEach-Object {
        $folder = $_.Name
        Get-ChildItem $_.FullName -Filter "*.csv" -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{ Company = $_.BaseName -replace '\s*\(\d+\)$',''; Folder = $folder }
        }
    }
    $grouped = $held | Group-Object Company | Sort-Object Count -Descending
    foreach ($g in $grouped) {
        $dates = ($g.Group.Folder | Sort-Object -Unique) -join ", "
        Write-Host "  $($g.Name)  [$($g.Count) file(s), seen: $dates]"
    }
    if ($grouped.Count -eq 0) { Write-Host "None." }
} else {
    Write-Host "$failedDir not found." -ForegroundColor Red
}

Section "5. reconcileCoverage - latest ATTENTION / stale groups"
if (Test-Path $serviceStderr) {
    $latestAttention = Get-Content $serviceStderr | Select-String "reconcileCoverage.*ATTENTION" | Select-Object -Last 1
    if ($latestAttention) { Write-Host "$latestAttention" }
    Get-Content $serviceStderr -Tail 500 | Select-String "reconcileCoverage.*STALE" | Select-Object -Unique | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "$serviceStderr not found." -ForegroundColor Red
}

Section "6. Companies never attempted (optional - needs companies_reference.csv)"
if ((Test-Path $companiesReference) -and (Test-Path $renameDebugLog)) {
    $allCompanies = Import-Csv $companiesReference | Select-Object -ExpandProperty Company
    $attempted = Get-Content $renameDebugLog | Where-Object { $_ -match "^$Date.*SUCCESS" } | ForEach-Object {
        if ($_ -match "-> (.+)\.csv \(waited") { $Matches[1] }
    }
    $skipped = $allCompanies | Where-Object { $attempted -notcontains $_ }
    if ($skipped.Count -gt 0) {
        Write-Host "Skipped entirely (no download attempt logged):" -ForegroundColor Yellow
        $skipped | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "None - every company in the reference list was attempted."
    }
} else {
    Write-Host "Skipped - export companies.csv from UI.Vision to $companiesReference to enable this check."
}

Write-Host ""
Write-Host "==== Done ====" -ForegroundColor Cyan