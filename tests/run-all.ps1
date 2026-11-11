#requires -Version 7.0
<#
.SYNOPSIS
  Pipeline completo de QA do DSH Voice Suite.

.DESCRIPTION
  Executa, em ordem, com resumo final e cleanup garantido:

    1. node --check em todos os .js/.mjs (packages, scripts, tests);
    2. sync --check (src/ vs lib/) dos dois plugins;
    3. tests/smoke-client.mjs   (bundles cliente: vm + react-dom/server);
    4. tests/server.mjs         (RPC com ctx falso: validação, proto-pollution, dispose);
    5. setup-runtime -Check     (advisory: avisa se o runtime Python não está pronto);
    6. scripts/dev-server.ps1   (sobe profile voice-dev na porta 3099 com token);
    7. tests/e2e.mjs            (boot, DOM, Settings, RPC, mic real, TTS, hot-apply);
    8. fase runtime ausente:     dev server com DSH_VOICE_HOME vazio -> e2e --expect-missing;
    9. dev-server down (sempre, inclusive em falha).

  Gera tests/artifacts/run-all-summary.json e logs por passo em tests/artifacts/.
  NÃO reinicia nem toca no app Desktop (52301) e NÃO instala no profile desktop.

.PARAMETER Profile
  Profile de integração. Default: voice-dev.

.PARAMETER Port
  Porta do dev server. Default: 3099.

.PARAMETER SkipE2E
  Pula dev server + e2e (roda só estáticos/smoke/servidor).

.PARAMETER SkipSetup
  Pula o setup-runtime -Check.

.PARAMETER SkipMissingRuntime
  Pula a fase "runtime ausente" do E2E.

.PARAMETER Strict
  WARN também falha o pipeline; SKIP em e2e também.

.PARAMETER HotApply
  Passa --hot-apply ao e2e (reinstala os plugins já instalados e recarrega).

.PARAMETER E2EExtraArgs
  Argumentos adicionais repassados ao tests/e2e.mjs.

.EXAMPLE
  pwsh -File tests/run-all.ps1
  pwsh -File tests/run-all.ps1 -SkipMissingRuntime -HotApply
  pwsh -File tests/run-all.ps1 -SkipE2E -Strict
#>
[CmdletBinding()]
param(
    [string]$Profile = 'voice-dev',
    [int]$Port = 3099,
    [switch]$SkipE2E,
    [switch]$SkipSetup,
    [switch]$SkipMissingRuntime,
    [switch]$Strict,
    [switch]$HotApply,
    [string[]]$E2EExtraArgs = @()
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Artifacts = Join-Path $PSScriptRoot 'artifacts'
$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:StartedAt = Get-Date
$script:ServerStarted = $false
$script:MissingServerStarted = $false
$env:NODE_ENV = 'production'
# Descoberta portátil do CLI dsh (para o hot-apply do E2E e mensagens de erro).
$script:DshCliPath = $null
$dshResolveLib = Join-Path $script:RepoRoot 'scripts\lib\dsh-resolve.ps1'
if (Test-Path -LiteralPath $dshResolveLib) {
    . $dshResolveLib
    if (Get-Command Resolve-DshCliPath -ErrorAction SilentlyContinue) {
        $script:DshCliPath = Resolve-DshCliPath
    }
}

New-Item -ItemType Directory -Force -Path $script:Artifacts | Out-Null

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
}

function Add-Step {
    param(
        [string]$Name,
        [ValidateSet('pass', 'fail', 'warn', 'skip')]
        [string]$Status,
        [string]$Detail,
        [int]$DurationMs = 0,
        [string]$LogFile
    )
    if ($DurationMs -le 0 -and $script:TimerStart) { $DurationMs = [int]((Get-Date) - $script:TimerStart).TotalMilliseconds }
    $script:Steps.Add([pscustomobject]@{
            Name       = $Name
            Status     = $Status
            Detail     = $Detail
            DurationMs = $DurationMs
            LogFile    = $LogFile
        })
    $symbol = @{ pass = '[ok]  '; fail = '[FAIL]'; warn = '[warn]'; skip = '[skip]' }[$Status]
    $color = @{ pass = 'Green'; fail = 'Red'; warn = 'Yellow'; skip = 'DarkGray' }[$Status]
    Write-Host ("{0} {1}" -f $symbol, $Name) -ForegroundColor $color
    if ($Detail) {
        foreach ($line in ($Detail -split "`r?`n")) { Write-Host ("       " + $line) -ForegroundColor DarkGray }
    }
}

function Invoke-PipelineStep {
    <# Roda um comando externo, grava log do passo e registra status. #>
    param(
        [string]$Name,
        [scriptblock]$Action,
        [int]$TimeoutSeconds = 900,
        [switch]$WarnOnly
    )
    $started = Get-Date
    $logFile = Join-Path $script:Artifacts ("run-all-" + ($Name -replace '[^A-Za-z0-9._-]', '-') + '.log')
    Write-Host ''
    Write-Host "-> $Name" -ForegroundColor Cyan
    try {
        $job = Start-Job -ScriptBlock $Action -ErrorAction Stop
        if (-not (Wait-Job -Job $job -Timeout $TimeoutSeconds)) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
            Add-Step -Name $Name -Status 'fail' -Detail "timeout de ${TimeoutSeconds}s" -DurationMs ([int]((Get-Date) - $started).TotalMilliseconds) -LogFile $logFile
            return $false
        }
        $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
        $state = $job.State
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        $exitCode = if ($job.ChildJobs.Count -gt 0) { $job.ChildJobs[0].JobStateInfo.Reason ? 1 : 0 } else { 0 }
        $text = ($output | Out-String)
        Set-Content -LiteralPath $logFile -Value $text -Encoding utf8
        # imprime as últimas linhas para feedback
        $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() })
        if ($lines.Count -gt 0) {
            $tail = if ($lines.Count -gt 18) { $lines[($lines.Count - 18)..($lines.Count - 1)] } else { $lines }
            foreach ($line in $tail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
        }
        # scripts externos expõem exit code via $LASTEXITCODE dentro do job; capturamos pela convenção
        $failed = $text -match '(?m)^(FALHOU|FAIL|exit code: [1-9])'
        if ($state -ne 'Completed') { $failed = $true }
        if ($failed -and -not $WarnOnly) {
            Add-Step -Name $Name -Status 'fail' -Detail "falhou — veja $logFile" -DurationMs ([int]((Get-Date) - $started).TotalMilliseconds) -LogFile $logFile
            return $false
        }
        if ($failed -and $WarnOnly) {
            Add-Step -Name $Name -Status 'warn' -Detail "falhou (não bloqueante) — veja $logFile" -DurationMs ([int]((Get-Date) - $started).TotalMilliseconds) -LogFile $logFile
            return $true
        }
        Add-Step -Name $Name -Status 'pass' -Detail "ok — log: $(Split-Path -Leaf $logFile)" -DurationMs ([int]((Get-Date) - $started).TotalMilliseconds) -LogFile $logFile
        return $true
    }
    catch {
        Add-Step -Name $Name -Status 'fail' -Detail $_.Exception.Message -DurationMs ([int]((Get-Date) - $started).TotalMilliseconds) -LogFile $logFile
        return $false
    }
}

function Start-DevServer {
    param([string[]]$ExtraArgs = @())
    $arguments = @('-NoProfile', '-File', (Join-Path $script:RepoRoot 'scripts\dev-server.ps1'), '-Profile', $Profile, '-Port', $Port) + $ExtraArgs
    $output = & pwsh @arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    $logFile = Join-Path $script:Artifacts 'run-all-dev-server-up.log'
    Set-Content -LiteralPath $logFile -Value $output -Encoding utf8
    $tailLines = @($output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 8)
    foreach ($line in $tailLines) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
    return ($code -eq 0)
}

function Stop-DevServer {
    $output = & pwsh -NoProfile -File (Join-Path $script:RepoRoot 'scripts\dev-server.ps1') -Profile $Profile -Port $Port -Stop 2>&1 | Out-String
    $code = $LASTEXITCODE
    $logFile = Join-Path $script:Artifacts 'run-all-dev-server-down.log'
    Set-Content -LiteralPath $logFile -Value $output -Encoding utf8
    return ($code -eq 0)
}

# ===================== início =====================
Write-Head "DSH Voice Suite — run-all (QA completo)"
Write-Host "Repo      : $script:RepoRoot"
Write-Host "Profile   : $Profile"
Write-Host "Porta     : $Port"
Write-Host "Node      : $(node --version)"
Write-Host "Início    : $(Get-Date -Format o)"
Write-Host "Artefatos : $script:Artifacts"

try {
    # 1) node --check (script portátil: mesmo comando no CI e no run-all)
    $script:TimerStart = Get-Date
    Write-Head '1) Sintaxe (node --check)'
    $syntaxLog = Join-Path $script:Artifacts 'run-all-check-syntax.log'
    $syntaxOutput = & node (Join-Path $PSScriptRoot 'check-syntax.mjs') 2>&1 | Out-String
    $syntaxCode = $LASTEXITCODE
    Set-Content -LiteralPath $syntaxLog -Value $syntaxOutput -Encoding utf8
    $syntaxTail = @($syntaxOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 8)
    foreach ($line in $syntaxTail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
    if ($syntaxCode -eq 0) {
        Add-Step -Name 'check-syntax.mjs (node --check)' -Status 'pass' -Detail 'todos os .js/.mjs com sintaxe válida'
    }
    else {
        Add-Step -Name 'check-syntax.mjs (node --check)' -Status 'fail' -Detail "falhou — log: $syntaxLog"
    }
    # 2) sync --check (NÃO altera packages: dono é o dev de cada plugin)
    $script:TimerStart = Get-Date
    Write-Head '2) sync src/ -> lib/'
    $syncOutput = & node (Join-Path $script:RepoRoot 'scripts\sync.mjs') --check 2>&1 | Out-String
    $syncCode = $LASTEXITCODE
    Set-Content -LiteralPath (Join-Path $script:Artifacts 'run-all-sync-check.log') -Value $syncOutput -Encoding utf8
    foreach ($line in @($syncOutput -split "`r?`n" | Where-Object { $_.Trim() })) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
    if ($syncCode -eq 0) {
        Add-Step -Name 'sync --check' -Status 'pass' -Detail 'src/ e lib/ idênticos nos dois plugins'
    }
    else {
        Add-Step -Name 'sync --check' -Status 'fail' -Detail "src/ divergiu de lib/ — o DONO do pacote deve rodar: node scripts/sync.mjs (qa não escreve em packages/)"
    }

    # 3) smoke cliente
    $script:TimerStart = Get-Date
    Write-Head '3) smoke-client (bundles cliente)'
    $smokeLog = Join-Path $script:Artifacts 'run-all-smoke-client.log'
    $smokeOutput = & node (Join-Path $PSScriptRoot 'smoke-client.mjs') 2>&1 | Out-String
    $smokeCode = $LASTEXITCODE
    Set-Content -LiteralPath $smokeLog -Value $smokeOutput -Encoding utf8
    $smokeTail = @($smokeOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 10)
    foreach ($line in $smokeTail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
    if ($smokeCode -eq 0) { Add-Step -Name 'smoke-client.mjs' -Status 'pass' -Detail "relatório: tests/artifacts/smoke-client-report.json" }
    else { Add-Step -Name 'smoke-client.mjs' -Status 'fail' -Detail "falhou — log: $smokeLog (relatório smoke-client-report.json)" }

    # 4) servidor RPC
    $script:TimerStart = Get-Date
    Write-Head '4) server (RPC/validação/proto-pollution)'
    $serverLog = Join-Path $script:Artifacts 'run-all-server.log'
    $serverOutput = & node (Join-Path $PSScriptRoot 'server.mjs') 2>&1 | Out-String
    $serverCode = $LASTEXITCODE
    Set-Content -LiteralPath $serverLog -Value $serverOutput -Encoding utf8
    $serverTail = @($serverOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 10)
    foreach ($line in $serverTail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
    if ($serverCode -eq 0) { Add-Step -Name 'server.mjs' -Status 'pass' -Detail "relatório: tests/artifacts/server-report.json" }
    else { Add-Step -Name 'server.mjs' -Status 'fail' -Detail "falhou — log: $serverLog (relatório server-report.json)" }

    # 5) setup runtime (advisory)
    if (-not $SkipSetup) {
        $script:TimerStart = Get-Date
        Write-Head '5) setup-runtime -Check (advisory)'
        $setupLog = Join-Path $script:Artifacts 'run-all-setup-check.log'
        $setupOutput = & pwsh -NoProfile -File (Join-Path $script:RepoRoot 'scripts\setup-runtime.ps1') -Check 2>&1 | Out-String
        $setupCode = $LASTEXITCODE
        Set-Content -LiteralPath $setupLog -Value $setupOutput -Encoding utf8
        $summaryLines = @($setupOutput -split "`r?`n" | Select-String -Pattern '✓|✗|!|to: ' | Select-Object -First 20 | ForEach-Object { $_.Line })
        foreach ($line in $summaryLines) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
        if ($setupCode -eq 0) {
            Add-Step -Name 'setup-runtime -Check' -Status 'pass' -Detail 'runtime Python pronto (STT/TTS)'
        }
        else {
            Add-Step -Name 'setup-runtime -Check' -Status 'warn' -Detail "runtime não está 100% pronto; o E2E pode falhar em transcribe. Rode: pwsh -File scripts/setup-runtime.ps1" 
        }
    }
    else {
        Add-Step -Name 'setup-runtime -Check' -Status 'skip' -Detail '-SkipSetup'
    }

    if ($SkipE2E) {
        Add-Step -Name 'dev-server + e2e' -Status 'skip' -Detail '-SkipE2E' 
    }
    else {
        # 6) dev server up
        $script:TimerStart = Get-Date
        Write-Head "6) dev server (profile $Profile, porta $Port)"
        $started = Start-DevServer
        if (-not $started) {
            Add-Step -Name 'dev-server up' -Status 'fail' -Detail 'não conseguiu subir/health; veja tests/artifacts/run-all-dev-server-up.log'
        }
        else {
            $script:ServerStarted = $true
            $stateFile = Join-Path $script:Artifacts 'dev-server.json'
            $state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { $null }
            Add-Step -Name 'dev-server up' -Status 'pass' -Detail "HTTP ok em $(if ($state) { $state.baseUrl } else { "http://127.0.0.1:$Port/" }); PID $($state.listenerPid)"

            # 7) e2e normal
            $script:TimerStart = Get-Date
            Write-Head '7) e2e (runtime preparado)'
            $e2eArgs = @((Join-Path $PSScriptRoot 'e2e.mjs'), '--profile', $Profile)
            if ($HotApply) {
                $e2eArgs += '--hot-apply'
                if ($script:DshCliPath) { $e2eArgs += @('--dsh-cli', $script:DshCliPath) }
                else { Write-Host '   [!] CLI dsh não encontrado para o hot-apply; o E2E vai pular esse caso.' -ForegroundColor Yellow }
            }
            if ($Strict) { $e2eArgs += '--strict' }
            $e2eArgs += $E2EExtraArgs
            $e2eLog = Join-Path $script:Artifacts 'run-all-e2e.log'
            $e2eOutput = & node @e2eArgs 2>&1 | Out-String
            $e2eCode = $LASTEXITCODE
            Set-Content -LiteralPath $e2eLog -Value $e2eOutput -Encoding utf8
            $e2eTail = @($e2eOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 20)
            foreach ($line in $e2eTail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
            if ($e2eCode -eq 0) {
                Add-Step -Name 'e2e (runtime preparado)' -Status 'pass' -Detail 'relatórios: tests/artifacts/e2e-report.{json,md}'
            }
            else {
                Add-Step -Name 'e2e (runtime preparado)' -Status 'fail' -Detail 'falhou — relatório: tests/artifacts/e2e-report.md'
            }

            # 8) fase runtime ausente
            if (-not $SkipMissingRuntime) {
                $script:TimerStart = Get-Date
                Write-Head '8) e2e com runtime ausente (DSH_VOICE_HOME temporário)'
                Stop-DevServer | Out-Null
                $script:ServerStarted = $false
                $emptyHome = Join-Path $env:TEMP ("dsh-voice-empty-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
                New-Item -ItemType Directory -Force -Path $emptyHome | Out-Null
                $missingStarted = Start-DevServer -ExtraArgs @('-VoiceHome', $emptyHome)
                if (-not $missingStarted) {
                    Add-Step -Name 'e2e (runtime ausente)' -Status 'fail' -Detail "não subiu dev server com DSH_VOICE_HOME vazio ($emptyHome)"
                }
                else {
                    $script:MissingServerStarted = $true
                    $missingArgs = @((Join-Path $PSScriptRoot 'e2e.mjs'), '--profile', $Profile, '--expect-missing', '--artifacts-suffix', 'missing')
                    if ($Strict) { $missingArgs += '--strict' }
                    $missingLog = Join-Path $script:Artifacts 'run-all-e2e-missing.log'
                    $missingOutput = & node @missingArgs 2>&1 | Out-String
                    $missingCode = $LASTEXITCODE
                    Set-Content -LiteralPath $missingLog -Value $missingOutput -Encoding utf8
                    $missingTail = @($missingOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 14)
                    foreach ($line in $missingTail) { Write-Host ("   " + $line) -ForegroundColor DarkGray }
                    if ($missingCode -eq 0) {
                        Add-Step -Name 'e2e (runtime ausente)' -Status 'pass' -Detail 'status.ready=false + erro acionável validados (e2e-report-missing.{json,md})'
                    }
                    else {
                        Add-Step -Name 'e2e (runtime ausente)' -Status 'fail' -Detail 'falhou — relatório: tests/artifacts/e2e-report-missing.md'
                    }
                    Stop-DevServer | Out-Null
                    $script:MissingServerStarted = $false
                    try { Remove-Item -LiteralPath $emptyHome -Recurse -Force -ErrorAction SilentlyContinue } catch { }
                }
            }
            else {
                Add-Step -Name 'e2e (runtime ausente)' -Status 'skip' -Detail '-SkipMissingRuntime'
            }
        }
    }
}
finally {
    Write-Host ''
    Write-Host '--- cleanup ---' -ForegroundColor Cyan
    if ($script:ServerStarted -or $script:MissingServerStarted) {
        $stopped = Stop-DevServer
        Write-Host ("dev server parado: " + $(if ($stopped) { 'ok' } else { 'FALHOU — confira a porta ' + $Port }))
        $script:ServerStarted = $false
        $script:MissingServerStarted = $false
    }
    # resumo
    $counts = @{ pass = 0; fail = 0; warn = 0; skip = 0 }
    foreach ($step in $script:Steps) { $counts[$step.Status] += 1 }
    $durationMs = [int]((Get-Date) - $script:StartedAt).TotalMilliseconds
    $summary = [pscustomobject]@{
        startedAt   = $script:StartedAt.ToString('o')
        durationMs  = $durationMs
        profile     = $Profile
        port        = $Port
        counts      = $counts
        ok          = ($counts.fail -eq 0)
        steps       = $script:Steps
        artifacts   = @{
            e2e        = @(Get-ChildItem (Join-Path $script:Artifacts 'e2e-report*') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
            smoke      = Join-Path $script:Artifacts 'smoke-client-report.json'
            server     = Join-Path $script:Artifacts 'server-report.json'
            summary    = Join-Path $script:Artifacts 'run-all-summary.json'
            screenshots = @(Get-ChildItem (Join-Path $script:Artifacts 'e2e-*.png') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        }
    }
    $summaryFile = Join-Path $script:Artifacts 'run-all-summary.json'
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryFile -Encoding utf8

    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host 'RESUMO run-all' -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    $symbols = @{ pass = '✓'; fail = '✗'; warn = '!'; skip = '-' }
    foreach ($step in $script:Steps) {
        $color = @{ pass = 'Green'; fail = 'Red'; warn = 'Yellow'; skip = 'DarkGray' }[$step.Status]
        Write-Host ("  {0} {1,-42} {2}" -f $symbols[$step.Status], $step.Name, ("" + [Math]::Round($step.DurationMs / 1000, 1) + 's')) -ForegroundColor $color
    }
    Write-Host ''
    Write-Host ("  totais: ✓ {0}  ! {1}  ✗ {2}  - {3}" -f $counts.pass, $counts.warn, $counts.fail, $counts.skip) 
    Write-Host "  duração: $([Math]::Round($durationMs / 1000, 1))s"
    Write-Host "  relatório: $summaryFile"
    $strictFail = $Strict -and ($counts.warn -gt 0 -or $counts.skip -gt 0)
    if ($counts.fail -eq 0 -and -not $strictFail) {
        Write-Host ''
        Write-Host 'run-all: PIPELINE OK' -ForegroundColor Green
        exit 0
    }
    Write-Host ''
    Write-Host 'run-all: PIPELINE FALHOU' -ForegroundColor Red
    exit 1
}


