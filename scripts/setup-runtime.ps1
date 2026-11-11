#requires -Version 7.0
<#
.SYNOPSIS
  Prepara o runtime Python dos plugins DSH Voice Suite (STT Whisper e TTS edge).

.DESCRIPTION
  Faz, de forma idempotente e sem terminal interativo:

    STT: <VoiceHome>\stt\{venv,models,logs}
      1. localiza um Python base 3.10–3.12 de forma portátil
         (DSH_VOICE_PYTHON/DSH_STT_PYTHON -> runtime do app DSH -> py 3.12/3.11/3.10
         -> python/python3 validados; 3.13+ é recusado com aviso, sem letra fixa);
      2. cria/valida o venv (`python -m venv`);
      3. instala `packages/dsh-whisper-stt/runtime/requirements.txt` quando existir,
         senão o fallback pinado `faster-whisper==1.2.1`;
      4. pré-baixa o modelo Whisper (default `small`) para `<stt>\models`;
      5. valida GPU/CUDA vs CPU (cuDNN ausente => CPU é o esperado, não é falha).

    TTS: <VoiceHome>\tts\{venv,cache}
      1. mesmo venv base;
      2. instala `packages/dsh-tts/runtime/requirements.txt` quando existir,
         senão o fallback pinado `edge-tts==7.3.1`;
      3. valida import do edge-tts e as vozes SAPI (pt-BR/en-US).

  Logs em <VoiceHome>\logs\setup-runtime-<timestamp>.log.
  Resumo final com ✓/✗ e "Próximos passos". Passos opcionais (modelo, CUDA,
  vozes SAPI) nunca derrubam o script sem explicar; passos obrigatórios (venv,
  pip dos alvos pedidos) resultam em exit 1.

.PARAMETER Model
  Modelo Whisper a pré-baixar: tiny|base|small|medium|large-v3. Default: small.

.PARAMETER SkipModel
  Não baixa/carrega o modelo Whisper (venv/deps continuam).

.PARAMETER Target
  both (default), stt ou tts.

.PARAMETER PythonPath
  Python base explícito para criar os venvs. Default: auto-detecção portátil
  (DSH_VOICE_PYTHON/DSH_STT_PYTHON -> runtime do app DSH -> py 3.12/3.11/3.10 ->
  python/python3 validados em 3.10–3.12).

.PARAMETER VoiceHome
  Diretório de dados de voz. Default: $env:DSH_VOICE_HOME ou
  $env:USERPROFILE\.dsh\dsh-voice.

.PARAMETER Check
  Apenas diagnostica (não cria/altera nada). Exit 0 se o runtime pedido está
  pronto; 1 se falta algo.

.PARAMETER Force
  Recria venvs quebrados/antigos e força `pip install --upgrade`.

.PARAMETER SttRequirement
  Override do fallback STT (ex.: 'faster-whisper==1.2.1'). Ignorado se o
  runtime/requirements.txt do plugin existir.

.PARAMETER TtsRequirement
  Override do fallback TTS (ex.: 'edge-tts==7.2.7'). Ignorado se o
  runtime/requirements.txt do plugin existir.

.PARAMETER TimeoutSeconds
  Timeout por comando externo (pip/modelo). Default: 1800.

.EXAMPLE
  pwsh -File scripts/setup-runtime.ps1
  pwsh -File scripts/setup-runtime.ps1 -Model small
  pwsh -File scripts/setup-runtime.ps1 -SkipModel -Target tts
  pwsh -File scripts/setup-runtime.ps1 -Check

.NOTES
  - Usa sempre `pip --disable-pip-version-check` e `python -m venv`.
  - Nunca registra dados sensíveis; logs de pip/modelo vão para o arquivo.
  - CUDA: se `ctranslate2.get_cuda_device_count() > 0` mas o load float16
    falhar (cuDNN), isso é reportado como aviso com fallback CPU esperado.
#>
[CmdletBinding()]
param(
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3')]
    [string]$Model = 'small',
    [switch]$SkipModel,
    [ValidateSet('both', 'stt', 'tts')]
    [string]$Target = 'both',
    [string]$PythonPath,
    [string]$VoiceHome,
    [switch]$Check,
    [switch]$Force,
    [string]$SttRequirement = 'faster-whisper==1.2.1',
    [string]$TtsRequirement = 'edge-tts==7.3.1',
    [int]$TimeoutSeconds = 1800,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$script:Failures = 0
$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:LogFile = $null
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
# Descoberta portátil do CLI dsh / runtime Python do app (sem letra de unidade).
$dshResolveLib = Join-Path $PSScriptRoot 'lib\dsh-resolve.ps1'
if (Test-Path -LiteralPath $dshResolveLib) { . $dshResolveLib }

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'ERRO', 'PIP')]
        [string]$Level = 'INFO',
        [switch]$NoHost
    )
    $prefix = switch ($Level) {
        'OK' { '[ok]  ' }
        'WARN' { '[!]   ' }
        'ERRO' { '[x]   ' }
        'PIP' { '[pip] ' }
        default { '      ' }
    }
    $line = '{0} {1}' -f $prefix, $Message
    if ($script:LogFile) {
        try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8 } catch { }
    }
    if (-not $Quiet -or $Level -in @('OK', 'WARN', 'ERRO')) {
        switch ($Level) {
            'OK' { Write-Host $line -ForegroundColor Green }
            'WARN' { Write-Host $line -ForegroundColor Yellow }
            'ERRO' { Write-Host $line -ForegroundColor Red }
            default { Write-Host $line }
        }
    }
}

function Add-Step {
    param(
        [ValidateSet('stt', 'tts', 'geral')]
        [string]$Area,
        [string]$Name,
        [ValidateSet('ok', 'fail', 'warn', 'skip')]
        [string]$Status,
        [string]$Detail,
        [switch]$Critical
    )
    $script:Steps.Add([pscustomobject]@{
            Area     = $Area
            Name     = $Name
            Status   = $Status
            Detail   = $Detail
            Critical = [bool]$Critical
        })
    if ($Status -eq 'fail' -and $Critical) { $script:Failures += 1 }
}

function Quote-Arg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -match '[\s"]') {
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

function Invoke-Native {
    <# Roda um executável, captura stdout/stderr em arquivos (sem deadlock),
       aplica timeout e devolve exit code + saída. #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 600,
        [string]$Label = '',
        [switch]$EchoTail
    )
    $label = if ($Label) { $Label } else { [System.IO.Path]::GetFileName($Exe) }
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $argString = ($Arguments | ForEach-Object { Quote-Arg $_ }) -join ' '
    Write-Log "exec: $label :: $Exe $argString" -NoHost
    try {
        $proc = $null
        try {
            $proc = Start-Process -FilePath $Exe -ArgumentList $argString -NoNewWindow -PassThru `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        }
        catch {
            return [pscustomobject]@{
                ExitCode = 127; TimedOut = $false; Stdout = ''; Stderr = $_.Exception.Message; Label = $label
            }
        }
        $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
        $timedOut = -not $exited
        if ($timedOut) {
            Write-Log "timeout ($TimeoutSeconds s) ao executar $label; encerrando PID $($proc.Id)" 'WARN'
            try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
        }
        $exitCode = if ($timedOut) { -1 } else { [int]$proc.ExitCode }
        $stdout = ''
        $stderr = ''
        try { $stdout = [System.IO.File]::ReadAllText($outFile) } catch { }
        try { $stderr = [System.IO.File]::ReadAllText($errFile) } catch { }
        if ($script:LogFile) {
            if ($stdout.Trim()) { Append-LogBlock -Text $stdout -Label "$label stdout" }
            if ($stderr.Trim()) { Append-LogBlock -Text $stderr -Label "$label stderr" }
        }
        if ($EchoTail -and -not $Quiet) {
            $tailSource = ($stdout + "`n" + $stderr).Trim()
            if ($tailSource) {
                $tail = if ($tailSource.Length -gt 600) { $tailSource.Substring($tailSource.Length - 600) } else { $tailSource }
                Write-Host ($tail -replace "(?m)^", '    | ')
            }
        }
        return [pscustomobject]@{
            ExitCode = $exitCode
            TimedOut = $timedOut
            Stdout   = $stdout
            Stderr   = $stderr
            Label    = $label
        }
    }
    finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Append-LogBlock {
    param([string]$Text, [string]$Label)
    if (-not $script:LogFile) { return }
    $max = 20000
    $body = if ($Text.Length -gt $max) { $Text.Substring($Text.Length - $max) } else { $Text }
    try {
        Add-Content -LiteralPath $script:LogFile -Value "----- $Label -----" -Encoding utf8
        Add-Content -LiteralPath $script:LogFile -Value $body -Encoding utf8
    }
    catch { }
}

function Ensure-Directory {
    param([string]$Path, [string]$Label)
    if (Test-Path -LiteralPath $Path) { return $true }
    try {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
        Write-Log "diretório criado: $Path" -NoHost
        return $true
    }
    catch {
        Write-Log "não consegui criar $Label em ${Path}: $($_.Exception.Message)" 'ERRO'
        return $false
    }
}

function Get-PythonVersion {
    <# Executa <exe> <prefixArgs> -c "print(sys.version...)" e devolve versão semântica. #>
    param([string]$Exe, [string[]]$PrefixArgs = @(), [int]$TimeoutSeconds = 30)
    $probeScript = 'import sys;print("%d.%d.%d" % sys.version_info[:3])'
    $result = Invoke-Native -Exe $Exe -Arguments (@($PrefixArgs) + @('-c', $probeScript)) -TimeoutSeconds $TimeoutSeconds -Label 'python-version'
    if ($result.ExitCode -ne 0) { return $null }
    $text = ($result.Stdout.Trim() -split "`r?`n")[-1].Trim()
    if ($text -match '^(\d+)\.(\d+)\.(\d+)$') {
        return [pscustomobject]@{
            Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3]
            Text  = $text
            Ok    = ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 10)
            WarnNew = ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 14)
        }
    }
    return $null
}

function Get-PythonCandidates {
    <# Lista candidatos de Python base, em ordem de preferência (portátil). #>
    $candidates = [System.Collections.Generic.List[object]]::new()

    if ($PythonPath) {
        $candidates.Add([pscustomobject]@{ Exe = $PythonPath; Args = @(); Label = 'parâmetro -PythonPath' })
        return $candidates
    }

    # 0) override explícito por ambiente (CI/devs): DSH_VOICE_PYTHON / DSH_STT_PYTHON / DSH_PYTHON
    foreach ($envName in @('DSH_VOICE_PYTHON', 'DSH_STT_PYTHON', 'DSH_PYTHON')) {
        $value = [Environment]::GetEnvironmentVariable($envName)
        if ($value -and $value.Trim() -and (Test-Path -LiteralPath $value)) {
            $candidates.Add([pscustomobject]@{ Exe = $value; Args = @(); Label = "`$env:$envName" })
        }
    }

    # 1) Python do runtime do app DSH (detectado dinamicamente; 3.12 é o pinado
    #    pelo CONTRACT §4). Inclui o runtime gerenciado em ~/.dsh/dsh-runtimes.
    if (Get-Command Get-DshRuntimePythonCandidates -ErrorAction SilentlyContinue) {
        $dshCliPath = $null
        if (Get-Command Resolve-DshCliPath -ErrorAction SilentlyContinue) {
            $dshCliPath = Resolve-DshCliPath
        }
        foreach ($candidate in (Get-DshRuntimePythonCandidates -DshCliPath $dshCliPath)) {
            $candidates.Add([pscustomobject]@{ Exe = $candidate; Args = @(); Label = 'runtime DSH' })
        }
    }

    # 2) Launcher py com versões específicas (3.12, 3.11, 3.10)
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        foreach ($ver in @('-3.12', '-3.11', '-3.10')) {
            $probe = Invoke-Native -Exe $pyLauncher.Source -Arguments @($ver, '-c', 'import sys;print(sys.version_info[:2])') -TimeoutSeconds 20 -Label "py $ver"
            if ($probe.ExitCode -eq 0) {
                $candidates.Add([pscustomobject]@{ Exe = $pyLauncher.Source; Args = @($ver); Label = "py $ver" })
            }
        }
    }

    # 3) python/python3 do PATH (o seletor valida 3.10–3.12)
    foreach ($name in @('python', 'python3')) {
        foreach ($cmd in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
            if ($cmd.Source) {
                $candidates.Add([pscustomobject]@{ Exe = $cmd.Source; Args = @(); Label = $name })
            }
        }
    }
    # dedup por exe+args
    $seen = @{}
    $unique = @()
    foreach ($candidate in $candidates) {
        $key = "$($candidate.Exe)|$($candidate.Args -join ' ')"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $unique += $candidate
    }
    return $unique
}

function Resolve-BasePython {
    <# Escolhe o melhor Python base: exige 3.10–3.12 (portátil, com override por env). #>
    $candidates = Get-PythonCandidates
    $evaluated = @()
    $rejected = @()
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Exe)) { continue }
        $version = Get-PythonVersion -Exe $candidate.Exe -PrefixArgs $candidate.Args
        if (-not $version) { continue }
        if ($version.Major -ne 3 -or $version.Minor -lt 10 -or $version.Minor -gt 12) {
            $rejected += "$($candidate.Label) -> $($version.Text)"
            continue
        }
        $score = switch ($version.Minor) { 12 { 100 } 11 { 90 } 10 { 80 } }
        if ($candidate.Label -like '$env:*' -or $candidate.Label -like 'parâmetro*') { $score += 20 }
        if ($candidate.Label -like 'runtime DSH*') { $score += 5 }
        if ($candidate.Label -like 'py *') { $score += 3 }
        $evaluated += [pscustomobject]@{ Candidate = $candidate; Version = $version; Score = $score }
    }
    if ($rejected.Count -gt 0) {
        Write-Log "ignorando Python fora de 3.10–3.12: $($rejected -join '; '). O runtime exige wheels de ctranslate2/faster-whisper (3.10–3.12)." 'WARN'
    }
    $evaluated = @($evaluated | Sort-Object Score -Descending)
    if ($evaluated.Count -eq 0) {
        return $null
    }
    $chosen = $evaluated[0]
    Write-Log "Python base: $($chosen.Candidate.Exe) $($chosen.Candidate.Args -join ' ') (versão $($chosen.Version.Text), fonte: $($chosen.Candidate.Label))"
    return $chosen.Candidate
}

function Get-VenvPython {
    param([string]$VenvDir)
    return (Join-Path $VenvDir 'Scripts\python.exe')
}

function Test-VenvHealthy {
    param([string]$VenvDir)
    $venvPython = Get-VenvPython -VenvDir $VenvDir
    if (-not (Test-Path -LiteralPath $venvPython)) {
        return [pscustomobject]@{ Ok = $false; Reason = 'Scripts\python.exe ausente'; Version = $null }
    }
    $version = Get-PythonVersion -Exe $venvPython
    if (-not $version) {
        return [pscustomobject]@{ Ok = $false; Reason = 'não executa'; Version = $null }
    }
    if ($version.Major -ne 3 -or $version.Minor -lt 10) {
        return [pscustomobject]@{ Ok = $false; Reason = "versão $($version.Text) < 3.10"; Version = $version }
    }
    return [pscustomobject]@{ Ok = $true; Reason = $version.Text; Version = $version }
}

function Ensure-Venv {
    <# Cria/valida o venv. Devolve o caminho do python do venv ou $null. #>
    param(
        [ValidateSet('stt', 'tts')][string]$Area,
        [string]$VenvDir,
        [object]$BasePython
    )
    $venvPython = Get-VenvPython -VenvDir $VenvDir
    $health = Test-VenvHealthy -VenvDir $VenvDir
    if ($health.Ok -and -not $Force) {
        Add-Step -Area $Area -Name 'venv' -Status 'ok' -Detail "existente: $venvPython (Python $($health.Reason))"
        Write-Log "$Area venv ok: Python $($health.Reason)" 'OK'
        return $venvPython
    }
    if ($Force -and (Test-Path -LiteralPath $VenvDir)) {
        $backup = "$VenvDir.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Log "-Force: preservando venv atual como $backup e recriando" 'WARN'
        try { Move-Item -LiteralPath $VenvDir -Destination $backup -Force }
        catch {
            Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail "não consegui mover venv atual: $($_.Exception.Message)" -Critical
            return $null
        }
    }
    elseif (-not $health.Ok -and (Test-Path -LiteralPath $VenvDir)) {
        $backup = "$VenvDir.broken-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Log "venv $Area inválido ($($health.Reason)); preservando como $backup e recriando" 'WARN'
        try { Move-Item -LiteralPath $VenvDir -Destination $backup -Force }
        catch {
            Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail "não consegui mover venv inválido: $($_.Exception.Message)" -Critical
            return $null
        }
    }
    if (-not $BasePython) {
        Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail 'nenhum Python 3.10–3.12 encontrado; instale Python 3.12, defina DSH_VOICE_PYTHON ou use -PythonPath' -Critical
        return $null
    }
    Ensure-Directory -Path (Split-Path -Parent $VenvDir) -Label "$Area home" | Out-Null
    Write-Log "criando venv $Area em $VenvDir com $($BasePython.Exe) $($BasePython.Args -join ' ')"
    $result = Invoke-Native -Exe $BasePython.Exe `
        -Arguments (@($BasePython.Args) + @('-m', 'venv', $VenvDir)) `
        -TimeoutSeconds 300 -Label "$Area venv create" -EchoTail
    if ($result.ExitCode -ne 0) {
        if ($result.Stdout) { Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail "python -m venv falhou (exit $($result.ExitCode)); veja log $script:LogFile" -Critical }
        else { Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail "python -m venv falhou (exit $($result.ExitCode))" -Critical }
        return $null
    }
    $health = Test-VenvHealthy -VenvDir $VenvDir
    if (-not $health.Ok) {
        Add-Step -Area $Area -Name 'venv' -Status 'fail' -Detail "venv recém-criado inválido: $($health.Reason)" -Critical
        return $null
    }
    Add-Step -Area $Area -Name 'venv' -Status 'ok' -Detail "criado: $venvPython (Python $($health.Reason))"
    Write-Log "venv $Area criado (Python $($health.Reason))" 'OK'
    return $venvPython
}

function Ensure-Pip {
    param([ValidateSet('stt', 'tts')][string]$Area, [string]$VenvPython)
    $probe = Invoke-Native -Exe $VenvPython -Arguments @('-m', 'pip', '--version') -TimeoutSeconds 60 -Label "$Area pip check"
    if ($probe.ExitCode -eq 0) {
        $pipLine = ($probe.Stdout.Trim() -split "`r?`n")[0]
        Add-Step -Area $Area -Name 'pip' -Status 'ok' -Detail $pipLine
        return $true
    }
    Write-Log "pip ausente em $Area; rodando ensurepip" 'WARN'
    $ensure = Invoke-Native -Exe $VenvPython -Arguments @('-m', 'ensurepip', '--upgrade') -TimeoutSeconds 180 -Label "$Area ensurepip"
    if ($ensure.ExitCode -ne 0) {
        Add-Step -Area $Area -Name 'pip' -Status 'fail' -Detail "ensurepip falhou (exit $($ensure.ExitCode)); recrie o venv com -Force" -Critical
        return $false
    }
    $probe = Invoke-Native -Exe $VenvPython -Arguments @('-m', 'pip', '--version') -TimeoutSeconds 60 -Label "$Area pip check"
    if ($probe.ExitCode -ne 0) {
        Add-Step -Area $Area -Name 'pip' -Status 'fail' -Detail 'pip continua indisponível após ensurepip' -Critical
        return $false
    }
    Add-Step -Area $Area -Name 'pip' -Status 'ok' -Detail 'instalado via ensurepip'
    return $true
}

function Get-RequirementsPath {
    <# Devolve o arquivo de requirements a usar: do plugin se existir, senão fallback gerado. #>
    param(
        [ValidateSet('stt', 'tts')][string]$Area,
        [string]$PluginName,
        [string]$FallbackRequirement,
        [string]$RuntimeDir,
        [switch]$NoWrite
    )
    $pluginReq = Join-Path $script:RepoRoot "packages\$PluginName\runtime\requirements.txt"
    if (Test-Path -LiteralPath $pluginReq) {
        Write-Log "${Area}: usando requirements do plugin: $pluginReq"
        return [pscustomobject]@{ Path = $pluginReq; Source = 'plugin'; Content = (Get-Content -LiteralPath $pluginReq -Raw) }
    }
    $fallbackPath = Join-Path $RuntimeDir 'requirements.fallback.txt'
    $content = @(
        "# Fallback gerado por scripts/setup-runtime.ps1 ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')).",
        "# O plugin ainda não forneceu packages/$PluginName/runtime/requirements.txt.",
        "# Pin conforme o runtime/requirements.txt do plugin; para trocar, edite o requirements ou use o parâmetro do script.",
        $FallbackRequirement,
        ''
    ) -join "`n"
    if (-not $NoWrite) {
        Set-Content -LiteralPath $fallbackPath -Value $content -Encoding utf8
    }
    Write-Log "${Area}: requirements do plugin ausente; usando fallback: $FallbackRequirement" 'WARN'
    return [pscustomobject]@{ Path = $fallbackPath; Source = $(if ($NoWrite) { 'fallback (virtual)' } else { 'fallback' }); Content = $content }
}

function Install-Requirements {
    param(
        [ValidateSet('stt', 'tts')][string]$Area,
        [string]$VenvPython,
        [string]$RequirementsPath,
        [string]$SourceFile,
        [switch]$Critical
    )
    $args = @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
        '--timeout', '120', '--retries', '3', '-r', $RequirementsPath)
    if ($Force) { $args += '--upgrade' }
    Write-Log "${Area}: pip install ($SourceFile) — pode levar alguns minutos..."
    $result = Invoke-Native -Exe $VenvPython -Arguments $args -TimeoutSeconds $TimeoutSeconds -Label "$Area pip install"
    $detail = if ($result.TimedOut) { "timeout de $TimeoutSeconds s" } else { "exit $($result.ExitCode)" }
    if ($result.ExitCode -eq 0) {
        Add-Step -Area $Area -Name 'deps' -Status 'ok' -Detail "instalado de $SourceFile"
        Write-Log "${Area}: dependências instaladas ($SourceFile)" 'OK'
        return $true
    }
    $hint = 'ver log; tente novamente com -Force'
    if ($result.Stderr -match 'No matching distribution|Could not find a version') {
        $hint = 'versão pinada indisponível no PyPI; ajuste o requirements do plugin ou passe -SttRequirement/-TtsRequirement'
    }
    elseif ($result.Stderr -match 'network|timed out|Connection') {
        $hint = 'falha de rede no PyPI; verifique conexão/proxy e repita'
    }
    Add-Step -Area $Area -Name 'deps' -Status 'fail' -Detail "$detail ($hint)" -Critical:$Critical
    Write-Log "${Area}: pip install falhou ($detail): $hint" 'ERRO'
    return $false
}

function Write-ModelScripts {
    param([string]$SttDir)
    $downloadScript = @'
"""Pré-baixa (e carrega para validar) um modelo faster-whisper. Uso:
   python download-model.py <modelo> <download_root>
Imprime uma última linha JSON: {"ok":true,...} ou {"ok":false,"error":"..."}.
Gerado por scripts/setup-runtime.ps1 (qa-dev)."""
import json
import sys
import time


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "uso: download-model.py <modelo> <dir>"}))
        return 2
    model_name, download_root = sys.argv[1], sys.argv[2]
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - ambiente sem deps
        print(json.dumps({"ok": False, "error": f"import faster_whisper falhou: {exc}"}))
        return 1
    started = time.time()
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8",
                             download_root=download_root)
        load_seconds = round(time.time() - started, 2)
        # getattr defensivo: a API pode variar entre versões
        compute_type = getattr(model, "compute_type", "int8")
        device = getattr(model, "device", "cpu")
        print(json.dumps({
            "ok": True,
            "model": model_name,
            "downloadRoot": download_root,
            "computeType": str(compute_type),
            "device": str(device),
            "loadSeconds": load_seconds,
        }))
        del model
        return 0
    except Exception as exc:  # noqa: BLE001 - queremos a mensagem para o log
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
'@
    Set-Content -LiteralPath (Join-Path $SttDir 'download-model.py') -Value $downloadScript -Encoding utf8

    $probeScript = @'
"""Diagnostico de CUDA para ctranslate2. Uso: python probe-cuda.py [modelo] [download_root]
Sem argumentos: so conta dispositivos CUDA. Com modelo: tenta device=cuda/float16.
Ultima linha: JSON."""
import json
import sys


def main() -> int:
    out = {"ctranslate2Version": None, "cudaDevices": None,
           "cudaLoadOk": None, "cudaLoadError": None}
    try:
        import ctranslate2
        out["ctranslate2Version"] = getattr(ctranslate2, "__version__", "desconhecida")
        out["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        print(json.dumps(out))
        return 0
    if len(sys.argv) >= 3 and out["cudaDevices"] > 0:
        try:
            from faster_whisper import WhisperModel
            WhisperModel(sys.argv[1], device="cuda", compute_type="float16",
                         download_root=sys.argv[2])
            out["cudaLoadOk"] = True
        except Exception as exc:  # noqa: BLE001
            out["cudaLoadOk"] = False
            out["cudaLoadError"] = f"{type(exc).__name__}: {exc}"
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
'@
    Set-Content -LiteralPath (Join-Path $SttDir 'probe-cuda.py') -Value $probeScript -Encoding utf8
}

function Get-ModelDirectoryInfo {
    param([string]$ModelsDir, [string]$ModelName)
    if (-not (Test-Path -LiteralPath $ModelsDir)) {
        return [pscustomobject]@{ Found = $false; Bytes = 0; Path = $ModelsDir }
    }
    $modelBins = @(Get-ChildItem -LiteralPath $ModelsDir -Recurse -Filter 'model.bin' -ErrorAction SilentlyContinue)
    if ($modelBins.Count -eq 0) {
        return [pscustomobject]@{ Found = $false; Bytes = 0; Path = $ModelsDir }
    }
    $bytes = ($modelBins | Measure-Object -Property Length -Sum).Sum
    return [pscustomobject]@{ Found = $true; Bytes = [int64]$bytes; Path = (Split-Path -Parent $modelBins[0].FullName) }
}

function Format-Bytes {
    param([int64]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f ($Bytes / 1KB))
}

function Get-CudaInfo {
    param([string]$VenvPython, [string]$SttDir, [string]$ModelName, [string]$ModelsDir, [switch]$ModelAvailable)
    $gpu = [pscustomobject]@{ Name = $null; Driver = $null; CudaDevices = $null; LoadOk = $null; LoadError = $null; Ctranslate2 = $null }
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
        $smiResult = Invoke-Native -Exe $smi.Source -Arguments @('--query-gpu=name,driver_version', '--format=csv,noheader') -TimeoutSeconds 30 -Label 'nvidia-smi'
        if ($smiResult.ExitCode -eq 0 -and $smiResult.Stdout.Trim()) {
            $first = ($smiResult.Stdout.Trim() -split "`r?`n")[0]
            $parts = $first -split ','
            $gpu.Name = $parts[0].Trim()
            if ($parts.Count -gt 1) { $gpu.Driver = $parts[1].Trim() }
        }
        else {
            Write-Log "nvidia-smi não respondeu (exit $($smiResult.ExitCode))" 'WARN'
        }
    }
    else {
        Write-Log 'nvidia-smi não encontrado no PATH' -NoHost
    }

    $probeScript = if ($SttDir) { Join-Path $SttDir 'probe-cuda.py' } else { $null }
    if ($probeScript -and -not (Test-Path -LiteralPath $probeScript)) {
        $probeScript = $null
    }
    if ($VenvPython -and (Test-Path -LiteralPath $VenvPython) -and -not $probeScript) {
        # -Check em runtime já preparado: os scripts auxiliares só existem após
        # um setup completo; consulta inline apenas a contagem de dispositivos.
        $inline = 'import json,ctranslate2 as c;print(json.dumps({''version'':getattr(c,''__version__'',''?''),''cudaDevices'':int(c.get_cuda_device_count())}))'
        $inlineResult = Invoke-Native -Exe $VenvPython -Arguments @('-c', $inline) -TimeoutSeconds 120 -Label 'probe-cuda-inline'
        if ($inlineResult.ExitCode -eq 0) {
            try {
                $parsed = (($inlineResult.Stdout.Trim() -split "`r?`n")[-1]) | ConvertFrom-Json
                $gpu.CudaDevices = $parsed.cudaDevices
                $gpu.Ctranslate2 = $parsed.version
            }
            catch { Write-Log 'não consegui parsear a consulta inline de CUDA' 'WARN' }
        }
        else {
            Write-Log "consulta inline de CUDA falhou (exit $($inlineResult.ExitCode)); veja o log" 'WARN'
        }
        return $gpu
    }
    if ($VenvPython -and (Test-Path -LiteralPath $VenvPython) -and $probeScript) {
        $args = @($probeScript)
        if ($ModelAvailable -and -not $SkipModel) { $args += @($ModelName, $ModelsDir) }
        $result = Invoke-Native -Exe $VenvPython -Arguments $args -TimeoutSeconds 300 -Label 'probe-cuda'
        if ($result.ExitCode -eq 0) {
            $jsonLine = ($result.Stdout.Trim() -split "`r?`n")[-1]
            try {
                $parsed = $jsonLine | ConvertFrom-Json
                $gpu.CudaDevices = $parsed.cudaDevices
                $gpu.Ctranslate2 = $parsed.ctranslate2Version
                $gpu.LoadOk = $parsed.cudaLoadOk
                $gpu.LoadError = $parsed.cudaLoadError
            }
            catch {
                Write-Log "não consegui parsear saída do probe CUDA: $jsonLine" 'WARN'
            }
        }
        else {
            Write-Log "probe CUDA falhou (exit $($result.ExitCode))" 'WARN'
        }
    }
    return $gpu
}

function Invoke-WhisperModelSetup {
    param([string]$VenvPython, [string]$SttDir, [string]$ModelsDir)
    if ($SkipModel) {
        Add-Step -Area 'stt' -Name "modelo $Model" -Status 'skip' -Detail '-SkipModel: download/carga ignorados'
        Write-Log 'modelo Whisper: pulado (-SkipModel)' 'WARN'
        return
    }
    $modelInfo = Get-ModelDirectoryInfo -ModelsDir $ModelsDir -ModelName $Model
    if ($modelInfo.Found -and -not $Force) {
        Add-Step -Area 'stt' -Name "modelo $Model" -Status 'ok' -Detail "já presente ($(Format-Bytes $modelInfo.Bytes)) em $($modelInfo.Path)"
        Write-Log "modelo Whisper '$Model' já presente ($(Format-Bytes $modelInfo.Bytes))" 'OK'
        return
    }
    $downloadScript = Join-Path $SttDir 'download-model.py'
    Ensure-Directory -Path $ModelsDir -Label 'STT models' | Out-Null
    Write-Log "pré-baixando modelo Whisper '$Model' (CPU int8) em $ModelsDir — pode demorar (rede)"
    $result = Invoke-Native -Exe $VenvPython -Arguments @($downloadScript, $Model, $ModelsDir) -TimeoutSeconds $TimeoutSeconds -Label "download modelo $Model"
    $jsonLine = if ($result.Stdout.Trim()) { ($result.Stdout.Trim() -split "`r?`n")[-1] } else { '' }
    if ($result.ExitCode -eq 0) {
        try {
            $parsed = $jsonLine | ConvertFrom-Json
            if ($parsed.ok) {
                Add-Step -Area 'stt' -Name "modelo $Model" -Status 'ok' -Detail "baixado/carregado em $($parsed.loadSeconds)s (CPU int8) em $ModelsDir"
                Write-Log "modelo Whisper '$Model' pronto ($($parsed.loadSeconds)s de carga, CPU int8)" 'OK'
            }
            else {
                Add-Step -Area 'stt' -Name "modelo $Model" -Status 'warn' -Detail "download reportou falha: $($parsed.error)"
                Write-Log "download do modelo falhou: $($parsed.error)" 'WARN'
            }
        }
        catch {
            Add-Step -Area 'stt' -Name "modelo $Model" -Status 'warn' -Detail "saída inesperada do download; veja o log"
        }
    }
    else {
        $detail = if ($result.TimedOut) { "timeout de $TimeoutSeconds s" } else { "exit $($result.ExitCode) — veja $script:LogFile" }
        Add-Step -Area 'stt' -Name "modelo $Model" -Status 'warn' -Detail "não baixado ($detail); pode baixar depois pelo prepare do plugin"
        Write-Log "modelo Whisper não baixado ($detail). O endpoint prepare do plugin também pode baixar." 'WARN'
    }
}

function Test-SapiVoices {
    try {
        Add-Type -AssemblyName System.Speech -ErrorAction Stop
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                    [pscustomobject]@{ Name = $_.VoiceInfo.Name; Culture = $_.VoiceInfo.Culture.Name }
                })
        }
        finally { $synth.Dispose() }
    }
    catch {
        Add-Step -Area 'tts' -Name 'vozes SAPI' -Status 'warn' -Detail "System.Speech indisponível: $($_.Exception.Message)"
        return
    }
    $pt = @($voices | Where-Object { $_.Culture -like 'pt-BR*' })
    $en = @($voices | Where-Object { $_.Culture -like 'en-US*' })
    $detail = "pt-BR: $(if ($pt.Count) { ($pt.Name -join ', ') } else { 'nenhuma' }); en-US: $(if ($en.Count) { ($en.Name -join ', ') } else { 'nenhuma' })"
    if ($pt.Count -gt 0 -and $en.Count -gt 0) {
        Add-Step -Area 'tts' -Name 'vozes SAPI' -Status 'ok' -Detail $detail
    }
    else {
        Add-Step -Area 'tts' -Name 'vozes SAPI' -Status 'warn' -Detail "faltando voz pt-BR ou en-US ($detail); fallback SAPI pode degradar"
    }
}

function Invoke-CheckMode {
    param([string]$SttPython, [string]$TtsPython, [string]$SttDir, [string]$TtsDir, [string]$ModelsDir)
    Write-Log 'modo -Check: apenas diagnóstico (nada será criado/alterado)' 'WARN'
    $ready = $true
    foreach ($area in @('stt', 'tts')) {
        if ($Target -ne 'both' -and $Target -ne $area) { continue }
        $venvDir = if ($area -eq 'stt') { Join-Path $SttDir 'venv' } else { Join-Path $TtsDir 'venv' }
        $venvPython = Get-VenvPython -VenvDir $venvDir
        $health = Test-VenvHealthy -VenvDir $venvDir
        if ($health.Ok) {
            Add-Step -Area $area -Name 'venv' -Status 'ok' -Detail "Python $($health.Reason) ($venvPython)"
        }
        else {
            Add-Step -Area $area -Name 'venv' -Status 'fail' -Detail $health.Reason
            $ready = $false
            continue
        }
        if ($area -eq 'stt') {
            $dep = Invoke-Native -Exe $venvPython -Arguments @('-c', 'import faster_whisper,json;print(json.dumps({"ok":True}))') -TimeoutSeconds 120 -Label 'check faster-whisper'
            if ($dep.ExitCode -eq 0) { Add-Step -Area 'stt' -Name 'faster-whisper' -Status 'ok' -Detail 'import ok' }
            else { Add-Step -Area 'stt' -Name 'faster-whisper' -Status 'fail' -Detail 'import falhou (rode sem -Check)'; $ready = $false }
            $modelInfo = Get-ModelDirectoryInfo -ModelsDir $ModelsDir -ModelName $Model
            if ($SkipModel) { Add-Step -Area 'stt' -Name "modelo $Model" -Status 'skip' -Detail '-SkipModel' }
            elseif ($modelInfo.Found) { Add-Step -Area 'stt' -Name "modelo $Model" -Status 'ok' -Detail "$(Format-Bytes $modelInfo.Bytes)" }
            else { Add-Step -Area 'stt' -Name "modelo $Model" -Status 'warn' -Detail 'não baixado (prepare do plugin pode baixar)' }
        }
        else {
            $dep = Invoke-Native -Exe $venvPython -Arguments @('-c', 'from importlib.metadata import version;print(version("edge-tts"))') -TimeoutSeconds 120 -Label 'check edge-tts'
            if ($dep.ExitCode -eq 0) { Add-Step -Area 'tts' -Name 'edge-tts' -Status 'ok' -Detail "versão $(($dep.Stdout.Trim() -split "`r?`n")[0])" }
            else { Add-Step -Area 'tts' -Name 'edge-tts' -Status 'fail' -Detail 'import falhou (rode sem -Check)'; $ready = $false }
            Test-SapiVoices
        }
    }
    if ($Target -ne 'tts' -and $ready) {
        $cuda = Get-CudaInfo -VenvPython $SttPython -SttDir $SttDir -ModelName $Model -ModelsDir $ModelsDir -ModelAvailable:(-not $SkipModel)
        Write-CudaSteps -Cuda $cuda
    }
    return $ready
}

function Write-CudaSteps {
    param([object]$Cuda)
    $gpuText = if ($Cuda.Name) { "$($Cuda.Name)$(if ($Cuda.Driver) { " (driver $($Cuda.Driver))" })" } else { 'nenhuma GPU NVIDIA detectada' }
    if ($null -eq $Cuda.CudaDevices) {
        Add-Step -Area 'stt' -Name 'CUDA' -Status 'warn' -Detail "não foi possível consultar ctranslate2; $gpuText"
        return
    }
    if ($Cuda.CudaDevices -le 0) {
        Add-Step -Area 'stt' -Name 'CUDA' -Status 'warn' -Detail "ctranslate2 sem dispositivos CUDA; $gpuText — worker usará CPU int8"
        return
    }
    if ($Cuda.LoadOk -eq $true) {
        Add-Step -Area 'stt' -Name 'CUDA' -Status 'ok' -Detail "$gpuText; ctranslate2 $($Cuda.Ctranslate2) com $($Cuda.CudaDevices) dispositivo(s); load float16 ok"
        return
    }
    if ($Cuda.LoadOk -eq $false) {
        $reason = if ($Cuda.LoadError) { $Cuda.LoadError } else { 'erro desconhecido' }
        Add-Step -Area 'stt' -Name 'CUDA' -Status 'warn' -Detail "GPU presente mas load float16 falhou ($reason); CPU int8 é o fallback esperado (cuDNN 9 pode estar ausente)"
        return
    }
    Add-Step -Area 'stt' -Name 'CUDA' -Status 'warn' -Detail "$gpuText; ctranslate2 $($Cuda.Ctranslate2) reporta $($Cuda.CudaDevices) dispositivo(s); load não testado"
}

function Write-Summary {
    param([object]$BasePython, [string]$SttPython, [string]$TtsPython)
    Write-Host ''
    Write-Host '================ RESUMO setup-runtime ================' -ForegroundColor Cyan
    $symbols = @{ ok = '✓'; fail = '✗'; warn = '!'; skip = '-' }
    foreach ($area in @('geral', 'stt', 'tts')) {
        $items = @($script:Steps | Where-Object { $_.Area -eq $area })
        if ($items.Count -eq 0) { continue }
        Write-Host ("[{0}]" -f $area.ToUpperInvariant()) -ForegroundColor Cyan
        foreach ($step in $items) {
            $sym = $symbols[$step.Status]
            $color = switch ($step.Status) {
                'ok' { 'Green' } 'fail' { 'Red' } 'warn' { 'Yellow' } default { 'DarkGray' }
            }
            Write-Host ("  {0} {1,-16} {2}" -f $sym, $step.Name, $step.Detail) -ForegroundColor $color
        }
    }
    $counts = @{}
    foreach ($s in @('ok', 'warn', 'fail', 'skip')) {
        $counts[$s] = @($script:Steps | Where-Object { $_.Status -eq $s }).Count
    }
    Write-Host ("  totais: ✓ {0}  ! {1}  ✗ {2}  - {3}" -f $counts['ok'], $counts['warn'], $counts['fail'], $counts['skip'])
    if ($BasePython) { Write-Host "  python base: $($BasePython.Exe) $($BasePython.Args -join ' ')" }
    if ($SttPython) { Write-Host "  stt venv  : $SttPython" }
    if ($TtsPython) { Write-Host "  tts venv  : $TtsPython" }
    Write-Host "  log       : $script:LogFile"
    Write-Host ''
    Write-Host 'Próximos passos:' -ForegroundColor Cyan
    $next = [System.Collections.Generic.List[string]]::new()
    if ($script:Failures -gt 0) {
        $next.Add('Corrija os ✗ acima e repita: pwsh -File scripts/setup-runtime.ps1')
        $next.Add('Se o venv estiver inconsistente: pwsh -File scripts/setup-runtime.ps1 -Force')
    }
    $modelMissing = @($script:Steps | Where-Object { $_.Area -eq 'stt' -and $_.Name -like 'modelo*' -and $_.Status -ne 'ok' -and $_.Status -ne 'skip' })
    if ($modelMissing.Count -gt 0) {
        $next.Add("Baixar o modelo depois: pwsh -File scripts/setup-runtime.ps1 -Model $Model")
        $next.Add('Ou usar o botão "Preparar" nas configurações do plugin (endpoint prepare).')
    }
    if ($script:Failures -eq 0) {
        $next.Add('Sincronizar lib/: node scripts/sync.mjs')
        $next.Add('Instalar os plugins no profile voice-dev: pwsh -File scripts/install.ps1')
        $next.Add('Subir o servidor de dev: pwsh -File scripts/dev-server.ps1')
        $next.Add('Rodar o pipeline de QA: pwsh -File tests/run-all.ps1')
    }
    foreach ($line in $next) { Write-Host "  - $line" }
    Write-Host ''
    if ($script:Failures -gt 0) {
        Write-Host ("setup-runtime: {0} falha(s) crítica(s)." -f $script:Failures) -ForegroundColor Red
    }
    else {
        Write-Host 'setup-runtime: runtime pronto (avisos não impedem o uso; fallback CPU/SAPI cobre GPU/voz).' -ForegroundColor Green
    }
}

# ===================== início =====================
$start = Get-Date
if (-not $VoiceHome) {
    $VoiceHome = if ($env:DSH_VOICE_HOME) { $env:DSH_VOICE_HOME } else { Join-Path $env:USERPROFILE '.dsh\dsh-voice' }
}
$VoiceHome = [System.IO.Path]::GetFullPath($VoiceHome)
$logDir = Join-Path $VoiceHome 'logs'
Ensure-Directory -Path $logDir -Label 'logs' | Out-Null
$env:DSH_VOICE_HOME = $VoiceHome
$script:LogFile = Join-Path $logDir ("setup-runtime-{0}.log" -f $start.ToString('yyyyMMdd-HHmmss'))
try { Set-Content -LiteralPath $script:LogFile -Value "# setup-runtime $(Get-Date -Format o)`n# VoiceHome=$VoiceHome`n# Target=$Target Model=$Model SkipModel=$SkipModel Check=$Check Force=$Force" -Encoding utf8 } catch { }

$sttDir = Join-Path $VoiceHome 'stt'
$modelsDir = Join-Path $sttDir 'models'
$ttsDir = Join-Path $VoiceHome 'tts'
$wantStt = $Target -in @('both', 'stt')
$wantTts = $Target -in @('both', 'tts')

Write-Host ''
Write-Host '=== DSH Voice Suite — setup-runtime.ps1 ===' -ForegroundColor Cyan
Write-Host "VoiceHome : $VoiceHome"
Write-Host "Repo      : $script:RepoRoot"
Write-Host "Target    : $Target | Modelo: $Model | SkipModel: $([bool]$SkipModel)$(if ($Check) { ' | MODO CHECK' })"
Write-Host "Log       : $script:LogFile"
Write-Host ''

if (-not $Check) {
    foreach ($dir in @($sttDir, $modelsDir, (Join-Path $sttDir 'logs'), $ttsDir, (Join-Path $ttsDir 'cache'), (Join-Path $ttsDir 'logs'))) {
        Ensure-Directory -Path $dir -Label 'runtime dir' | Out-Null
    }
}

$basePython = Resolve-BasePython
if (-not $basePython) {
    Add-Step -Area 'geral' -Name 'python' -Status 'fail' -Detail 'nenhum Python 3.10–3.12 encontrado (procurei DSH_VOICE_PYTHON/DSH_STT_PYTHON, py -3.12/-3.11/-3.10, python/python3 e o runtime do app DSH)' -Critical
    Write-Summary -BasePython $null -SttPython $null -TtsPython $null
    exit 1
}
Add-Step -Area 'geral' -Name 'python' -Status 'ok' -Detail "$($basePython.Exe) $($basePython.Args -join ' ')"

$sttPython = $null
$ttsPython = $null

# -Check é diagnóstico puro: não cria venv, não instala, não escreve fallback.
if ($Check) {
    if ($wantStt) {
        $sttPython = Get-VenvPython -VenvDir (Join-Path $sttDir 'venv')
        $req = Get-RequirementsPath -Area 'stt' -PluginName 'dsh-whisper-stt' -FallbackRequirement $SttRequirement -RuntimeDir $sttDir -NoWrite
        Add-Step -Area 'stt' -Name 'requirements' -Status 'ok' -Detail "fonte: $($req.Source) ($($req.Path))"
    }
    if ($wantTts) {
        $ttsPython = Get-VenvPython -VenvDir (Join-Path $ttsDir 'venv')
        $req = Get-RequirementsPath -Area 'tts' -PluginName 'dsh-tts' -FallbackRequirement $TtsRequirement -RuntimeDir $ttsDir -NoWrite
        Add-Step -Area 'tts' -Name 'requirements' -Status 'ok' -Detail "fonte: $($req.Source) ($($req.Path))"
    }
    $ready = Invoke-CheckMode -SttPython $sttPython -TtsPython $ttsPython -SttDir $sttDir -TtsDir $ttsDir -ModelsDir $modelsDir
    Write-Summary -BasePython $basePython -SttPython $(if ($wantStt) { $sttPython } else { $null }) -TtsPython $(if ($wantTts) { $ttsPython } else { $null })
    if ($ready) { exit 0 } else { exit 1 }
}

if ($wantStt) {
    Write-Host ''
    Write-Host '--- STT (faster-whisper) ---' -ForegroundColor Cyan
    $sttPython = Ensure-Venv -Area 'stt' -VenvDir (Join-Path $sttDir 'venv') -BasePython $basePython
    if ($sttPython) {
        if (Ensure-Pip -Area 'stt' -VenvPython $sttPython) {
            $req = Get-RequirementsPath -Area 'stt' -PluginName 'dsh-whisper-stt' -FallbackRequirement $SttRequirement -RuntimeDir $sttDir
            Install-Requirements -Area 'stt' -VenvPython $sttPython -RequirementsPath $req.Path -SourceFile $req.Source -Critical | Out-Null
        }
        Write-ModelScripts -SttDir $sttDir
        Invoke-WhisperModelSetup -VenvPython $sttPython -SttDir $sttDir -ModelsDir $modelsDir
    }
}

if ($wantTts) {
    Write-Host ''
    Write-Host '--- TTS (edge-tts + SAPI) ---' -ForegroundColor Cyan
    $ttsPython = Ensure-Venv -Area 'tts' -VenvDir (Join-Path $ttsDir 'venv') -BasePython $basePython
    if ($ttsPython) {
        if (Ensure-Pip -Area 'tts' -VenvPython $ttsPython) {
            $req = Get-RequirementsPath -Area 'tts' -PluginName 'dsh-tts' -FallbackRequirement $TtsRequirement -RuntimeDir $ttsDir
            Install-Requirements -Area 'tts' -VenvPython $ttsPython -RequirementsPath $req.Path -SourceFile $req.Source -Critical | Out-Null
        }
        $importCheck = Invoke-Native -Exe $ttsPython -Arguments @('-c', 'from importlib.metadata import version;print(version("edge-tts"))') -TimeoutSeconds 120 -Label 'check edge-tts'
        if ($importCheck.ExitCode -eq 0) {
            $ver = ($importCheck.Stdout.Trim() -split "`r?`n")[0]
            Add-Step -Area 'tts' -Name 'edge-tts' -Status 'ok' -Detail "import ok (versão $ver)"
        }
        else {
            Add-Step -Area 'tts' -Name 'edge-tts' -Status 'warn' -Detail 'import falhou; synthesize edge pode cair para SAPI/browser'
        }
        Test-SapiVoices
    }
}

if ($wantStt -and $sttPython) {
    Write-Host ''
    Write-Host '--- CUDA vs CPU ---' -ForegroundColor Cyan
    $modelInfo = Get-ModelDirectoryInfo -ModelsDir $modelsDir -ModelName $Model
    $cuda = Get-CudaInfo -VenvPython $sttPython -SttDir $sttDir -ModelName $Model -ModelsDir $modelsDir -ModelAvailable:$modelInfo.Found
    Write-CudaSteps -Cuda $cuda
}

Write-Summary -BasePython $basePython -SttPython $sttPython -TtsPython $ttsPython
if ($script:Failures -gt 0) { exit 1 }
exit 0





