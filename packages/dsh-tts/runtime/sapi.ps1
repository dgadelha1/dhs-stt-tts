# dsh-tts SAPI (System.Speech) offline synthesis helper.
#
# The text ALWAYS arrives through a UTF-8 file (`-TextFile`); it is never
# interpolated into a command line, so no quoting/injection path exists.
# Output is a 16-bit PCM mono WAV file.
#
# List installed voices (JSON on stdout):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sapi.ps1 -ListVoices
#
# Synthesize:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sapi.ps1 `
#     -TextFile <utf8.txt> -OutFile <out.wav> -Voice "Microsoft Maria Desktop" -Rate 0 -Volume 100
#
# Exit codes: 0 ok, 2 failure (message on stderr).

[CmdletBinding(DefaultParameterSetName = 'Speak')]
param(
    [Parameter(ParameterSetName = 'List', Mandatory = $true)]
    [switch]$ListVoices,

    [Parameter(ParameterSetName = 'Speak', Mandatory = $true)]
    [string]$TextFile,

    [Parameter(ParameterSetName = 'Speak', Mandatory = $true)]
    [string]$OutFile,

    [Parameter(ParameterSetName = 'Speak')]
    [string]$Voice = '',

    [Parameter(ParameterSetName = 'Speak')]
    [int]$Rate = 0,

    [Parameter(ParameterSetName = 'Speak')]
    [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
$synth = $null

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

    if ($PSCmdlet.ParameterSetName -eq 'List') {
        $rows = @()
        foreach ($installed in $synth.GetInstalledVoices()) {
            if (-not $installed.Enabled) { continue }
            $info = $installed.VoiceInfo
            $rows += [pscustomobject]@{
                name    = [string]$info.Name
                culture = [string]$info.Culture.Name
                gender  = [string]$info.Gender
                age     = [string]$info.Age
            }
        }
        # ConvertTo-Json emits a single object for a one-element array; force a
        # JSON array so the host always parses the same shape.
        ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
        exit 0
    }

    if (-not (Test-Path -LiteralPath $TextFile)) {
        throw "text file not found: $TextFile"
    }
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'empty text'
    }

    if ($Voice -ne '') {
        $installedNames = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
        if ($installedNames -contains $Voice) {
            $synth.SelectVoice($Voice)
        }
        # An unknown voice intentionally keeps the default voice: the host
        # reports the engine/voice actually used through its own mapping.
    }

    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
    $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

    # 22.05 kHz / 16-bit / mono: small, universally supported, and adequate
    # for speech. SpeechAudioFormatInfo avoids the default 16 kHz 16-bit mono
    # profile differences between Windows releases.
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        22050,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synth.SetOutputToWaveFile($OutFile, $format)
    $synth.Speak($text)
    $synth.SetOutputToNull()

    if (-not (Test-Path -LiteralPath $OutFile)) {
        throw 'SAPI produced no output file'
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine('sapi: ' + $_.Exception.Message)
    exit 2
}
finally {
    if ($null -ne $synth) {
        try { $synth.Dispose() } catch { }
    }
}
