#requires -Version 7.0
<#
.SYNOPSIS
  Instala (ou remove/verifica) os plugins DSH Voice Suite em um profile do DSH.

.DESCRIPTION
  Usa o CLI oficial do DSH, exatamente como o usuário faria:

      dsh plugin --profile <profile> add -w <caminho absoluto do pacote>

  `-w` (workspace root) é necessário porque o profile é um workspace pnpm
  (`pnpm-workspace.yaml` com `packages: [.]`). O comando NÃO reinicia servidores;
  se o profile estiver rodando, o plugin é aplicado em runtime (hot apply) e
  basta recarregar a página no navegador.

  Modos:
    (default)   instala os dois pacotes;
    -Check      só verifica pré-requisitos e o que está instalado (read-only);
    -Remove     remove os dois pacotes do profile;
    -DryRun     imprime os comandos sem executar.

  Valida pré-requisitos antes de qualquer coisa: node, CLI dsh, pasta do profile
  já inicializada, e cada pacote (`package.json`, `lib/index.js`, `lib/client.js`).
  Se `lib/` estiver ausente/divergente, roda `node scripts/sync.mjs` antes de instalar.

.PARAMETER Profile
  Profile de destino. Default: voice-dev. NUNCA use 'desktop' em desenvolvimento.

.PARAMETER Check
  Apenas diagnóstico. Exit 0 = tudo instalado/sincronizado; 1 = falta algo.

.PARAMETER Remove
  Remove os pacotes do profile.

.PARAMETER DryRun
  Mostra os comandos que seriam executados.

.PARAMETER SttOnly / -TtsOnly
  Restringe a um dos plugins.

.PARAMETER DshCli
  Caminho do CLI dsh. Default: descoberta portátil (DSH_CLI -> PATH -> npm
  global -> app Desktop em Program Files/LOCALAPPDATA/DSH_APP_ROOT).

.PARAMETER TimeoutSeconds
  Timeout por comando pnpm (default 600).

.EXAMPLE
  pwsh -File scripts/install.ps1
  pwsh -File scripts/install.ps1 -Check
  pwsh -File scripts/install.ps1 -Profile voice-dev -Remove
  pwsh -File scripts/install.ps1 -DryRun

.NOTES
  - Nunca instala no profile 'desktop' (proteção explícita abaixo).
  - Mensagens em ASCII para funcionar bem via install.bat.
#>
[CmdletBinding()]
param(
    [string]$Profile = 'voice-dev',
    [switch]$Check,
    [switch]$Remove,
    [switch]$DryRun,
    [switch]$SttOnly,
    [switch]$TtsOnly,
    [string]$DshCli,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Failures = 0
$script:AllPackages = [ordered]@{
    'dsh-whisper-stt' = 'STT Whisper (ditado)'
    'dsh-tts'         = 'TTS (leitura em voz alta)'
}

# Descoberta portátil do CLI (sem letra de unidade): DSH_CLI -> PATH -> npm global
# -> instalação do app Desktop (processo em execução, registro, raízes de disco).
$dshResolveLib = Join-Path $PSScriptRoot 'lib\dsh-resolve.ps1'
if (Test-Path -LiteralPath $dshResolveLib) { . $dshResolveLib }

function Write-Ok { param([string]$m) Write-Host "[ok]   $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "[!]    $m" -ForegroundColor Yellow }
function Write-Err {
    param([string]$m)
    Write-Host "[x]    $m" -ForegroundColor Red
    $script:Failures += 1
}
function Write-Info { param([string]$m) Write-Host "       $m" }

function Get-SelectedPackages {
    $names = @()
    foreach ($name in $script:AllPackages.Keys) {
        if ($SttOnly -and $name -ne 'dsh-whisper-stt') { continue }
        if ($TtsOnly -and $name -ne 'dsh-tts') { continue }
        $names += $name
    }
    return $names
}

function Resolve-DshCli {
    if (-not (Get-Command Resolve-DshCliPath -ErrorAction SilentlyContinue)) { return $null }
    return (Resolve-DshCliPath -Explicit $DshCli)
}

function Get-ProfileDir {
    param([string]$Name)
    $homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    return (Join-Path (Join-Path $homeDir 'profiles') $Name)
}

function Invoke-Dsh {
    <# Executa o CLI e devolve {ExitCode, Output}. #>
    param([string[]]$Arguments, [int]$Timeout = 600)
    $argString = ($Arguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' '
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $script:DshCliPath -ArgumentList $argString -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $exited = $proc.WaitForExit($Timeout * 1000)
        if (-not $exited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
            return [pscustomobject]@{ ExitCode = -1; Output = "timeout de $Timeout s"; TimedOut = $true }
        }
        $stdout = ''
        $stderr = ''
        try { $stdout = [System.IO.File]::ReadAllText($outFile) } catch { }
        try { $stderr = [System.IO.File]::ReadAllText($errFile) } catch { }
        return [pscustomobject]@{ ExitCode = [int]$proc.ExitCode; Output = ($stdout + $stderr).Trim(); TimedOut = $false }
    }
    catch {
        return [pscustomobject]@{ ExitCode = 127; Output = $_.Exception.Message; TimedOut = $false }
    }
    finally {
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-Package {
    param([string]$Name)
    $dir = Join-Path (Join-Path $script:RepoRoot 'packages') $Name
    $info = [pscustomobject]@{
        Name        = $Name
        Dir         = $dir
        Exists      = (Test-Path -LiteralPath (Join-Path $dir 'package.json'))
        LibIndex    = (Test-Path -LiteralPath (Join-Path $dir 'lib\index.js'))
        LibClient   = (Test-Path -LiteralPath (Join-Path $dir 'lib\client.js'))
        HasRuntime  = (Test-Path -LiteralPath (Join-Path $dir 'runtime'))
        HasPatch    = (Test-Path -LiteralPath (Join-Path $dir 'cordis.patch.yml'))
        Installed   = $false
        Bundled     = $false
        NodeModules = $false
    }
    return $info
}

function Get-ProfileState {
    param([string]$ProfileDir)
    $state = [pscustomobject]@{
        PackageJson = $null
        Dependencies = @{}
        Bundles      = @()
    }
    $pkgPath = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgPath)) { return $state }
    try {
        $json = Get-Content -LiteralPath $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json
        $state.PackageJson = $json
        if ($json.dependencies) {
            foreach ($prop in $json.dependencies.PSObject.Properties) {
                $state.Dependencies[$prop.Name] = [string]$prop.Value
            }
        }
        if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
            $state.Bundles = @($json.dsh.profile.bundles)
        }
    }
    catch {
        Write-Warn "profile package.json ilegível: $($_.Exception.Message)"
    }
    return $state
}

function Test-NodeAndCli {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { Write-Ok "node: $($node.Source) ($(node --version))" }
    else { Write-Err 'node nao encontrado no PATH (instale Node.js 20+)' }

    $script:DshCliPath = Resolve-DshCli
    if ($script:DshCliPath) { Write-Ok "dsh CLI: $($script:DshCliPath)" }
    else {
        Write-Err 'CLI dsh nao encontrado.'
        if (Get-Command Get-DshCliSearchHints -ErrorAction SilentlyContinue) {
            foreach ($hint in (Get-DshCliSearchHints)) { Write-Info "  - $hint" }
        }
    }
}

# ===================== início =====================
Write-Host ''
Write-Host '=== DSH Voice Suite — install.ps1 ===' -ForegroundColor Cyan
Write-Host "Profile : $Profile"
Write-Host "Repo    : $script:RepoRoot"
if ($Check) { Write-Host 'Mode    : CHECK (read-only)' }
elseif ($Remove) { Write-Host 'Mode    : REMOVE' }
elseif ($DryRun) { Write-Host 'Mode    : DRY-RUN' }
else { Write-Host 'Mode    : INSTALL' }
Write-Host ''

if ($Profile -eq 'desktop') {
    Write-Err "recusado: nunca instale no profile 'desktop' durante o desenvolvimento. Use 'voice-dev' (ou voice-dev-stt/voice-dev-tts)."
    exit 1
}

$profileDir = Get-ProfileDir -Name $Profile
$packages = Get-SelectedPackages
if ($packages.Count -eq 0) {
    Write-Err 'nenhum pacote selecionado (SttOnly/TtsOnly se excluem).'
    exit 1
}

Write-Host '--- pre-requisitos ---' -ForegroundColor Cyan
Test-NodeAndCli

if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Err "profile '$Profile' nao inicializado em $profileDir. Crie com: dsh plugin --profile $Profile add -w @deepseek-ai/dsh-web-app (antes do plugin)."
}
else {
    Write-Ok "profile: $profileDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
    Write-Err 'profile sem package.json (inicialize o profile primeiro).'
}

$pkgStates = @()
foreach ($name in $packages) {
    $state = Test-Package -Name $name
    $pkgStates += $state
    if (-not $state.Exists) {
        Write-Err "pacote ausente: $($state.Dir)\package.json (o dev ainda nao criou o pacote)"
        continue
    }
    if (-not $state.LibIndex -or -not $state.LibClient) {
        Write-Warn "lib/ incompleto em $name (rode 'node scripts/sync.mjs' antes de instalar)"
    }
    if (-not $state.HasPatch) {
        Write-Warn "$name sem cordis.patch.yml (o CLI pode nao registrar o plugin)"
    }
    if (-not $state.HasRuntime) {
        Write-Warn "$name sem runtime/ (prepare/worker podem falhar)"
    }
}

# O `lib/` é o que roda. qa-dev NÃO escreve em packages/ (escopo do dev do
# pacote): se estiver ausente/divergente, o dono deve rodar `node scripts/sync.mjs`.
$needsSync = @($pkgStates | Where-Object { $_.Exists -and (-not $_.LibIndex -or -not $_.LibClient) })
if ($needsSync.Count -gt 0) {
    foreach ($state in $needsSync) {
        Write-Err "$($state.Name): lib/ incompleto ($($state.Dir)\lib). Rode: node scripts/sync.mjs --package $($state.Name) (dono do pacote) e tente de novo."
    }
}
$diverged = $false
if (-not $Check -and -not $Remove -and -not $DryRun -and $pkgStates.Count -gt 0) {
    $syncCheck = & node (Join-Path $PSScriptRoot 'sync.mjs') --check --quiet 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $diverged = $true
        Write-Warn "src/ e lib/ divergem (sync --check falhou). Rode `node scripts/sync.mjs` (dono do pacote) antes de instalar; vou seguir com o lib/ atual."
    }
}

# Estado do profile.
$profileState = Get-ProfileState -ProfileDir $profileDir
Write-Host ''
Write-Host '--- estado do profile ---' -ForegroundColor Cyan
if ($profileState.PackageJson) {
    Write-Info "bundles: $((@($profileState.Bundles)) -join ', ')"
    foreach ($state in $pkgStates) {
        $dist = $profileState.Dependencies[$state.Name]
        $state.Installed = [bool]$dist
        $state.Bundled = @($profileState.Bundles) -contains $state.Name
        $state.NodeModules = Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$($state.Name)\package.json")
        $extra = @()
        if ($state.Installed) { $extra += "dep=$dist" } else { $extra += 'dep=ausente' }
        if ($state.NodeModules) { $extra += 'node_modules=ok' } else { $extra += 'node_modules=ausente' }
        if ($state.Bundled) { $extra += 'bundle=ok' } else { $extra += 'bundle=ausente' }
        if ($state.Installed -and $state.NodeModules) { Write-Ok "$($state.Name): instalado ($($extra -join ', '))" }
        else { Write-Warn "$($state.Name): nao instalado ($($extra -join ', '))" }
    }
}
else {
    Write-Err 'nao consegui ler o package.json do profile'
}

# -Check
if ($Check) {
    Write-Host ''
    $notInstalled = @($pkgStates | Where-Object { -not $_.Installed -or -not $_.NodeModules })
    $notBundled = @($pkgStates | Where-Object { -not $_.Bundled })
    $missingPkg = @($pkgStates | Where-Object { -not $_.Exists })
    if ($notInstalled.Count -gt 0 -or $missingPkg.Count -gt 0) {
        Write-Host "install -Check: $($notInstalled.Count) plugin(s) nao instalado(s) / $($missingPkg.Count) pacote(s) ausente(s)." -ForegroundColor Yellow
        Write-Info "Para instalar: pwsh -File scripts/install.ps1 -Profile $Profile"
        exit 1
    }
    if ($notBundled.Count -gt 0) {
        Write-Warn "plugins instalados mas fora de dsh.profile.bundles: $($notBundled.Name -join ', ') (o plugin-manager reconcilia no proximo boot; se persistir, reinstale)"
    }
    Write-Host "install -Check: OK — $($packages.Count) plugin(s) instalado(s) no profile '$Profile'." -ForegroundColor Green
    exit 0
}

# Comandos por plugin.
$commands = @()
foreach ($state in $pkgStates) {
    if (-not $state.Exists) { continue }
    if ($Remove) {
        $commands += [pscustomobject]@{ Name = $state.Name; Args = @('plugin', '--profile', $Profile, 'remove', $state.Name) }
    }
    else {
        $commands += [pscustomobject]@{ Name = $state.Name; Args = @('plugin', '--profile', $Profile, 'add', '-w', $state.Dir) }
    }
}

if ($DryRun) {
    Write-Host ''
    Write-Host '--- comandos (dry-run) ---' -ForegroundColor Cyan
    foreach ($command in $commands) {
        Write-Host "  & `"$script:DshCliPath`" $($command.Args -join ' ')"
    }
    Write-Host ''
    Write-Host 'install -DryRun: nada foi alterado.'
    exit 0
}

if ($script:Failures -gt 0) {
    Write-Host ''
    Write-Host "install: $($script:Failures) erro(s) de pre-requisito; abortando antes de alterar o profile." -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "--- $(if ($Remove) { 'removendo' } else { 'instalando' }) no profile '$Profile' (o servidor, se estiver rodando, aplica em runtime) ---" -ForegroundColor Cyan
$installFailures = 0
foreach ($command in $commands) {
    $display = "dsh $($command.Args -join ' ')"
    Write-Host "-> $display"
    $result = Invoke-Dsh -Arguments $command.Args -Timeout $TimeoutSeconds
    if ($result.Output) {
        $result.Output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 25 | ForEach-Object { Write-Info ([string]$_) }
    }
    if ($result.ExitCode -ne 0) {
        Write-Err "$($command.Name): comando falhou (exit $($result.ExitCode))"
        $installFailures += 1
        continue
    }
    if ($Remove) {
        $after = Get-ProfileState -ProfileDir $profileDir
        if ($after.Dependencies.ContainsKey($command.Name)) { Write-Err "$($command.Name): ainda consta em dependencies apos remove" }
        else { Write-Ok "$($command.Name): removido do profile" }
    }
    else {
        $after = Get-ProfileState -ProfileDir $profileDir
        # o plugin-manager reconcilia bundles de forma assincrona; tolera ate ~15s
        $deadline = (Get-Date).AddSeconds(15)
        while (-not (@($after.Bundles) -contains $command.Name) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $after = Get-ProfileState -ProfileDir $profileDir
        }
        $installedOk = $after.Dependencies.ContainsKey($command.Name)
        $nodeModulesOk = Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$($command.Name)\package.json")
        $bundleOk = @($after.Bundles) -contains $command.Name
        if ($installedOk -and $nodeModulesOk) {
            Write-Ok "$($command.Name): instalado (dep=$($after.Dependencies[$command.Name]), node_modules=ok, bundle=$(if ($bundleOk) { 'ok' } else { 'pendente' }))"
            if (-not $bundleOk) {
                Write-Warn "$($command.Name): ainda nao consta em dsh.profile.bundles; o plugin-manager reconcilia no proximo boot ou ao reiniciar o profile"
            }
        }
        else {
            Write-Err "$($command.Name): verificacao pos-instalacao falhou (dep=$installedOk, node_modules=$nodeModulesOk)"
            $installFailures += 1
        }
    }
}

Write-Host ''
if ($installFailures -gt 0) {
    Write-Host "install: $installFailures plugin(s) com falha." -ForegroundColor Red
    exit 1
}

Write-Host 'install: concluido com sucesso.' -ForegroundColor Green
Write-Host ''
Write-Host 'Proximos passos:' -ForegroundColor Cyan
if ($Remove) {
    if (-not $Check) { Write-Host '  - Recarregue a pagina do profile para sumir a UI dos plugins (o servidor segue rodando).' }
}
else {
    Write-Host "  - Runtime Python (uma vez): pwsh -File scripts/setup-runtime.ps1"
    Write-Host "  - Subir/validar o servidor: pwsh -File scripts/dev-server.ps1"
    if (-not $Check) {
        Write-Host '  - Se o profile ja estava rodando: apenas recarregue a pagina (hot apply); NAO reinicie o servidor.'
    }
    Write-Host '  - Pipeline de QA: pwsh -File tests/run-all.ps1'
}
exit 0


