# deploy.ps1 - pull the latest code from GitHub and deploy it on this server.
#
# Run on the server, from an elevated PowerShell:
#     cd C:\Projects\benadmin
#     .\deploy.ps1            # deploy whatever changed since the last deploy
#     .\deploy.ps1 -Full      # rebuild/restart everything, even if nothing changed
#
# What it does, based on which files changed between the current commit and
# origin/main:
#   package.json / pnpm-lock.yaml -> pnpm install --frozen-lockfile
#   apps/api/prisma/**            -> prisma migrate deploy + prisma generate
#                                    (migrate DEPLOY, not dev: it only applies
#                                    pending migrations and never offers to
#                                    reset the database)
#   apps/api/**, packages/**      -> nssm restart BenAdminAPI + health check
#   apps/web/**, packages/**      -> pnpm build + mirror dist into IIS
#                                    (web.config in wwwroot is preserved)
#   apps/bucket/**                -> nssm restart BenAdminBucket
#
# It refuses to run if tracked files were edited directly on the server, so
# a hot-fix made here is never silently overwritten. Commit it (or move it to
# your dev machine) first. Ignored files (.env, uploads, logs, node_modules,
# generated/) are never touched.
#
# A transcript of every run is written to C:\Projects\deploy-logs.

param([switch]$Full)

$ErrorActionPreference = 'Stop'
$failed  = $false
$Root    = 'C:\Projects\benadmin'
$WebRoot = 'C:\inetpub\wwwroot'
$Health  = 'http://localhost:3000/api/health'
$LogDir  = 'C:\Projects\deploy-logs'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir ("deploy-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))) | Out-Null

function Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" } }

try {
    Set-Location $Root

    Step 'Checking for local edits on the server'
    $dirty = git status --porcelain --untracked-files=no
    if ($dirty) {
        Write-Host $dirty -ForegroundColor Yellow
        throw 'Tracked files were changed directly on the server. Commit/push them or discard them (git checkout -- <file>) before deploying.'
    }

    Step 'Fetching from GitHub'
    $before = (git rev-parse HEAD).Trim()
    git fetch origin --prune; Check 'git fetch'
    $after = (git rev-parse origin/main).Trim()

    if ($before -eq $after -and -not $Full) {
        Write-Host "Already up to date at $($before.Substring(0,7)). Use -Full to redeploy anyway." -ForegroundColor Green
        return
    }

    $changed = @()
    if ($before -ne $after) {
        Write-Host "Commits being deployed:"
        git log --oneline "$before..$after"
        $changed = @(git diff --name-only $before $after)
        git merge --ff-only origin/main; Check 'git merge --ff-only (has the server branch diverged from main?)'
    }

    function Changed($pattern) { return $Full -or [bool]($changed | Where-Object { $_ -match $pattern }) }

    $doInstall = Changed '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$'
    $doPrisma  = Changed '^apps/api/prisma/'
    $doApi     = Changed '^apps/api/|^packages/'
    $doWeb     = Changed '^apps/web/|^packages/'
    $doBucket  = Changed '^apps/bucket/'

    if ($doInstall) {
        Step 'Installing dependencies (pnpm install --frozen-lockfile)'
        pnpm install --frozen-lockfile; Check 'pnpm install'
    }

    if ($doPrisma) {
        Step 'Applying database migrations'
        Push-Location "$Root\apps\api"
        pnpm exec prisma migrate deploy; Check 'prisma migrate deploy'
        pnpm exec prisma generate;       Check 'prisma generate'
        Pop-Location
    }

    if ($doApi) {
        Step 'Restarting API service (BenAdminAPI)'
        nssm restart BenAdminAPI
        $ok = $false
        foreach ($i in 1..15) {
            Start-Sleep -Seconds 2
            try { Invoke-RestMethod $Health -TimeoutSec 5 | Out-Null; $ok = $true; break } catch { }
        }
        if (-not $ok) {
            Write-Host 'API did not answer the health check. Last lines of the error log:' -ForegroundColor Red
            Get-Content "$Root\apps\api\service-stderr.log" -Tail 40 -ErrorAction SilentlyContinue
            Write-Host 'Tip: run "node src/index.ts" in apps\api in the foreground to see the real error.' -ForegroundColor Yellow
            throw 'API health check failed'
        }
        Write-Host 'API is healthy.' -ForegroundColor Green
    }

    if ($doWeb) {
        Step 'Building frontend'
        Push-Location "$Root\apps\web"
        pnpm build; Check 'pnpm build (web)'
        Pop-Location

        Step "Publishing frontend to $WebRoot"
        # /MIR removes stale old bundles; web.config (SPA routing + /api proxy) is kept.
        robocopy "$Root\apps\web\dist" $WebRoot /MIR /XF web.config /NFL /NDL /NJH /NP | Out-Host
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
        $global:LASTEXITCODE = 0
    }

    if ($doBucket) {
        Step 'Restarting Bucket service (BenAdminBucket)'
        if ($changed | Where-Object { $_ -match '^apps/bucket/requirements.*\.txt$' }) {
            Write-Host 'NOTE: Python requirements changed. Install them into the Bucket environment before relying on this restart.' -ForegroundColor Yellow
        }
        nssm restart BenAdminBucket
    }

    Step "Done. Now at $((git rev-parse --short HEAD).Trim())"
}
catch {
    Write-Host "`nDEPLOY FAILED: $_" -ForegroundColor Red
    $failed = $true
}
finally {
    Stop-Transcript | Out-Null
}
if ($failed) { exit 1 }
