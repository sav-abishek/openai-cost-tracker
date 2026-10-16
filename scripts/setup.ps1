param([switch]$SkipBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$toolsRoot = Join-Path $projectRoot '.tools'
$nodeVersion = 'v24.22.0'
$nodeFolder = Join-Path $toolsRoot ('node-' + $nodeVersion + '-win-x64')
$nodeBinary = Join-Path $nodeFolder 'node.exe'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
if (-not (Test-Path -LiteralPath $nodeBinary)) {
    $archiveName = 'node-' + $nodeVersion + '-win-x64.zip'
    $archive = Join-Path $toolsRoot $archiveName
    $baseUrl = 'https://nodejs.org/dist/' + $nodeVersion + '/'
    Write-Host ('Downloading portable Node.js ' + $nodeVersion + ' into this project…')
    Invoke-WebRequest -Uri ($baseUrl + $archiveName) -OutFile $archive
    $checksums = (Invoke-WebRequest -Uri ($baseUrl + 'SHASUMS256.txt')).Content
    $expectedLine = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $archiveName) } | Select-Object -First 1)
    if (-not $expectedLine) { throw 'Node.js archive was not listed in the published checksums.' }
    $expected = ($expectedLine -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw 'Node.js checksum mismatch. Archive was not extracted.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolsRoot
}
$npmCli = Join-Path $nodeFolder 'node_modules\npm\bin\npm-cli.js'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $toolsRoot 'browsers'
$originalPath = $env:PATH
try {
    $env:PATH = $nodeFolder + [IO.Path]::PathSeparator + $originalPath
    Push-Location -LiteralPath $projectRoot
    try {
        $npmAction = if (Test-Path -LiteralPath 'package-lock.json') { 'ci' } else { 'install' }
        & $nodeBinary $npmCli $npmAction --ignore-scripts --no-audit --no-fund --cache (Join-Path $toolsRoot 'npm-cache')
        if ($LASTEXITCODE -ne 0) { throw 'Local development dependency installation failed.' }
        if (-not $SkipBrowser) {
            & $nodeBinary (Join-Path $projectRoot 'node_modules\playwright\cli.js') install chromium --only-shell
            if ($LASTEXITCODE -ne 0) { throw 'Project-local test browser installation failed.' }
        }
    } finally { Pop-Location }
} finally { $env:PATH = $originalPath }
Write-Host 'Development tools are ready inside .tools and node_modules. Run .\scripts\dev.ps1 test or .\scripts\dev.ps1 verify:ui.'
