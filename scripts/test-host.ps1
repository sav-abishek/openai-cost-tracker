param([ValidateSet('empty','restricted')][string]$Case = 'empty')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeBinary = Join-Path $projectRoot '.tools\node-v24.22.0-win-x64\node.exe'
$codeCommand = (Get-Command code -ErrorAction Stop).Source
$codeExecutable = [IO.Path]::GetFullPath((Join-Path (Split-Path $codeCommand) '..\Code.exe'))
$userDirectory = Join-Path $projectRoot ('.test-host\user-' + $Case)
$extensionsDirectory = Join-Path $projectRoot '.test-host\extensions'
$artifactsDirectory = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Force -Path (Join-Path $userDirectory 'User'), $artifactsDirectory | Out-Null
$caseSettings = @{ 'security.workspace.trust.startupPrompt' = 'never'; 'security.workspace.trust.emptyWindow' = $false; 'update.mode' = 'none'; 'telemetry.telemetryLevel' = 'off' }
$caseSettings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $userDirectory 'User\settings.json') -Encoding utf8
& $nodeBinary (Join-Path $projectRoot 'test\host-fixture.js') | Out-Null
& $codeCommand --user-data-dir $userDirectory --extensions-dir $extensionsDirectory --install-extension (Join-Path $projectRoot 'openai-cost-tracker-0.2.0.vsix') --force
if ($LASTEXITCODE -ne 0) { throw 'Could not install isolated test extension.' }
$env:AI_COST_LEDGER_TEST_DATA_DIR = Join-Path $projectRoot '.test-host\shared-data'
$env:AI_COST_LEDGER_HOST_FIXTURE = '1'
$env:CODEX_HOME = Join-Path $projectRoot '.test-host\codex-fixture'
$env:AI_COST_LEDGER_HOST_REPORT = Join-Path $artifactsDirectory ('host-' + $Case + '.json')
$env:AI_COST_LEDGER_TEST_INSTALLED_PATH = Join-Path $extensionsDirectory 'abishek-local.ai-cost-ledger-0.2.0'
$arguments = @('--extensionDevelopmentPath="' + $projectRoot + '"', '--extensionTestsPath="' + (Join-Path $projectRoot 'test\host-runner.js') + '"', '--user-data-dir="' + $userDirectory + '"', '--extensions-dir="' + $extensionsDirectory + '"', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-gpu')
if ($Case -eq 'restricted') { $arguments += '"' + (Join-Path $projectRoot '.test-host\project-1') + '"' }
$process = Start-Process -FilePath $codeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $artifactsDirectory ('host-' + $Case + '-stdout.log')) -RedirectStandardError (Join-Path $artifactsDirectory ('host-' + $Case + '-stderr.log'))
Write-Output ('Started isolated ' + $Case + ' VS Code host test, PID ' + $process.Id)
