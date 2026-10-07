# Phase 5 — comparison engine wiring. No Prisma schema change this round, so no
# `prisma generate`/`db push` needed — just type-check, build, redeploy, restart.

# 1. Type-check the API (comparisonEngine files are TS-only, no dedicated test
#    suite - this is the cheapest way to catch a mismatch before restarting the
#    live service).
cd C:\Projects\benadmin\apps\api
pnpm tsc --noEmit

# 2. Build the API. (tsx/--experimental-strip-types runs .ts directly in prod,
#    but `build` is still worth running here as a second, stricter compile check -
#    skip this line if apps/api has no build script and rely on step 1 alone.)
pnpm build

# 3. Restart the API service so it picks up the new comparisonEngine files.
nssm restart BenAdminAPI

# 4. Confirm it came back up clean.
nssm status BenAdminAPI
Start-Sleep -Seconds 2
Invoke-RestMethod http://localhost:3000/api/health -ErrorAction SilentlyContinue

# 5. Build the frontend (GroupWorkspace.tsx change).
cd C:\Projects\benadmin\apps\web
pnpm build

# 6. Deploy the built frontend to IIS (same site/path used for previous deploys).
Copy-Item -Path C:\Projects\benadmin\apps\web\dist\* -Destination C:\inetpub\wwwroot -Recurse -Force

# 7. Sanity check: confirm the comparison route responds for a real deal (swap in
#    an actual dealId). A 200 with a `tabs` array (even an empty one) means the
#    wiring is good; a 500 here means check service-stderr.log next.
Invoke-RestMethod -Method Post http://localhost:3000/api/deals/1/comparison/build | ConvertTo-Json -Depth 5
