$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $rootDir "bin"
$modelsDir = Join-Path $rootDir "models"
$selectedModelFile = Join-Path $rootDir "selected_model.txt"
$tempZip = Join-Path $rootDir "_whisper_tmp.zip"
$tempExtract = Join-Path $rootDir "_whisper_extract"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

function Download-FileFast([string]$url, [string]$destPath) {
    if (Test-Path $destPath) { Remove-Item -Force $destPath }
    $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -fL --retry 2 --progress-bar -o $destPath $url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $destPath) -and ((Get-Item $destPath).Length -gt 1024)) {
            return
        }
    }
    Write-Host "PowerShell でダウンロード中: $url"
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "e-learning-killer-setup")
    $wc.DownloadFile($url, $destPath)
}

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " e-learning Killer ローカルWhisper 初回セットアップ" -ForegroundColor Cyan
Write-Host " (Windows自動起動への登録は一切行いません)" -ForegroundColor DarkGray
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

$serverExe = Join-Path $binDir "whisper-server.exe"
if (Test-Path $serverExe) {
    Write-Host "[OK] whisper-server.exe は既に導入済みです: $serverExe" -ForegroundColor Green
    $reinstall = Read-Host "バイナリを最新版に再ダウンロードしますか？ [y/N]"
    $needBin = ($reinstall -match "^[yY]")
} else {
    $needBin = $true
}

if ($needBin) {
    Write-Host "[1/2] ggml-org/whisper.cpp の最新 Windows バイナリを確認中..." -ForegroundColor Yellow
    $zipUrl = $null
    try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "e-learning-killer-setup" }
        foreach ($rel in $releases) {
            if (-not $rel.assets) { continue }
            $asset = $rel.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } | Select-Object -First 1
            if (-not $asset) {
                $asset = $rel.assets | Where-Object { $_.name -match "^whisper-.*bin-(?:win-.*)?x64\.zip$" -and $_.name -notmatch "cublas|cuda|opencl" } | Select-Object -First 1
            }
            if ($asset) {
                $zipUrl = $asset.browser_download_url
                Write-Host "検出アセット: $($rel.tag_name) / $($asset.name)" -ForegroundColor Green
                break
            }
        }
    } catch {
        Write-Host "GitHub API取得に失敗したためフォールバックURLを使用します..." -ForegroundColor Yellow
    }
    if (-not $zipUrl) {
        $zipUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip"
    }

    Write-Host "ダウンロード中: $zipUrl"
    Download-FileFast $zipUrl $tempZip

    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Write-Host "展開中..."
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

    $foundServer = Get-ChildItem -Path $tempExtract -Filter "whisper-server.exe" -Recurse | Select-Object -First 1
    if (-not $foundServer) {
        throw "解凍したZIP内に whisper-server.exe が見つかりませんでした。"
    }
    $srcDir = $foundServer.Directory.FullName
    Copy-Item -Path (Join-Path $srcDir "*") -Destination $binDir -Recurse -Force

    Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue
    Write-Host "[OK] whisper-server.exe を配置しました -> $binDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/2] ダウンロードする音声認識モデルを選択してください:" -ForegroundColor Yellow
Write-Host "  [1] ggml-small.en.bin         (約488MB) [推奨] 英語問題 高精度・実用速度"
Write-Host "  [2] ggml-base.en.bin          (約148MB)        軽量・高速 (PC負荷最小)"
Write-Host "  [3] ggml-large-v3-turbo-q5_0.bin (約574MB)     最高精度 (英語+日本語 両対応)"
Write-Host "  [4] ggml-small.bin            (約488MB)        英語+日本語 バランス型"
Write-Host "  [S] モデルダウンロードをスキップ (既存モデルを使用)"
Write-Host ""
$choice = Read-Host "番号を入力してください [既定: 1]"
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }

$modelMap = @{
    "1" = "ggml-small.en.bin"
    "2" = "ggml-base.en.bin"
    "3" = "ggml-large-v3-turbo-q5_0.bin"
    "4" = "ggml-small.bin"
}

if ($choice -notmatch "^[sS]$") {
    $modelName = $modelMap[$choice]
    if (-not $modelName) { $modelName = "ggml-small.en.bin" }
    $modelPath = Join-Path $modelsDir $modelName
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$modelName"

    if ((Test-Path $modelPath) -and ((Get-Item $modelPath).Length -gt 10MB)) {
        Write-Host "[OK] モデルは既に存在します: $modelPath" -ForegroundColor Green
    } else {
        Write-Host "モデルをダウンロード中: $modelName ..." -ForegroundColor Yellow
        Download-FileFast $modelUrl $modelPath
        Write-Host "[OK] モデルを保存しました -> $modelPath" -ForegroundColor Green
    }
    Set-Content -Path $selectedModelFile -Value $modelName -Encoding UTF8
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " セットアップ完了！" -ForegroundColor Green
Write-Host " 使う時は 「2_ローカル音声サーバー起動.bat」 を起動してください。" -ForegroundColor White
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""
$launchNow = Read-Host "このまま今すぐローカル音声サーバーを起動しますか？ [Y/n]"
if ([string]::IsNullOrWhiteSpace($launchNow) -or $launchNow -match "^[yY]") {
    & (Join-Path $rootDir "start_whisper_server.ps1")
}
