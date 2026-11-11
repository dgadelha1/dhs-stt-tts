#requires -Version 7.0
<#
.SYNOPSIS
  Descoberta portátil do CLI `dsh` e do runtime Python que acompanha o app
  Desktop do DeepSeek Harness. Dot-source a partir de scripts/*.ps1.

.DESCRIPTION
  Nada aqui assume letra de unidade ou nome de usuário. A ordem de descoberta é:

    CLI dsh:
      1. caminho explícito (parâmetro)
      2. $env:DSH_CLI
      3. `dsh` / `dsh.cmd` / `dsh.exe` no PATH
      4. %APPDATA%\npm\dsh.cmd (instalação global via npm)
      5. instalação do app Desktop em Program Files / Program Files (x86) /
         %LOCALAPPDATA%\Programs (e $env:DSH_APP_ROOT quando definido)

    Python do runtime DSH:
      - <app>\resources\runtime\primary-runtime\dependencies\python\python.exe
      - <app>\resources\runtime\*\dependencies\python\python.exe
      - <DSH_HOME>\dsh-runtimes\*\dependencies\python\python.exe
      - variantes POSIX com .../bin/python

  Funções exportadas (por dot-sourcing):
    Get-DshHome
    Resolve-DshCliPath [-Explicit <path>]
    Get-DshAppRoot [-DshCliPath <path>]
    Get-DshRuntimePythonCandidates [-DshCliPath <path>]
    Get-DshCliSearchHints   (lista p/ mensagens de erro acionáveis)
#>

function Get-DshHome {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { return [System.IO.Path]::GetFullPath($env:DSH_HOME) }
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { [System.IO.Path]::GetTempPath() }
    return (Join-Path $homeDir '.dsh')
}

function Get-DshAppInstallRoots {
    $isWindowsPlatform = $env:OS -eq 'Windows_NT'
    $roots = [System.Collections.Generic.List[string]]::new()
    if ($env:DSH_APP_ROOT -and $env:DSH_APP_ROOT.Trim()) {
        $roots.Add($env:DSH_APP_ROOT)
    }
    foreach ($envName in @('ProgramFiles', 'ProgramFiles(x86)')) {
        $base = [Environment]::GetEnvironmentVariable($envName)
        if ($base) { $roots.Add((Join-Path $base 'DeepSeek Harness')) }
    }
    if ($env:LOCALAPPDATA) {
        $roots.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
        $roots.Add((Join-Path $env:LOCALAPPDATA 'DeepSeek Harness'))
    }
    if ($env:USERPROFILE) {
        $roots.Add((Join-Path $env:USERPROFILE 'AppData\Local\Programs\DeepSeek Harness'))
    }

    if ($isWindowsPlatform) {
        # App Desktop em execução: deriva a raiz do caminho do EXE (sem letra fixa).
        try {
            foreach ($process in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })) {
                if ($process.Path) { $roots.Add((Split-Path -Parent $process.Path)) }
            }
        }
        catch { /* sem permissão: segue com os demais */ }

        # Registro de desinstalação (instaladores NSIS/MSI gravam InstallLocation).
        $uninstallKeys = @(
            'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        foreach ($key in $uninstallKeys) {
            try {
                foreach ($entry in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*DeepSeek Harness*' })) {
                    if ($entry.InstallLocation -and (Test-Path -LiteralPath $entry.InstallLocation)) {
                        $roots.Add($entry.InstallLocation)
                    }
                    elseif ($entry.DisplayIcon) {
                        $iconPath = ($entry.DisplayIcon -split ',')[0].Trim('"')
                        if ($iconPath -and (Test-Path -LiteralPath $iconPath)) {
                            $roots.Add((Split-Path -Parent $iconPath))
                        }
                    }
                }
            }
            catch { /* chave ausente: ignora */ }
        }

        # Raízes de disco: procura só o nível superior (rápido, sem hardcode de unidade).
        foreach ($drive in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
            if (-not $drive.Root) { continue }
            $candidateRoot = Join-Path $drive.Root 'DeepSeek Harness'
            $candidateCli = Join-Path $candidateRoot 'resources\runtime\cli\bin\dsh.cmd'
            if (Test-Path -LiteralPath $candidateCli) { $roots.Add($candidateRoot) }
        }
    }
    else {
        $roots.Add('/Applications/DeepSeek Harness.app/Contents/Resources')
        $roots.Add('/opt/DeepSeek Harness')
        $roots.Add('/opt/deepseek-harness')
    }
    return @($roots | Select-Object -Unique)
}

function Get-DshCliSearchHints {
    $hints = [System.Collections.Generic.List[string]]::new()
    $hints.Add('defina DSH_CLI=<caminho do dsh.cmd/dsh>')
    $hints.Add('ou coloque `dsh` no PATH')
    $hints.Add('ou passe -DshCli <caminho> nos scripts')
    foreach ($root in (Get-DshAppInstallRoots)) {
        $hints.Add("app Desktop: $(Join-Path $root 'resources\runtime\cli\bin\dsh.cmd')")
    }
    return $hints
}

function Resolve-DshCliPath {
    param([string]$Explicit)

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($Explicit) { $candidates.Add($Explicit) }
    if ($env:DSH_CLI -and $env:DSH_CLI.Trim()) { $candidates.Add($env:DSH_CLI) }

    foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source) { $candidates.Add($command.Source) }
    }

    if ($env:APPDATA) {
        $candidates.Add((Join-Path $env:APPDATA 'npm\dsh.cmd'))
        $candidates.Add((Join-Path $env:APPDATA 'npm\dsh'))
    }
    if ($env:LOCALAPPDATA) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'npm\dsh.cmd'))
    }
    if ($env:USERPROFILE) {
        $candidates.Add((Join-Path $env:USERPROFILE 'AppData\Roaming\npm\dsh.cmd'))
    }

    foreach ($root in (Get-DshAppInstallRoots)) {
        $candidates.Add((Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'))
        $candidates.Add((Join-Path $root 'resources/runtime/cli/bin/dsh'))
        $candidates.Add((Join-Path $root 'dsh.cmd'))
        $candidates.Add((Join-Path $root 'dsh'))
    }

    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        try {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
        catch { /* caminho inválido: tenta o próximo */ }
    }
    return $null
}

function Get-DshAppRoot {
    param([string]$DshCliPath)
    if ($env:DSH_APP_ROOT -and $env:DSH_APP_ROOT.Trim() -and (Test-Path -LiteralPath $env:DSH_APP_ROOT)) {
        return (Resolve-Path -LiteralPath $env:DSH_APP_ROOT).Path
    }
    if (-not $DshCliPath) { return $null }
    $normalized = $DshCliPath -replace '\\', '/'
    foreach ($marker in @('/resources/runtime/cli/bin/', '/resources/cli/bin/')) {
        $index = $normalized.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
        if ($index -gt 0) {
            return [System.IO.Path]::GetFullPath($normalized.Substring(0, $index))
        }
    }
    return $null
}

function Get-DshRuntimePythonCandidates {
    param([string]$DshCliPath)

    $candidates = [System.Collections.Generic.List[string]]::new()
    $suffixes = @(
        'dependencies/python/python.exe',
        'dependencies/python/bin/python',
        'dependencies/python/bin/python3'
    )

    $appRoot = Get-DshAppRoot -DshCliPath $DshCliPath
    if ($appRoot) {
        $runtimeRoot = Join-Path $appRoot 'resources/runtime'
        if (-not (Test-Path -LiteralPath $runtimeRoot)) {
            $runtimeRoot = Join-Path $appRoot 'resources'
        }
        if (Test-Path -LiteralPath $runtimeRoot) {
            foreach ($sub in @('primary-runtime', 'dsh-primary-runtime')) {
                foreach ($suffix in $suffixes) {
                    $candidates.Add((Join-Path $runtimeRoot (Join-Path $sub $suffix)))
                }
            }
            $runtimes = @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue)
            foreach ($dir in $runtimes) {
                foreach ($suffix in $suffixes) {
                    $candidates.Add((Join-Path $dir.FullName $suffix))
                }
            }
        }
    }

    $dshHome = Get-DshHome
    $homeRuntimes = Join-Path $dshHome 'dsh-runtimes'
    if (Test-Path -LiteralPath $homeRuntimes) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $homeRuntimes -Directory -ErrorAction SilentlyContinue)) {
            foreach ($suffix in $suffixes) {
                $candidates.Add((Join-Path $dir.FullName $suffix))
            }
        }
    }

    $existing = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
    return $existing
}
