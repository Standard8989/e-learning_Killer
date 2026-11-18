$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $rootDir "bin"
$modelsDir = Join-Path $rootDir "models"
$selectedModelFile = Join-Path $rootDir "selected_model.txt"
$serverExe = Join-Path $binDir "whisper-server.exe"

if (-not (Test-Path $serverExe)) {
    Write-Host "[未セットアップ] whisper-server.exe が見つかりません。" -ForegroundColor Yellow
    $ans = Read-Host "初回セットアップ (1_初回セットアップ_ローカルWhisper.bat) を実行しますか？ [Y/n]"
    if ([string]::IsNullOrWhiteSpace($ans) -or $ans -match "^[yY]") {
        & (Join-Path $rootDir "setup_whisper.ps1")
        exit $LASTEXITCODE
    }
    exit 1
}

$modelPath = $null
if (Test-Path $selectedModelFile) {
    $preferred = (Get-Content $selectedModelFile -Raw).Trim()
    if ($preferred) {
        $cand = Join-Path $modelsDir $preferred
        if (Test-Path $cand) { $modelPath = $cand }
    }
}
if (-not $modelPath) {
    $firstModel = Get-ChildItem -Path $modelsDir -Filter "*.bin" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($firstModel) { $modelPath = $firstModel.FullName }
}

if (-not $modelPath -or -not (Test-Path $modelPath)) {
    Write-Host "[モデル未導入] models フォルダ内に Whisper モデル (.bin) が見つかりません。" -ForegroundColor Yellow
    & (Join-Path $rootDir "setup_whisper.ps1")
    exit $LASTEXITCODE
}

$threads = [Math]::Max(2, [Math]::Min(8, [Environment]::ProcessorCount))
$lang = if ($modelPath -match "\.en\.bin$") { "en" } else { "auto" }
$port = 8765

# Check if port 8765 is already used by whisper.cpp or another application
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect("127.0.0.1", $port, $null, $null)
    $connected = $iar.AsyncWaitHandle.WaitOne(250, $false)
    if ($connected -and $tcp.Connected) {
        $tcp.EndConnect($iar)
        $tcp.Close()
        $isWhisperHere = $false
        try {
            $resp = & curl.exe -s -m 1 "http://127.0.0.1:$port/" 2>$null
            if ($resp -match "whisper") { $isWhisperHere = $true }
        } catch {}
        if ($isWhisperHere) {
            Write-Host "[OK] 既にローカルWhisperサーバーがポート $port で起動中です (http://127.0.0.1:$port/inference)" -ForegroundColor Green
            Read-Host "Enterキーで閉じます"
            exit 0
        } else {
            Write-Host "[注意] ポート $port は別のアプリが使用中のため、ポート 18765 で起動します。" -ForegroundColor Yellow
            $port = 18765
        }
    } else {
        $tcp.Close()
    }
} catch {}

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " e-learning Killer ローカル音声サーバー起動中" -ForegroundColor Cyan
Write-Host " 実行ファイル : $serverExe"
Write-Host " 使用モデル   : $(Split-Path -Leaf $modelPath) (lang=$lang, threads=$threads)"
Write-Host " URL          : http://127.0.0.1:$port/inference" -ForegroundColor Green
Write-Host " 停止方法     : Ctrl+C またはこのウィンドウを閉じる" -ForegroundColor DarkGray
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

& $serverExe --host 127.0.0.1 --port $port -m $modelPath -t $threads -l $lang
