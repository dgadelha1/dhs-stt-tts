#requires -Version 7.0
<#
.SYNOPSIS
  Sobe/derruba o servidor de desenvolvimento do DSH no profile de integração
  (default: voice-dev, porta 3099) e captura a URL com token.

.DESCRIPTION
  Comando de boot comprovado no DSH 0.2.2-rc.1 (não existe subcomando `web`):

      dsh --profile voice-dev --port 3099 --no-open

  O servidor imprime `dsh web: http://127.0.0.1:3099/?token=...` no stdout; sem
  esse token a página responde 401. Este script:

    - inicia o servidor em background (sem janela), com stdout/stderr em
      tests/artifacts/dev-server.{out,err}.log;
    - espera o health (GET na URL com token até 200) por até -TimeoutSeconds;
    - grava o estado em tests/artifacts/dev-server.json;
    - imprime a URL pronta para abrir e como parar.

  -Stop encerra SOMENTE o processo que escuta a porta configurada, e apenas se
  a linha de comando provar que é o servidor deste profile/porta. Nunca toca no
  app Desktop (porta 52301) nem em servidores de outros profiles (3097/3098).

  -Restart = -Stop + subir de novo.

.PARAMETER Profile
  Profile DSH. Default: voice-dev (nunca use 'desktop').

.PARAMETER Port
  Porta HTTP. Default: 3099.

.PARAMETER Stop
  Derruba o servidor de dev desta porta/profile.

.PARAMETER Restart
  Derruba e sobe de novo.

.PARAMETER TimeoutSeconds
  Tempo máximo de espera do health. Default: 90.

.PARAMETER ArtifactsDir
  Onde ficam logs/estado. Default: <repo>/tests/artifacts.

.PARAMETER VoiceHome
  Opcional: define DSH_VOICE_HOME para o servidor filho (útil para testar o
  caminho "runtime ausente" sem tocar no runtime real dos devs).

.PARAMETER DshCli
  Caminho do CLI dsh. Default: descoberta portátil (DSH_CLI -> PATH -> npm
  global -> app Desktop em Program Files/LOCALAPPDATA/DSH_APP_ROOT).

.EXAMPLE
  pwsh -File scripts/dev-server.ps1
  pwsh -File scripts/dev-server.ps1 -Stop
  pwsh -File scripts/dev-server.ps1 -Restart
  pwsh -File scripts/dev-server.ps1 -VoiceHome C:\temp\voice-home-vazio
#>
[CmdletBinding()]
param(
    [string]$Profile = 'voice-dev',
    [int]$Port = 3099,
    [switch]$Stop,
    [switch]$Restart,
    [int]$TimeoutSeconds = 90,
    [string]$ArtifactsDir,
    [string]$VoiceHome,
    [string]$DshCli,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
# Descoberta portátil do CLI dsh (sem letra de unidade fixa).
$dshResolveLib = Join-Path $PSScriptRoot 'lib\dsh-resolve.ps1'
if (Test-Path -LiteralPath $dshResolveLib) { . $dshResolveLib }
if (-not $ArtifactsDir) { $ArtifactsDir = Join-Path $script:RepoRoot 'tests\artifacts' }
$ArtifactsDir = [System.IO.Path]::GetFullPath($ArtifactsDir)
$stateFile = Join-Path $ArtifactsDir 'dev-server.json'
$outLog = Join-Path $ArtifactsDir 'dev-server.out.log'
$errLog = Join-Path $ArtifactsDir 'dev-server.err.log'
$clientLog = Join-Path $ArtifactsDir 'dev-server.client.log'

function Write-Ok { param([string]$m) if (-not $Quiet) { Write-Host "[ok] $m" -ForegroundColor Green } }
function Write-Warn { param([string]$m) if (-not $Quiet) { Write-Host "[!]  $m" -ForegroundColor Yellow } }
function Write-Err { param([string]$m) Write-Host "[x]  $m" -ForegroundColor Red }
function Write-Info { param([string]$m) if (-not $Quiet) { Write-Host "     $m" } }
function Log-Client {
    param([string]$m)
    try { Add-Content -LiteralPath $clientLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 } catch { }
}

function Resolve-DshCli {
    if (-not (Get-Command Resolve-DshCliPath -ErrorAction SilentlyContinue)) { return $null }
    return (Resolve-DshCliPath -Explicit $DshCli)
}

function Get-ListenerPid {
    param([int]$P)
    $conn = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

function Get-ProcessInfo {
    param([int]$ProcessId)
    return (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue)
}

function Test-IsOurServerProcess {
    <# Verifica que o PID é o servidor DSH deste profile/porta e NÃO é o app Desktop. #>
    param([int]$ProcessId, [string]$ProfileName, [int]$PortNumber)
    $info = Get-ProcessInfo -ProcessId $ProcessId
    if (-not $info) { return [pscustomobject]@{ Ok = $false; Reason = "processo $ProcessId nao existe"; Info = $null } }
    $cmdline = [string]$info.CommandLine
    $nameOk = $info.Name -match '(?i)^(DeepSeek Harness(\.exe)?|node(\.exe)?|dsh(\.exe|\.cmd)?)$'
    if (-not $nameOk) {
        return [pscustomobject]@{ Ok = $false; Reason = "processo $ProcessId nao parece o servidor DSH ($($info.Name))"; Info = $info }
    }
    if ($cmdline -notmatch '(?i)dsh|deepseek harness') {
        return [pscustomobject]@{ Ok = $false; Reason = 'cmdline nao referencia dsh/DeepSeek Harness'; Info = $info }
    }
    if ($cmdline -notmatch "--profile\s+$([regex]::Escape($ProfileName))(\s|$)") {
        return [pscustomobject]@{ Ok = $false; Reason = "cmdline sem --profile $ProfileName"; Info = $info }
    }
    if ($cmdline -notmatch "--port\s+$PortNumber(\s|$)") {
        return [pscustomobject]@{ Ok = $false; Reason = "cmdline sem --port $PortNumber"; Info = $info }
    }
    # proteção extra: nunca matar quem escuta 52301 (app Desktop gerenciado)
    $desktopPid = Get-ListenerPid -P 52301
    if ($desktopPid -and $desktopPid -eq $ProcessId) {
        return [pscustomobject]@{ Ok = $false; Reason = 'PID e o servidor Desktop da 52301 (protegido)'; Info = $info }
    }
    return [pscustomobject]@{ Ok = $true; Reason = 'verificado'; Info = $info }
}

function Get-Health {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
        return [pscustomobject]@{ Ok = ($response.StatusCode -eq 200); Status = [int]$response.StatusCode; Length = $response.Content.Length; Error = $null }
    }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        return [pscustomobject]@{ Ok = $false; Status = $status; Length = 0; Error = $_.Exception.Message }
    }
}

function Read-UrlFromLog {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $content = $null
    for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
        try {
            $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
            break
        }
        catch {
            Start-Sleep -Milliseconds 150
        }
    }
    if ([string]::IsNullOrEmpty($content)) { return $null }
    $match = [regex]::Match($content, 'dsh web:\s*(http://\S+)')
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Get-UrlWithoutToken {
    param([string]$Url)
    if (-not $Url) { return $null }
    try {
        $uri = [Uri]$Url
        return ('{0}://{1}:{2}{3}' -f $uri.Scheme, $uri.Host, $uri.Port, $uri.AbsolutePath)
    }
    catch { return $Url }
}

function Stop-DevServer {
    $state = $null
    if (Test-Path -LiteralPath $stateFile) {
        try { $state = Get-Content -LiteralPath $stateFile -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
    }
    $listenerPid = Get-ListenerPid -P $Port
    $launcherPid = if ($state -and $state.launcherPid) { [int]$state.launcherPid } else { $null }
    $stopped = $false

    if ($listenerPid) {
        $verify = Test-IsOurServerProcess -ProcessId $listenerPid -ProfileName $Profile -PortNumber $Port
        if (-not $verify.Ok) {
            Write-Err "recusando encerrar PID $listenerPid na porta $Port`: $($verify.Reason). Nada foi alterado."
            Log-Client "STOP REFUSED pid=$listenerPid reason=$($verify.Reason)"
            return $false
        }
        try {
            Stop-Process -Id $listenerPid -Force -ErrorAction Stop
            Write-Ok "servidor de dev encerrado (PID $listenerPid, porta $Port, profile $Profile)"
            Log-Client "STOP pid=$listenerPid"
            $stopped = $true
        }
        catch {
            Write-Err "falha ao encerrar PID ${listenerPid}: $($_.Exception.Message)"
            return $false
        }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and (Get-ListenerPid -P $Port)) { Start-Sleep -Milliseconds 300 }
        if (Get-ListenerPid -P $Port) {
            Write-Err "porta $Port continua ocupada apos encerrar o PID $listenerPid"
            return $false
        }
    }
    else {
        Write-Info "nao ha processo escutando a porta $Port"
    }

    # encerra o launcher cmd.exe, se ainda estiver vivo e for o nosso
    if ($launcherPid) {
        $launcher = Get-ProcessInfo -ProcessId $launcherPid
        if ($launcher -and $launcher.Name -eq 'cmd.exe' -and [string]$launcher.CommandLine -match 'dsh\.cmd' -and
            [string]$launcher.CommandLine -match "--port\s+$Port(\s|$)") {
            try { Stop-Process -Id $launcherPid -Force -ErrorAction Stop } catch { }
        }
    }
    if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue }
    if ($stopped) { Write-Info "app Desktop (52301) intocado." }
    return $true
}

function Start-DevServer {
    if ($Profile -eq 'desktop') {
        Write-Err "recusado: use um profile de teste (voice-dev), nunca 'desktop'."
        return $false
    }
    $existing = Get-ListenerPid -P $Port
    if ($existing) {
        $state = $null
        if (Test-Path -LiteralPath $stateFile) {
            try { $state = Get-Content -LiteralPath $stateFile -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
        }
        if ($state -and $state.url) {
            $health = Get-Health -Url $state.url
            if ($health.Ok) {
                Write-Ok "servidor de dev ja esta rodando na porta $Port (PID $existing)"
                Write-Info "URL: $($state.url)"
                Write-Info "parar: pwsh -File scripts/dev-server.ps1 -Stop"
                return $true
            }
        }
        Write-Err "porta $Port ja esta ocupada pelo PID $existing, mas nao responde como o dev server deste profile. Use -Stop (somente se for seu) ou libere a porta."
        return $false
    }

    $script:DshCliPath = Resolve-DshCli
    if (-not $script:DshCliPath) {
        Write-Err 'CLI dsh nao encontrado.'
        if (Get-Command Get-DshCliSearchHints -ErrorAction SilentlyContinue) {
            foreach ($hint in (Get-DshCliSearchHints)) { Write-Info "  - $hint" }
        }
        return $false
    }
    $profileDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') $Profile
    if (-not (Test-Path -LiteralPath $profileDir)) {
        Write-Err "profile '$Profile' nao inicializado ($profileDir)."
        return $false
    }

    New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

    # Lança o servidor DETACHADO do shell chamador (sem herdar handles de
    # console/pipe do terminal ou do pipeline). Um wrapper .cmd faz a
    # redireção de stdout/stderr e é criado/sobrescrito a cada start.
    $wrapper = Join-Path $ArtifactsDir 'dev-server-launch.cmd'
    $profileDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') $Profile
    $wrapperLines = [System.Collections.Generic.List[string]]::new()
    $wrapperLines.Add('@echo off')
    $wrapperLines.Add('setlocal')
    if ($VoiceHome) {
        $wrapperLines.Add('set "DSH_VOICE_HOME=' + [System.IO.Path]::GetFullPath($VoiceHome) + '"')
    }
    $wrapperLines.Add('"' + $script:DshCliPath + '" --profile ' + $Profile + ' --port ' + $Port + ' --no-open > "' + $outLog + '" 2> "' + $errLog + '"')
    $wrapperLines.Add('exit /b %errorlevel%')
    Set-Content -LiteralPath $wrapper -Value $wrapperLines -Encoding ascii

    $launcherPid = $null
    $spawnMode = 'wmi-detached'
    try {
        # WMI cria o processo sem herdar os handles do shell chamador (evita
        # pendurar terminais/pipelines que aguardam o servidor terminar).
        $commandLine = 'cmd.exe /d /c "' + $wrapper + '"'
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine      = $commandLine
            CurrentDirectory = $ArtifactsDir
        } -ErrorAction Stop
        if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
            throw "Win32_Process.Create retornou $($created.ReturnValue)"
        }
        $launcherPid = [int]$created.ProcessId
    }
    catch {
        Write-Warn "spawn WMI falhou ($($_.Exception.Message)); usando Start-Process"
        $spawnMode = 'start-process'
        $savedVoiceHome = $env:DSH_VOICE_HOME
        if ($VoiceHome) { $env:DSH_VOICE_HOME = [System.IO.Path]::GetFullPath($VoiceHome) }
        try {
            # o wrapper já redireciona stdout/stderr; não redirecionar aqui de novo
            $launcher = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $wrapper) -WindowStyle Hidden -PassThru
            $launcherPid = $launcher.Id
        }
        finally {
            if ($VoiceHome) {
                if ($null -eq $savedVoiceHome) { Remove-Item Env:DSH_VOICE_HOME -ErrorAction SilentlyContinue }
                else { $env:DSH_VOICE_HOME = $savedVoiceHome }
            }
        }
    }
    Write-Info "launcher PID $launcherPid ($spawnMode); aguardando health na porta $Port (ate ${TimeoutSeconds}s)..."

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $url = $null
    $health = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (-not $url) { $url = Read-UrlFromLog -Path $outLog }
        if ($url) {
            $health = Get-Health -Url $url
            if ($health.Ok) { break }
        }
        if ($launcher.HasExited) {
            Write-Err "o processo de boot terminou antes do health (exit $($launcher.ExitCode)). Veja $errLog"
            break
        }
    }

    if (-not $url) {
        Write-Err "timeout: o servidor nao imprimiu a URL com token em $TimeoutSeconds s. Veja $outLog e $errLog"
        Write-Warn 'Log (ultimas linhas):'
        if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog | Select-Object -Last 10 | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray } }
        if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog | Select-Object -Last 10 | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray } }
        Stop-DevServer | Out-Null
        return $false
    }
    if (-not $health -or -not $health.Ok) {
        Write-Err "o servidor subiu (URL capturada) mas o health nao retornou 200 (ultimo status: $($health.Status); erro: $($health.Error)). Veja $outLog"
        Stop-DevServer | Out-Null
        return $false
    }

    $listenerPid = Get-ListenerPid -P $Port
    $state = [pscustomobject]@{
        profile     = $Profile
        port        = $Port
        url         = $url
        baseUrl     = (Get-UrlWithoutToken -Url $url)
        launcherPid = $launcher.Id
        listenerPid = $listenerPid
        startedAt   = (Get-Date).ToString('o')
        voiceHome   = $env:DSH_VOICE_HOME
        outLog      = $outLog
        errLog      = $errLog
        health      = [pscustomobject]@{ status = $health.Status; contentLength = $health.Length }
    }
    try { Set-Content -LiteralPath $stateFile -Value ($state | ConvertTo-Json -Depth 5) -Encoding utf8 } catch { }

    Write-Ok "servidor de dev no ar (HTTP $($health.Status), $($health.Length) bytes, PID $listenerPid)"
    Write-Host ''
    Write-Host 'URL (abra no navegador; o token autentica a sessao):' -ForegroundColor Cyan
    Write-Host "  $url"
    Write-Host ''
    Write-Host "Parar:  pwsh -File scripts/dev-server.ps1 -Stop" -ForegroundColor Cyan
    Write-Host "Logs:   $outLog" 
    Write-Host "        $errLog"
    Write-Host "Estado: $stateFile"
    Log-Client "UP pid=$listenerPid url=$($state.baseUrl)"
    return $true
}

# ===================== início =====================
if ($Port -eq 52301) {
    Write-Err 'recusado: a porta 52301 e o app Desktop gerenciado; nunca a use/derrube.'
    exit 1
}
if ($Profile -eq 'desktop' -and ($Stop -or $Restart)) {
    Write-Err "recusado: nunca derrube o profile 'desktop'."
    exit 1
}

if ($Restart) {
    Write-Host '--- reiniciando dev server ---' -ForegroundColor Cyan
    Stop-DevServer | Out-Null
    Start-Sleep -Milliseconds 500
    if (Start-DevServer) { exit 0 } else { exit 1 }
}
elseif ($Stop) {
    Write-Host '--- parando dev server ---' -ForegroundColor Cyan
    if (Stop-DevServer) { exit 0 } else { exit 1 }
}
else {
    Write-Host '--- subindo dev server ---' -ForegroundColor Cyan
    if (Start-DevServer) { exit 0 } else { exit 1 }
}

