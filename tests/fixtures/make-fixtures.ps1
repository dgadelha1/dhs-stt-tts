#requires -Version 7.0
<#
.SYNOPSIS
  Gera os WAVs de fixture de STT (16 kHz, mono, PCM16) usando System.Speech (offline)
  e valida o formato. Fonte de verdade: tests/fixtures/texts.json.

.DESCRIPTION
  Para cada entrada de `fixtures` no texts.json:
    1. escolhe a voz SAPI da cultura (ou `sapiVoice`, ou a voz default);
    2. sintetiza o texto diretamente em WAV 16 kHz / mono / PCM16
       (SpeechAudioFormatInfo — sem resampling externo);
    3. valida cabeçalho RIFF/WAVE, chunk fmt (PCM, 1 canal, 16000 Hz, 16 bits)
       e duração; imprime ✓/✗ e a duração.

  Idempotente: se o WAV já existir e for válido, não regenera (use -Force para forçar).
  Não usa rede, ffmpeg ou Python.

.PARAMETER Force
  Regenera todos os WAVs mesmo que já existam e sejam válidos.

.PARAMETER Only
  Restringe a fixtures específicas: `-Only pt-br,en-us`.

.PARAMETER ListVoices
  Lista as vozes SAPI instaladas, gera nada e sai.

.PARAMETER FixturesDir
  Diretório de saída. Default: o diretório deste script.

.PARAMETER TextsFile
  Manifesto JSON. Default: <FixturesDir>/texts.json.

.EXAMPLE
  pwsh -File tests/fixtures/make-fixtures.ps1
  pwsh -File tests/fixtures/make-fixtures.ps1 -Force
  pwsh -File tests/fixtures/make-fixtures.ps1 -ListVoices

.NOTES
  Saída: 0 = todos os WAVs válidos; 1 = alguma fixture falhou.
  Vozes padrão no ambiente: pt-BR (Maria/Daniel), en-US (Zira).
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string[]]$Only,
    [switch]$ListVoices,
    [string]$FixturesDir = $PSScriptRoot,
    [string]$TextsFile
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message"
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  [ok] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [warn] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "  [erro] $Message" -ForegroundColor Red
    $script:Failures += 1
}

function Get-InstalledSpeechVoices {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $voices = @()
        foreach ($v in $synth.GetInstalledVoices()) {
            $voices += [pscustomobject]@{
                Name     = $v.VoiceInfo.Name
                Culture  = $v.VoiceInfo.Culture.Name
                Gender   = "$($v.VoiceInfo.Gender)"
                Enabled  = [bool]$v.Enabled
            }
        }
        return $voices
    }
    finally {
        $synth.Dispose()
    }
}

function Select-SapiVoice {
    param(
        [System.Speech.Synthesis.SpeechSynthesizer]$Synth,
        [string]$Culture,
        [string]$PreferredName
    )
    $installed = @($Synth.GetInstalledVoices() | Where-Object { $_.Enabled })
    $byCulture = @($installed | Where-Object { $_.VoiceInfo.Culture.Name -eq $Culture })
    if ($byCulture.Count -gt 0) {
        if ($PreferredName) {
            $exact = @($byCulture | Where-Object { $_.VoiceInfo.Name -eq $PreferredName })
            if ($exact.Count -gt 0) { return $exact[0].VoiceInfo.Name }
            $partial = @($byCulture | Where-Object { $_.VoiceInfo.Name -like "*$PreferredName*" })
            if ($partial.Count -gt 0) { return $partial[0].VoiceInfo.Name }
        }
        return $byCulture[0].VoiceInfo.Name
    }
    if ($PreferredName) {
        $exact = @($installed | Where-Object { $_.VoiceInfo.Name -eq $PreferredName })
        if ($exact.Count -gt 0) {
            Write-Warn "voz '$PreferredName' existe mas não é da cultura $Culture; usando mesmo assim"
            return $exact[0].VoiceInfo.Name
        }
    }
    $fallback = @($installed)[0].VoiceInfo.Name
    Write-Warn "nenhuma voz SAPI para a cultura $Culture; usando voz default '$fallback' (áudio pode sair no idioma errado)"
    return $fallback
}

function Test-Wav16kMonoPcm16 {
    param([string]$Path)
    $result = [pscustomobject]@{
        Ok              = $false
        Reason          = ''
        SampleRate      = 0
        Channels        = 0
        BitsPerSample   = 0
        FormatTag       = 0
        DataBytes       = 0
        DurationSeconds = 0.0
        FileBytes       = 0
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        $result.Reason = 'arquivo não existe'
        return $result
    }
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path))
    $result.FileBytes = $bytes.Length
    if ($bytes.Length -lt 44) {
        $result.Reason = "arquivo pequeno demais ($($bytes.Length) bytes)"
        return $result
    }
    $riff = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    $wave = [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4)
    if ($riff -ne 'RIFF' -or $wave -ne 'WAVE') {
        $result.Reason = "cabeçalho RIFF/WAVE inválido ('$riff'/'$wave')"
        return $result
    }
    $pos = 12
    $fmtFound = $false
    while ($pos + 8 -le $bytes.Length) {
        $id = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
        $size = [BitConverter]::ToUInt32($bytes, $pos + 4)
        $payload = $pos + 8
        if ($id -eq 'fmt ') {
            if ($payload + 16 -gt $bytes.Length) { $result.Reason = 'chunk fmt truncado'; return $result }
            $result.FormatTag = [BitConverter]::ToUInt16($bytes, $payload)
            $result.Channels = [BitConverter]::ToUInt16($bytes, $payload + 2)
            $result.SampleRate = [BitConverter]::ToUInt32($bytes, $payload + 4)
            $result.BitsPerSample = [BitConverter]::ToUInt16($bytes, $payload + 14)
            $fmtFound = $true
        }
        elseif ($id -eq 'data') {
            $result.DataBytes = [int]$size
        }
        # chunks têm padding para tamanho par
        $advance = 8 + [int64]$size
        if ($size % 2 -eq 1) { $advance += 1 }
        if ($advance -le 0) { break }
        $pos += $advance
    }
    if (-not $fmtFound) { $result.Reason = 'chunk fmt ausente'; return $result }
    if ($result.FormatTag -ne 1) { $result.Reason = "format tag $($result.FormatTag) (esperado 1 = PCM)"; return $result }
    if ($result.Channels -ne 1) { $result.Reason = "$($result.Channels) canal(is) (esperado mono)"; return $result }
    if ($result.SampleRate -ne 16000) { $result.Reason = "sample rate $($result.SampleRate) (esperado 16000)"; return $result }
    if ($result.BitsPerSample -ne 16) { $result.Reason = "$($result.BitsPerSample) bits (esperado 16)"; return $result }
    if ($result.DataBytes -le 0) { $result.Reason = 'chunk data vazio'; return $result }
    $result.DurationSeconds = [Math]::Round($result.DataBytes / ($result.SampleRate * $result.Channels * ($result.BitsPerSample / 8.0)), 2)
    $result.Ok = $true
    $result.Reason = "16 kHz mono PCM16, $($result.DurationSeconds)s"
    return $result
}

# --- início -----------------------------------------------------------------
$fixturesDir = (Resolve-Path -LiteralPath $FixturesDir).Path
if (-not $TextsFile) { $TextsFile = Join-Path $fixturesDir 'texts.json' }
if (-not (Test-Path -LiteralPath $TextsFile)) {
    Write-Err "manifesto de fixtures não encontrado: $TextsFile"
    exit 1
}

Add-Type -AssemblyName System.Speech -ErrorAction Stop
$voices = Get-InstalledSpeechVoices

if ($ListVoices) {
    Write-Step "Vozes SAPI instaladas"
    foreach ($v in $voices) {
        Write-Host ("  {0} | {1} | {2} | enabled={3}" -f $v.Name, $v.Culture, $v.Gender, $v.Enabled)
    }
    exit 0
}

$manifest = Get-Content -LiteralPath $TextsFile -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $manifest.fixtures) {
    Write-Err "texts.json sem a seção 'fixtures'"
    exit 1
}

$selected = @()
foreach ($prop in $manifest.fixtures.PSObject.Properties) {
    if ($Only -and $Only.Count -gt 0 -and ($Only -notcontains $prop.Name)) { continue }
    $selected += [pscustomobject]@{ Id = $prop.Name; Spec = $prop.Value }
}
if ($selected.Count -eq 0) {
    Write-Err "nenhuma fixture selecionada (IDs disponíveis: $((@($manifest.fixtures.PSObject.Properties.Name)) -join ', '))"
    exit 1
}

Write-Step "Gerando $($selected.Count) fixture(s) WAV em $fixturesDir"
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    foreach ($item in $selected) {
        $spec = $item.Spec
        $outPath = Join-Path $fixturesDir $spec.file
        Write-Host ""
        Write-Host "-> $($item.Id) ($($spec.file))"

        if ((-not $Force) -and (Test-Path -LiteralPath $outPath)) {
            $existing = Test-Wav16kMonoPcm16 -Path $outPath
            if ($existing.Ok) {
                Write-Ok "já existe e é válido: $($existing.Reason) — use -Force para regenerar"
                continue
            }
            Write-Warn "arquivo existente inválido ($($existing.Reason)); regenerando"
        }

        $culture = if ($spec.culture) { [string]$spec.culture } else { [string]$spec.locale }
        $preferred = if ($spec.sapiVoice) { [string]$spec.sapiVoice } else { $null }
        $voiceName = Select-SapiVoice -Synth $synth -Culture $culture -PreferredName $preferred
        Write-Host "   voz: $voiceName (cultura $culture)"
        Write-Host "   texto: $($spec.text)"

        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
            16000,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $tempPath = "$outPath.part"
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        try {
            $synth.SelectVoice($voiceName)
            $synth.Rate = if ($null -ne $spec.sapiRate) { [int]$spec.sapiRate } else { -1 }
            $synth.Volume = 100
            $synth.SetOutputToWaveFile($tempPath, $format)
            $synth.Speak([string]$spec.text)
            $synth.SetOutputToNull()

            $check = Test-Wav16kMonoPcm16 -Path $tempPath
            if (-not $check.Ok) {
                Write-Err "WAV gerado inválido: $($check.Reason)"
                Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
                continue
            }
            if ($check.DurationSeconds -lt 0.5) {
                Write-Err "áudio curto demais ($($check.DurationSeconds)s)"
                Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
                continue
            }
            Move-Item -LiteralPath $tempPath -Destination $outPath -Force
            Write-Ok "gerado: $outPath ($($check.Reason))"
        }
        catch {
            Write-Err "falha ao sintetizar $($spec.file): $($_.Exception.Message)"
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    $synth.Dispose()
}

Write-Host ""
Write-Step "Resumo"
$valid = 0
foreach ($item in $selected) {
    $outPath = Join-Path $fixturesDir $item.Spec.file
    $check = Test-Wav16kMonoPcm16 -Path $outPath
    if ($check.Ok) {
        $valid += 1
        Write-Host "  [ok] $($item.Spec.file) — $($check.Reason)"
    }
    else {
        Write-Host "  [erro] $($item.Spec.file) — $($check.Reason)" -ForegroundColor Red
        $script:Failures += 1
    }
}

if ($script:Failures -gt 0) {
    Write-Host "make-fixtures: $valid/$($selected.Count) fixture(s) válida(s), $($script:Failures) problema(s)." -ForegroundColor Red
    exit 1
}
Write-Host "make-fixtures: $valid/$($selected.Count) fixture(s) WAV 16 kHz mono PCM16 prontas em $fixturesDir" -ForegroundColor Green
exit 0
