<#
=====================================================================
 ONE App  -  Notifications module deploy script  (v1.13)
=====================================================================
 Copies the Notifications feature files into the PROD install and
 backs up everything it overwrites so you can roll back instantly.

 WHAT IT DOES (safe by design):
   * Backs up every existing target file/folder into a timestamped
     folder under  <Dst>\_deploy_backup\  BEFORE overwriting.
   * Copies the NEW + EDITED backend/frontend files into place.
   * NEVER overwrites the prod .env  -> only APPENDS the 3 new keys
     if they are missing (your DB/SMTP secrets are untouched).
   * Creates  backend\secrets\  (empty) for the FCM service account.
   * Runs  node --check  on the copied backend JS. If any file fails
     to parse it STOPS and tells you to roll back.
   * Does NOT restart the service and does NOT run npm  -> you do that
     after you eyeball the summary (commands printed at the end).

 USAGE (run on the PROD server, in an elevated PowerShell):
   1. Copy this whole "ONE App Version 1.13" folder onto the prod box
      (a temp/staging path is fine, e.g. E:\_staging\ONE App Version 1.13).
      node_modules is NOT needed for the copy.
   2. cd into  ...\ONE App Version 1.13\deploy
   3. Preview first :  .\deploy-notifications.ps1 -DryRun
   4. Do it        :  .\deploy-notifications.ps1
   (Override the prod path with  -Dst "E:\ONE App Version 1.7"  if different.)
=====================================================================
#>

[CmdletBinding()]
param(
    # Source = the v1.13 tree. Auto-detected as this script's parent folder.
    [string]$Src = (Split-Path -Parent $PSScriptRoot),
    # Destination = the live prod install (the folder the BizNAV-App service runs from).
    [string]$Dst = "E:\ONE App Version 1.7",
    # Preview only, copy nothing.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Say($m,$c='Gray'){ Write-Host $m -ForegroundColor $c }

Say "=====================================================================" Cyan
Say " ONE App - Notifications deploy" Cyan
Say "   Source : $Src" Cyan
Say "   Dest   : $Dst" Cyan
Say ("   Mode   : " + $(if($DryRun){"DRY RUN (nothing copied)"}else{"LIVE COPY"})) Cyan
Say "=====================================================================" Cyan

# --- sanity checks -------------------------------------------------
if (-not (Test-Path (Join-Path $Src 'backend')))  { throw "Source looks wrong - no 'backend' under: $Src" }
if (-not (Test-Path (Join-Path $Dst 'backend')))  { throw "Dest looks wrong - no 'backend' under: $Dst" }

# --- backup folder -------------------------------------------------
# NB: Date.Now is fine in a real PowerShell session on the server.
$stamp     = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupDir = Join-Path $Dst ("_deploy_backup\notif_" + $stamp)

# --- file / folder manifest ---------------------------------------
# Kind: NEW = didn't exist on prod (safe) | EDIT = replaces an existing prod file (backed up + verify)
$items = @(
    # ---- backend ----
    @{ Rel='backend\services\notify.js';                 Type='file'; Kind='NEW'  },
    @{ Rel='backend\services\fcm.js';                    Type='file'; Kind='NEW'  },
    @{ Rel='backend\services\notificationCron.js';       Type='file'; Kind='NEW'  },
    @{ Rel='backend\modules\notifications';              Type='dir';  Kind='NEW'  },
    @{ Rel='backend\server.js';                          Type='file'; Kind='EDIT' },
    @{ Rel='backend\modules\hr\routes\leave.js';         Type='file'; Kind='EDIT' },
    @{ Rel='backend\package.json';                       Type='file'; Kind='EDIT' },
    # ---- frontend ----
    @{ Rel='frontend\shared\common.js';                  Type='file'; Kind='EDIT' },
    @{ Rel='frontend\shared\modules.js';                 Type='file'; Kind='EDIT' },
    @{ Rel='frontend\modules\notifications';             Type='dir';  Kind='NEW'  },
    @{ Rel='frontend\service-worker.js';                 Type='file'; Kind='EDIT' }
)

# --- pre-flight: confirm every source item exists ------------------
$missing = @()
foreach ($it in $items) {
    if (-not (Test-Path (Join-Path $Src $it.Rel))) { $missing += $it.Rel }
}
if ($missing.Count) {
    Say "`nMISSING in source - aborting:" Red
    $missing | ForEach-Object { Say "   $_" Red }
    throw "Source is incomplete. Make sure the full v1.13 tree was copied over."
}

# --- copy loop -----------------------------------------------------
$copied = New-Object System.Collections.ArrayList
foreach ($it in $items) {
    $s = Join-Path $Src $it.Rel
    $d = Join-Path $Dst $it.Rel
    $tag = if ($it.Kind -eq 'NEW') { '[NEW ]' } else { '[EDIT]' }

    # backup existing target
    if (Test-Path $d) {
        $b = Join-Path $backupDir $it.Rel
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
            Copy-Item -Recurse -Force -Path $d -Destination $b
        }
        Say "$tag backup  $($it.Rel)" DarkGray
    } elseif ($it.Kind -eq 'EDIT') {
        Say "$tag WARN: prod file did not exist (expected EDIT) - will create: $($it.Rel)" Yellow
    }

    # copy new version
    if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null
        if ($it.Type -eq 'dir') {
            if (Test-Path $d) { Remove-Item -Recurse -Force $d }
            Copy-Item -Recurse -Force -Path $s -Destination $d
        } else {
            Copy-Item -Force -Path $s -Destination $d
        }
    }
    Say "$tag copy -> $($it.Rel)" Green
    [void]$copied.Add($it.Rel)
}

# --- .env : APPEND missing keys only (never overwrite) -------------
$envPath = Join-Path $Dst 'backend\.env'
$envKeys = [ordered]@{
    'NOTIF_CRON_ENABLED'       = 'false'   # keep false until you validate with /run-scan
    'NOTIF_WA_ENABLED'         = 'false'
    'FCM_SERVICE_ACCOUNT_PATH' = ''        # set to .\secrets\fcm-service-account.json in Part D
}
if (Test-Path $envPath) {
    $envText = Get-Content $envPath -Raw
    $toAdd = @()
    foreach ($k in $envKeys.Keys) {
        if ($envText -notmatch "(?m)^\s*$([regex]::Escape($k))\s*=") {
            $toAdd += ("{0}={1}" -f $k, $envKeys[$k])
        }
    }
    if ($toAdd.Count) {
        if (-not $DryRun) {
            Add-Content -Path $envPath -Value "`r`n# --- Notifications (v1.13) added $stamp ---"
            $toAdd | ForEach-Object { Add-Content -Path $envPath -Value $_ }
        }
        Say "`n.env : appended $($toAdd.Count) key(s):" Green
        $toAdd | ForEach-Object { Say "        $_" Green }
    } else {
        Say "`n.env : all 3 keys already present - left untouched." DarkGray
    }
} else {
    Say "`n.env : NOT FOUND at $envPath - add the 3 keys manually." Yellow
}

# --- secrets folder for the FCM service account --------------------
$secrets = Join-Path $Dst 'backend\secrets'
if (-not (Test-Path $secrets)) {
    if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $secrets | Out-Null }
    $verb = if ($DryRun) { 'would create' } else { 'created' }
    Say "secrets: $verb backend\secrets\ (drop fcm-service-account.json here)" Green
} else {
    Say "secrets: backend\secrets\ already exists." DarkGray
}

# --- validate copied backend JS parses -----------------------------
if (-not $DryRun) {
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if ($node) {
        Say "`nValidating backend JS (node --check)..." Cyan
        $checkFiles = @(
            'backend\services\notify.js','backend\services\fcm.js',
            'backend\services\notificationCron.js','backend\modules\notifications\index.js',
            'backend\server.js','backend\modules\hr\routes\leave.js'
        )
        $bad = @()
        foreach ($f in $checkFiles) {
            $p = Join-Path $Dst $f
            if (Test-Path $p) {
                & node --check $p 2>$null
                if ($LASTEXITCODE -ne 0) { $bad += $f; Say "   FAIL  $f" Red }
                else { Say "   ok    $f" DarkGray }
            }
        }
        if ($bad.Count) {
            Say "`n*** SYNTAX ERRORS in copied files - DO NOT restart the service. ***" Red
            Say "Roll back with:" Red
            Say "   Copy-Item -Recurse -Force '$backupDir\*' '$Dst'" Red
            throw "node --check failed on $($bad.Count) file(s)."
        }
        Say "All backend files parse cleanly." Green
    } else {
        Say "`n(node not on PATH - skipped syntax validation)" Yellow
    }
}

# --- summary + next steps ------------------------------------------
Say "`n=====================================================================" Cyan
Say (" DONE - " + $copied.Count + " item(s) " + $(if($DryRun){"would be copied (dry run)"}else{"copied"})) Green
if (-not $DryRun) { Say " Backup: $backupDir" Cyan }
Say "=====================================================================" Cyan
Say "`nNEXT STEPS (run these yourself):" White
Say "  # 1) In-app bell works after just restarting:" Gray
Say "  Restart-Service BizNAV-App" White
Say "  #    then Cloudflare-purge app.example.com  (bump SW already done)" Gray
Say "" Gray
Say "  # 2) For phone PUSH (after you drop the Firebase service-account JSON):" Gray
Say "  #    put it at  $secrets\fcm-service-account.json" Gray
Say "  #    set FCM_SERVICE_ACCOUNT_PATH=.\secrets\fcm-service-account.json in backend\.env" Gray
Say "  cd `"$Dst\backend`"" White
Say "  npm install firebase-admin" White
Say "  Restart-Service BizNAV-App    # log should show: FCM push initialized" White
Say "" Gray
Say "  # 3) Test: POST /api/notifications/run-scan (admin) -> bell fills." Gray
Say "  #    When happy, set NOTIF_CRON_ENABLED=true in .env + restart." Gray
Say "" Gray
Say "ROLLBACK (undo this deploy):" White
if (-not $DryRun) {
    Say "  Copy-Item -Recurse -Force `"$backupDir\*`" `"$Dst`"" White
    Say "  Restart-Service BizNAV-App" White
}
Say ""
