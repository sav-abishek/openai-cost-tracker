param([ValidateSet('test','package','verify:ui')][string]$Task = 'test')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeFolder = Join-Path $projectRoot '.tools\node-v24.22.0-win-x64'
$nodeBinary = Join-Path $nodeFolder 'node.exe'
if (-not (Test-Path -LiteralPath $nodeBinary)) { throw 'Run .\scripts\setup.ps1 first.' }
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $projectRoot '.tools\browsers'
$originalPath = $env:PATH
try {
    $env:PATH = $nodeFolder + [IO.Path]::PathSeparator + $originalPath
    Push-Location -LiteralPath $projectRoot
    try {
        & $nodeBinary (Join-Path $nodeFolder 'node_modules\npm\bin\npm-cli.js') run $Task
        if ($LASTEXITCODE -ne 0) { throw ('Task failed: ' + $Task) }
    } finally { Pop-Location }
} finally { $env:PATH = $originalPath }
