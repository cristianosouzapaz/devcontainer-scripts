$tmp     = "$env:TEMP\devcontainer-init"
$branch  = "main"
$base    = "https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/$branch"
$noCache = @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }

New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$manifest = (Invoke-WebRequest "$base/launcher.manifest.json" -Headers $noCache -UseBasicParsing).Content | ConvertFrom-Json

foreach ($file in @($manifest.files)) {
    $dest = Join-Path -Path $tmp -ChildPath $file
    New-Item -ItemType Directory -Force -Path (Split-Path -Path $dest) | Out-Null
    Invoke-WebRequest "$base/$file" -Headers $noCache -OutFile $dest -UseBasicParsing
}

& "$tmp\project-init.ps1"
