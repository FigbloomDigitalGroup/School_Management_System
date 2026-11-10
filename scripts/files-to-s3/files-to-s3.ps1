<#
Moves Figbloom Schools' stored files from Supabase Storage to S3. Windows PowerShell 5.1, with the AWS CLI and an SSO
profile (figbloom-<env>). Each step can be run again.

  .\files-to-s3.ps1 -Step export     on the server: every file into its backups bucket, files-export/<bucket>/<path>
  .\files-to-s3.ps1 -Step copy       from here: those into the files API's buckets (public-assets into its own)
  .\files-to-s3.ps1 -Step check      counts per bucket: exported vs copied
  .\files-to-s3.ps1 -Step switch     on the server, one transaction: public file links -> CloudFront, files_service row
  .\files-to-s3.ps1 -Step back       undoes switch (files uploaded to S3 since are not copied back)
  .\files-to-s3.ps1 -Step cleanup    deletes files-export/ from the backups bucket, once you're happy

Before: SchoolsFiles-<env> deployed (figbloom-platform), and Schools migrations up to 20261110130000 applied.
Run export, copy and check, then switch straight after: a file uploaded between export and switch would be left behind
(run export and copy again just before switching to catch it).
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('export', 'copy', 'check', 'switch', 'back', 'cleanup')][string]$Step,
  [ValidateSet('prod', 'staging')][string]$Environment = 'prod'
)
$ErrorActionPreference = 'Stop'
$profileName = "figbloom-$Environment"
$region = 'eu-west-1'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-Output($stack, $key) {
  $v = aws cloudformation describe-stacks --stack-name $stack --profile $profileName --region $region `
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
  if ($LASTEXITCODE -ne 0 -or -not $v -or $v -eq 'None') { throw "No output $key on $stack (signed in? aws sso login --profile $profileName)" }
  return $v.Trim()
}

# Runs a bash script on the database server through SSM Run Command and prints what it said. The script travels base64
# encoded, so nothing in it needs quoting for PowerShell, JSON or the shell.
function Invoke-OnServer($instance, $bash, $what) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bash.Replace("`r`n", "`n")))
  $params = @{ commands = @("echo $b64 | base64 -d > /tmp/figbloom-step.sh && bash /tmp/figbloom-step.sh; rc=`$?; rm -f /tmp/figbloom-step.sh; exit `$rc"); executionTimeout = @('7200') }
  $file = Join-Path $env:TEMP 'figbloom-ssm-params.json'
  ($params | ConvertTo-Json -Compress) | Set-Content -Encoding ascii $file
  try {
    $id = aws ssm send-command --profile $profileName --region $region --instance-ids $instance --document-name AWS-RunShellScript `
      --comment $what --parameters "file://$file" --query Command.CommandId --output text
    if ($LASTEXITCODE -ne 0) { throw "send-command failed" }
  } finally { Remove-Item $file -ErrorAction SilentlyContinue }
  Write-Host "$what : running on $instance (command $id)..."
  do {
    Start-Sleep -Seconds 5
    $status = aws ssm get-command-invocation --profile $profileName --region $region --command-id $id --instance-id $instance --query Status --output text 2>$null
  } while ($status -in @('Pending', 'InProgress', 'Delayed', '', $null))
  $out = aws ssm get-command-invocation --profile $profileName --region $region --command-id $id --instance-id $instance --query StandardOutputContent --output text
  $err = aws ssm get-command-invocation --profile $profileName --region $region --command-id $id --instance-id $instance --query StandardErrorContent --output text
  Write-Host $out
  if ($err -and $err.Trim() -and $err.Trim() -ne 'None') { Write-Host "--- stderr ---"; Write-Host $err }
  Write-Host "status: $status"
  if ($status -ne 'Success') { throw "$what did not succeed ($status)" }
}

function Count-Objects($uri) {
  $lines = aws s3 ls $uri --recursive --profile $profileName --region $region 2>$null
  if (-not $lines) { return 0 }
  return @($lines).Count
}

function Invoke-Sql($instance, $sqlFile, $vars, $what) {
  $sql = [IO.File]::ReadAllText((Join-Path $here $sqlFile))
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sql.Replace("`r`n", "`n")))
  $vs = ($vars.GetEnumerator() | ForEach-Object { "-v $($_.Key)='$($_.Value)'" }) -join ' '
  $bash = "set -euo pipefail`necho $b64 | base64 -d > /tmp/figbloom-step.sql`n" +
          "docker exec -i supabase-db psql -U supabase_admin -d postgres -X -q -At $vs < /tmp/figbloom-step.sql 2>&1 | sed 's/^NOTICE:  //'`n" +
          "rm -f /tmp/figbloom-step.sql`n"
  Invoke-OnServer $instance $bash $what
}

$dbStack = "SchoolsDatabase-$Environment"
$filesStack = "SchoolsFiles-$Environment"
$backups = Get-Output $dbStack 'BackupsBucket'

switch ($Step) {
  'export' {
    $instance = Get-Output $dbStack 'InstanceId'
    $script = [IO.File]::ReadAllText((Join-Path $here 'export-files.sh'))
    Invoke-OnServer $instance ("export BACKUPS_BUCKET='$backups'`n" + $script) 'Export Schools files'
  }
  'copy' {
    $files = Get-Output $filesStack 'FilesBucketName'
    $public = Get-Output $filesStack 'PublicAssetsBucketName'
    # S3 to S3: content type, cache setting and the uploader (x-amz-meta-owner) come along
    aws s3 cp "s3://$backups/files-export/public-assets/" "s3://$public/" --recursive --only-show-errors --profile $profileName --region $region
    if ($LASTEXITCODE -ne 0) { throw 'copying public-assets failed' }
    aws s3 cp "s3://$backups/files-export/" "s3://$files/" --recursive --exclude 'public-assets/*' --only-show-errors --profile $profileName --region $region
    if ($LASTEXITCODE -ne 0) { throw 'copying the private files failed' }
    Write-Host 'Copied. Now: .\files-to-s3.ps1 -Step check'
  }
  'check' {
    $files = Get-Output $filesStack 'FilesBucketName'
    $public = Get-Output $filesStack 'PublicAssetsBucketName'
    $rows = foreach ($b in 'public-assets', 'private-documents', 'learning-media', 'chat-files') {
      $dest = if ($b -eq 'public-assets') { "s3://$public/" } else { "s3://$files/$b/" }
      $exported = Count-Objects "s3://$backups/files-export/$b/"
      $copied = Count-Objects $dest
      [pscustomobject]@{ bucket = $b; exported = $exported; in_s3 = $copied; ok = ($copied -ge $exported) }
    }
    $rows | Format-Table -AutoSize
    if ($rows | Where-Object { -not $_.ok }) { throw 'Some files are missing in S3: run -Step copy again' }
    Write-Host 'Every exported file is in S3. Next: .\files-to-s3.ps1 -Step switch'
  }
  'switch' {
    $instance = Get-Output $dbStack 'InstanceId'
    $hostname = Get-Output $dbStack 'Hostname'
    $api = Get-Output $filesStack 'FilesApiUrl'
    $cdn = Get-Output $filesStack 'PublicAssetsUrl'
    Invoke-Sql $instance 'switch.sql' ([ordered]@{
      old_prefix = "https://$hostname/storage/v1/object/public/public-assets/"; new_prefix = "$cdn/"
      api_url = $api; public_base_url = $cdn
    }) 'Switch Schools files to S3'
    Write-Host 'Switched. Apps use S3 from their next start (reload the web app; reopen the phone apps).'
  }
  'back' {
    $instance = Get-Output $dbStack 'InstanceId'
    $hostname = Get-Output $dbStack 'Hostname'
    $cdn = Get-Output $filesStack 'PublicAssetsUrl'
    Invoke-Sql $instance 'switch-back.sql' ([ordered]@{
      old_prefix = "https://$hostname/storage/v1/object/public/public-assets/"; new_prefix = "$cdn/"
    }) 'Switch Schools files back to Supabase Storage'
  }
  'cleanup' {
    aws s3 rm "s3://$backups/files-export/" --recursive --only-show-errors --profile $profileName --region $region
    if ($LASTEXITCODE -ne 0) { throw 'cleanup failed' }
    Write-Host 'Removed files-export/ from the backups bucket.'
  }
}
