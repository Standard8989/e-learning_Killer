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

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " E-Learning Killer ローカル音声サーバー起動中" -ForegroundColor Cyan
Write-Host " 実行ファイル : $serverExe"
Write-Host " 使用モデル   : $(Split-Path -Leaf $modelPath) (lang=$lang, threads=$threads)"
Write-Host " URL          : http://127.0.0.1:8765/inference" -ForegroundColor Green
Write-Host " 停止方法     : Ctrl+C またはこのウィンドウを閉じる" -ForegroundColor DarkGray
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

& $serverExe --host 127.0.0.1 --port 8765 -m $modelPath -t $threads -l $lang
