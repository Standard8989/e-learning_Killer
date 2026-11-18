# e-learning Killer (Chrome拡張機能)

ブラウザ上の選択式クイズ・リスニング問題・穴埋め問題（ラジオボタン、チェックボックス、選択肢ボタン、ドロップダウン、テキスト入力、単語カード、SCORM 等の `iframe` 内コンテンツ）を AI と Whisper 音声認識で解析し、**解答入力 → 送信 → 次画面遷移 → コース周回** までを自動化する Chrome 拡張機能です。

---

## 主な特徴

- **DeepSeek 標準対応 & マルチ LLM API 対応**:
  - デフォルトで **DeepSeek** (`deepseek-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`) に対応
  - **OpenAI / Google Gemini (OpenAI互換・Native API) / Anthropic Claude / OpenRouter / Groq / Ollama (ローカルLLM) / カスタム (OpenAI互換API)** をプリセットから切替可能（API キーはプリセットごとに保持）
- **Whisper 音声認識によるリスニング自動解答（ローカル完結 & API 両対応）**:
  - **PC ローカルサーバー（`whisper.cpp`）**、**ブラウザ内ローカル AI（Whisper WASM）**、**クラウド音声 API（Groq / Gemini / OpenAI / ElevenLabs）** の 3 系統に対応
- **多様な出題形式・学習フローに対応**:
  - 単語カード（未再生カードから順次再生 → 「次へ進む」まで自動実行）
  - 長文空所補充（`<input>` 直入力・クリック展開型「`入力...`」ピル・`<select>`）
  - 発話／録音課題（後で自力実施できるよう自動スキップ）
  - 全問解答済み・導入・採点後画面でのゼロトークン進行（不要な AI 再呼び出し・`テスト結果 (解答と解説)` の再周回・`もう一回` クリックを抑止）
  - コース一覧画面からの自動レッスン開始＆レッスン完了後の自動帰還（全自動モード時）
- **iframe / SCORM 対応 & フローティング HUD / デバッグ診断**:
  - ページ右下フローティングパネル（Shadow DOM）から進捗・理由・デバッグログの確認や診断レポートのコピーが可能

---

## 導入手順

1. Chrome（または Edge / Brave 等の Chromium 系ブラウザ）で `chrome://extensions/` を開く
2. 右上の **「デベロッパー モード」** を **ON** にする
3. 左上の **「パッケージ化されていない拡張機能を読み込む」** をクリックし、このフォルダを選択する
4. 拡張機能アイコンから **e-learning Killer** を開き、**「API設定」** タブに利用したい LLM の **API Key** を入力して **「🔌 接続テスト」** を実行する
5. 拡張機能更新後は、`chrome://extensions/` の **🔄 更新** を押し、対象ページも **F5（再読み込み）** する

> **ローカルの `demo_quiz.html` でテストする場合**:
> `chrome://extensions/` の e-learning Killer「詳細」から **「ファイルの URL へのアクセスを許可する」** を ON にし、`demo_quiz.html` を開いて実行してください。

---

## 🎧 リスニング課題の文字起こし（Whisper セットアップ）

ポップアップ「API設定」の **「🎧 音声課題の文字起こし」** で動作方式を選べます。  
初期値の **`自動 (PCサーバー→API→ブラウザ内)`** では、API キー無しでも以下の順で自動動作します。

1. **PC ローカル Whisper サーバー (`http://127.0.0.1:8765/inference`)** が起動中なら最優先で使用
2. **音声用 API Key**（または Groq / OpenAI / Gemini に設定済みのキー）があればクラウド STT を使用（失敗時はブラウザ内 AI へ自動フォールバック）
3. いずれも無ければ **ブラウザ内ローカル AI（Whisper WASM）** で自動文字起こし

### 方法 A: PC ローカル Whisper サーバーを使う（推奨・高精度・API無料）

`local-stt/` フォルダ内の `.bat` で `ggml-org/whisper.cpp` の Windows x64 公式バイナリとモデルを導入できます。  
**Windows の自動起動（スタートアップ等）への登録は一切行いません。** 使う時だけ手動で起動します。

1. **初回セットアップ**:
   `local-stt/1_初回セットアップ_ローカルWhisper.bat` をダブルクリックします（内部で `local-stt/setup_whisper.ps1` を実行）。
   - `whisper.cpp` の最新 Windows x64 バイナリを `local-stt/bin/` に配置します。
   - ダウンロードするモデル番号を選択します：
     - `[1] ggml-small.en.bin`（約488MB・**英語問題 推奨**）
     - `[2] ggml-base.en.bin`（約148MB・軽量・高速）
     - `[3] ggml-large-v3-turbo-q5_0.bin`（約574MB・最高精度・英語＋日本語両対応）
     - `[4] ggml-small.bin`（約488MB・英語＋日本語バランス型）
   - ※ `local-stt/bin/` と `local-stt/models/` は大容量のため `.gitignore` により Git 管理から除外されています（別環境では本 `.bat` で再取得できます）。

2. **サーバー起動（音声課題を使う時だけ）**:
   `local-stt/2_ローカル音声サーバー起動.bat` をダブルクリックすると、`http://127.0.0.1:8765/inference` で待受を開始します。  
   終了するときは開いたウィンドウを閉じる（または `Ctrl + C`）だけです。

### 方法 B: ブラウザ内ローカル AI（Whisper WASM）を使う（追加ソフト不要）

`offscreen.html` / `offscreen.js` と `vendor/transformers/`（Transformers.js + ONNX Runtime WASM）を使用し、Chrome 単体で音声デコード（16kHz モノラル PCM）と Whisper 推論を実行します。  
PC ローカルサーバーを起動していない場合でも動作し、ポップアップから以下のモデルを切り替えられます（初回のみモデルをブラウザキャッシュへ自動取得します）：

- `onnx-community/whisper-base.en`（英語推奨・約75MB）
- `onnx-community/whisper-tiny.en`（最軽量・約40MB）
- `onnx-community/whisper-small.en`（高精度英語・約250MB）
- `onnx-community/whisper-base`（多言語・約75MB）

### 方法 C: クラウド音声認識 API を使う（任意）

ポップアップ「音声用API Key」に以下のキーを設定するか、文字起こし方式で明示選択できます：

- **Groq Whisper (`gsk_...`)**
- **Google Gemini (`AIza...`)**
- **OpenAI Whisper**
- **ElevenLabs STT (`sk_...`)**

> 音声の抽出・文字起こしだけが正常に動くか確認したい場合は、音声課題のタブを開いた状態でポップアップの **「🎧 音声文字起こしテスト」**（または HUD 右上の `🎧`）を押してください。

---

## 操作方法・ショートカット

- **ページ右下フローティングパネル** または **拡張機能ポップアップ** から操作：
  - **▶ 全自動開始 / ▶ 全自動でしばく (`Alt + Shift + S`)**: 全自動ループの開始／停止
  - **⚡ 1問解く / ⚡ 1問だけ解く (`Alt + Shift + Q`)**: 現在の 1 ステップのみ解答
- **動作・詳細設定タブ**:
  - 問題間の待機時間（ms）・選択→送信間隔（ms）
  - 「1問だけ解く」時の自動送信 ON/OFF、右下パネル表示 ON/OFF、緑枠ハイライト ON/OFF
  - スクリーンショット添付（Vision 対応モデルで図表を読む場合）
  - 追加プロンプト（受験科目の前提や解答方針の指定）

---

## ディレクトリ構成

- `manifest.json` / `background.js` / `content.js`: 拡張機能本体（MV3 Service Worker・DOM解析/実行/HUD）
- `popup.html` / `popup.js` / `popup.css`: 設定・ステータス・デバッグポップアップ UI
- `offscreen.html` / `offscreen.js` / `vendor/transformers/`: ブラウザ内ローカル Whisper WASM 実行ワーカー
- `local-stt/`: Windows 用ローカル `whisper.cpp` サーバーの導入・手動起動用バッチ／PowerShell スクリプト
- `demo_quiz.html` / `icons/`: ローカル動作確認用クイズと拡張機能アイコン
