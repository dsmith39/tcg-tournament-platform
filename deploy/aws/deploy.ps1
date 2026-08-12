# Deploys tcg-tournament-platform to theduelclub.com on AWS.
#
# One-time bootstrap (not part of routine deploys -- run manually once):
#   aws s3 mb s3://theduelclub-deploy-<account-id> --region us-east-1
#
# Requires: AWS CLI (authenticated), Docker Desktop running (used only to
# zip the Lambda package with run.sh's executable bit intact -- Windows zip
# tools strip Unix file-mode bits, which breaks the Lambda Web Adapter's
# cold start), Node/npm.
#
# Usage:
#   .\deploy\aws\deploy.ps1                  # full deploy (app + frontend)
#   .\deploy\aws\deploy.ps1 -SyncCardImages  # also sync card-database/card-images (~4.6GB, slow)
param(
  [switch]$SyncCardImages,
  [string]$JwtSecret
)

$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
$stackName = 'theduelclub'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Invoke-Checked {
  param([string]$Description, [scriptblock]$Command)
  Write-Host "-- $Description"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit code $LASTEXITCODE)"
  }
}

Push-Location $repoRoot
try {
  if (-not $JwtSecret) {
    $envFile = Join-Path $repoRoot '.env'
    if (Test-Path $envFile) {
      $match = Select-String -Path $envFile -Pattern '^JWT_SECRET=(.+)$' | Select-Object -First 1
      if ($match) { $JwtSecret = $match.Matches[0].Groups[1].Value.Trim() }
    }
  }
  if (-not $JwtSecret) {
    throw "No JWT secret found. Set JWT_SECRET in .env (see .env.example) or pass -JwtSecret, then re-run. Reusing the same secret across deploys keeps existing sessions valid."
  }

  $accountId = (aws sts get-caller-identity --query Account --output text).Trim()
  $deployBucket = "theduelclub-deploy-$accountId"

  Write-Host "== Building Lambda deployment package =="
  $buildDir = Join-Path $repoRoot 'build'
  $stagingDir = Join-Path $buildDir 'lambda-src'
  if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
  New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

  Copy-Item (Join-Path $repoRoot 'server.js') $stagingDir
  Copy-Item (Join-Path $repoRoot 'run.sh') $stagingDir
  Copy-Item (Join-Path $repoRoot 'package.json') $stagingDir
  Copy-Item (Join-Path $repoRoot 'package-lock.json') $stagingDir
  Copy-Item -Recurse (Join-Path $repoRoot 'server') (Join-Path $stagingDir 'server')
  # server/ws-handler is a separate Lambda packaged by its own CodeUri in
  # template.yaml -- not part of the main app zip.
  Remove-Item -Recurse -Force (Join-Path $stagingDir 'server\ws-handler') -ErrorAction SilentlyContinue

  New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir 'card-database\src') | Out-Null
  Copy-Item -Recurse (Join-Path $repoRoot 'card-database\src\*') (Join-Path $stagingDir 'card-database\src')
  New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir 'card-database\data') | Out-Null
  $cardsDb = Join-Path $repoRoot 'card-database\data\cards.db'
  if (-not (Test-Path $cardsDb)) {
    throw "card-database\data\cards.db not found -- run 'npm run cards:init-db' and 'npm run cards:import' first."
  }
  Copy-Item $cardsDb (Join-Path $stagingDir 'card-database\data\cards.db')

  Write-Host 'Installing production dependencies into the staged package...'
  Push-Location $stagingDir
  & npm.cmd ci --omit=dev
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm ci --omit=dev failed' }
  Pop-Location

  Write-Host 'Zipping via Docker (preserves run.sh executable bit)...'
  $zipPath = Join-Path $buildDir 'function.zip'
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  docker run --rm -v "${buildDir}:/build" node:22-slim bash -c "cd /build/lambda-src && chmod +x run.sh && apt-get update -qq && apt-get install -y -qq zip > /dev/null && zip -rq /build/function.zip ."
  if ($LASTEXITCODE -ne 0) { throw 'Docker-based zip build failed -- is Docker Desktop running?' }
  if (-not (Test-Path $zipPath)) { throw 'Expected build/function.zip was not created' }

  Write-Host "== Packaging and deploying CloudFormation stack '$stackName' =="
  $packagedTemplate = Join-Path $repoRoot 'packaged.yaml'
  Invoke-Checked 'cloudformation package' {
    aws cloudformation package `
      --template-file (Join-Path $repoRoot 'template.yaml') `
      --s3-bucket $deployBucket `
      --output-template-file $packagedTemplate `
      --region $region
  }

  Invoke-Checked 'cloudformation deploy' {
    aws cloudformation deploy `
      --template-file $packagedTemplate `
      --stack-name $stackName `
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND `
      --region $region `
      --parameter-overrides "JwtSecret=$JwtSecret"
  }

  Write-Host '== Reading stack outputs =='
  $outputsJson = aws cloudformation describe-stacks --stack-name $stackName --region $region --query 'Stacks[0].Outputs' --output json
  $outputs = @{}
  foreach ($item in ($outputsJson | ConvertFrom-Json)) { $outputs[$item.OutputKey] = $item.OutputValue }

  Write-Host '== Staging frontend =='
  $frontendDir = Join-Path $buildDir 'frontend'
  if (Test-Path $frontendDir) { Remove-Item -Recurse -Force $frontendDir }
  New-Item -ItemType Directory -Force -Path $frontendDir | Out-Null
  Copy-Item (Join-Path $repoRoot 'tcg-frontend-updated.html') (Join-Path $frontendDir 'index.html')
  Copy-Item (Join-Path $repoRoot 'tcg-frontend.css') $frontendDir
  Copy-Item (Join-Path $repoRoot 'tcg-frontend.js') $frontendDir

  $configJs = @"
window.TCG_CONFIG = {
  apiBaseUrl: 'https://api.theduelclub.com',
  wsUrl: 'wss://ws.theduelclub.com',
  cardImageBaseUrl: '$($outputs['CdnUrl'])'
};
"@
  Set-Content -Path (Join-Path $frontendDir 'config.js') -Value $configJs -Encoding utf8

  Write-Host '== Syncing frontend to S3 =='
  Invoke-Checked 's3 sync (frontend)' {
    aws s3 sync $frontendDir "s3://$($outputs['FrontendBucketName'])" --delete --region $region
  }

  Write-Host '== Invalidating frontend CloudFront cache =='
  aws cloudfront create-invalidation --distribution-id $outputs['FrontendDistributionId'] --paths '/*' --region $region | Out-Null

  if ($SyncCardImages) {
    $cardImagesDir = Join-Path $repoRoot 'card-database\card-images'
    if (-not (Test-Path $cardImagesDir)) {
      throw "card-database\card-images not found -- run 'npm run cards:download-images' first."
    }
    Write-Host '== Syncing card images to S3 (this can take a while for ~4.6GB) =='
    Invoke-Checked 's3 sync (card images)' {
      aws s3 sync $cardImagesDir "s3://$($outputs['CardImagesBucketName'])" --cache-control 'public, max-age=31536000, immutable' --only-show-errors --region $region
    }
    Write-Host '== Invalidating CDN CloudFront cache =='
    aws cloudfront create-invalidation --distribution-id $outputs['CdnDistributionId'] --paths '/*' --region $region | Out-Null
  }

  Write-Host ''
  Write-Host 'Deploy complete.'
  Write-Host "  Site: $($outputs['SiteUrl'])"
  Write-Host "  API (execute-api, works before DNS/cert finish): $($outputs['ApiEndpoint'])"
  Write-Host "  WebSocket (execute-api, works before DNS/cert finish): $($outputs['WsEndpoint'])"
  Write-Host "  CDN: $($outputs['CdnUrl'])"
  if (-not $SyncCardImages) {
    Write-Host ''
    Write-Host 'Card images were not synced this run -- re-run with -SyncCardImages once (or after refreshing the local mirror).'
  }
}
finally {
  Pop-Location
}
