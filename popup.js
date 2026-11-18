// popup.js - e-learning Killer Popup Controller (with Live Debug & DOM Diagnostic Export)

document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const solvedBadge = document.getElementById("solvedBadge");
  const resetCountBtn = document.getElementById("resetCountBtn");
  const phaseText = document.getElementById("phaseText");
  const resultPreview = document.getElementById("resultPreview");
  const resultAnswer = document.getElementById("resultAnswer");
  const resultReason = document.getElementById("resultReason");
  const errorBanner = document.getElementById("errorBanner");
  const startStopBtn = document.getElementById("startStopBtn");
  const solveOnceBtn = document.getElementById("solveOnceBtn");

  const providerPreset = document.getElementById("providerPreset");
  const apiFormat = document.getElementById("apiFormat");
  const modelInput = document.getElementById("modelInput");
  const baseUrlInput = document.getElementById("baseUrlInput");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const toggleKeyVisBtn = document.getElementById("toggleKeyVisBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const testApiBtn = document.getElementById("testApiBtn");
  const apiStatusMsg = document.getElementById("apiStatusMsg");
  const sttProviderSelect = document.getElementById("sttProviderSelect");
  const sttApiKeyInput = document.getElementById("sttApiKeyInput");
  const toggleSttKeyVisBtn = document.getElementById("toggleSttKeyVisBtn");
  const localBrowserModelSelect = document.getElementById("localBrowserModelSelect");
  const localSttUrlInput = document.getElementById("localSttUrlInput");
  const sttModeHint = document.getElementById("sttModeHint");
  const testSttBtn = document.getElementById("testSttBtn");
  const sttStatusMsg = document.getElementById("sttStatusMsg");
  const sttTestOutput = document.getElementById("sttTestOutput");

  const STT_MODE_HINTS = {
    auto: "自動: PCサーバー起動中なら最速で使用 → 未起動時はクラウドAPIまたはブラウザ内Whisperを使用します。",
    local_browser: "ブラウザ内Whisper: サーバー不要・APIキー不要。初回のみモデルをダウンロードしてキャッシュします。",
    local_server: "PCローカルサーバー: local-stt/2_ローカル音声サーバー起動.bat を起動した状態で使用します（最高精度・高速）。",
    groq: "Groq Whisper (API): 音声用API Key または Groq APIキーでクラウド文字起こしを行います。",
    gemini: "Google Gemini (API): Gemini APIキーでクラウド音声認識を行います。",
    openai: "OpenAI Whisper (API): OpenAI APIキーでクラウド文字起こしを行います。",
    elevenlabs: "ElevenLabs STT (API): ElevenLabs APIキーでクラウド文字起こしを行います。"
  };

  function updateSttModeHint() {
    if (!sttModeHint || !sttProviderSelect) return;
    const mode = sttProviderSelect.value || "auto";
    sttModeHint.textContent = STT_MODE_HINTS[mode] || STT_MODE_HINTS.auto;
  }

  const stepDelayInput = document.getElementById("stepDelayInput");
  const clickDelayInput = document.getElementById("clickDelayInput");
  const autoSubmitCheck = document.getElementById("autoSubmitCheck");
  const showHudCheck = document.getElementById("showHudCheck");
  const highlightCheck = document.getElementById("highlightCheck");
  const screenshotCheck = document.getElementById("screenshotCheck");
  const customPromptInput = document.getElementById("customPromptInput");

  const inspectDomBtn = document.getElementById("inspectDomBtn");
  const copyDebugReportBtn = document.getElementById("copyDebugReportBtn");
  const debugStatusMsg = document.getElementById("debugStatusMsg");
  const debugLogOutput = document.getElementById("debugLogOutput");

  let activeTabId = null;
  let presets = {};
  let currentSettings = {};
  let isRunning = false;
  let showingManualSnapshot = false;

  // Tab navigation
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  toggleKeyVisBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  if (toggleSttKeyVisBtn) {
    toggleSttKeyVisBtn.addEventListener("click", () => {
      sttApiKeyInput.type = sttApiKeyInput.type === "password" ? "text" : "password";
    });
  }

  function updateApiKeyPlaceholder(presetKey) {
    if (presetKey?.startsWith("gemini")) {
      apiKeyInput.placeholder = "AIza...";
    } else if (presetKey === "groq") {
      apiKeyInput.placeholder = "gsk_...";
    } else if (presetKey === "anthropic") {
      apiKeyInput.placeholder = "sk-ant-...";
    } else {
      apiKeyInput.placeholder = "sk-...";
    }
  }

  function renderState(state) {
    if (!state) return;
    isRunning = Boolean(state.running);
    statusDot.className =
      "status-dot" + (state.error ? " error" : isRunning ? " running" : "");
    solvedBadge.textContent = `${state.solvedCount || 0}問解答`;
    phaseText.textContent = state.phase || (isRunning ? "実行中..." : "待機中");

    if (state.lastAnswerSummary || state.lastReason) {
      resultPreview.classList.remove("hidden");
      resultAnswer.textContent = state.lastAnswerSummary ? `✓ ${state.lastAnswerSummary}` : "";
      resultReason.textContent = state.lastReason || "";
    } else {
      resultPreview.classList.add("hidden");
    }

    if (state.error) {
      errorBanner.classList.remove("hidden");
      errorBanner.textContent = state.error;
    } else {
      errorBanner.classList.add("hidden");
    }

    if (Array.isArray(state.logs) && state.logs.length > 0 && !showingManualSnapshot) {
      debugLogOutput.textContent = state.logs.join("\n");
      debugLogOutput.scrollTop = debugLogOutput.scrollHeight;
    } else if (Array.isArray(state.logs) && state.logs.length === 0 && !showingManualSnapshot) {
      debugLogOutput.textContent = "実行ログ待機中...";
    }

    if (isRunning) {
      startStopBtn.className = "btn btn-danger";
      startStopBtn.textContent = "⏹ 停止する";
      solveOnceBtn.disabled = true;
    } else {
      startStopBtn.className = "btn btn-primary";
      startStopBtn.textContent = "▶ 全自動でしばく";
      solveOnceBtn.disabled = false;
    }
  }

  function populateSettingsUI(s) {
    const presetKey = s.providerPreset || "deepseek";
    providerPreset.value = presetKey;
    apiFormat.value = s.apiFormat || "openai";
    modelInput.value = s.model || "deepseek-chat";
    baseUrlInput.value = s.baseUrl || "https://api.deepseek.com";
    apiKeyInput.value = s.apiKey || "";
    updateApiKeyPlaceholder(presetKey);
    sttProviderSelect.value = s.sttProvider || "auto";
    sttApiKeyInput.value = s.sttApiKey || "";
    if (localBrowserModelSelect) {
      localBrowserModelSelect.value = s.localBrowserModel || "onnx-community/whisper-base.en";
    }
    if (localSttUrlInput) {
      localSttUrlInput.value = s.localSttUrl || "http://127.0.0.1:8765/inference";
    }
    updateSttModeHint();

    stepDelayInput.value = s.stepDelayMs ?? 1400;
    clickDelayInput.value = s.clickDelayMs ?? 650;
    autoSubmitCheck.checked = s.autoSubmit !== false;
    showHudCheck.checked = s.showHud !== false;
    highlightCheck.checked = s.highlightAnswer !== false;
    screenshotCheck.checked = Boolean(s.includeScreenshot);
    customPromptInput.value = s.customPrompt || "";
  }

  function collectSettingsFromUI() {
    const presetKey = providerPreset.value;
    const apiKeysByPreset = {
      ...(currentSettings.apiKeysByPreset || {}),
      [presetKey]: apiKeyInput.value.trim()
    };
    const modelsByPreset = {
      ...(currentSettings.modelsByPreset || {}),
      [presetKey]: modelInput.value.trim()
    };

    return {
      providerPreset: presetKey,
      apiFormat: apiFormat.value,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      apiKeysByPreset,
      model: modelInput.value.trim(),
      modelsByPreset,
      sttProvider: sttProviderSelect.value,
      sttApiKey: sttApiKeyInput.value.trim(),
      localBrowserModel: localBrowserModelSelect
        ? localBrowserModelSelect.value
        : "onnx-community/whisper-base.en",
      localSttUrl:
        (localSttUrlInput ? localSttUrlInput.value.trim() : "") ||
        "http://127.0.0.1:8765/inference",
      stepDelayMs: Math.max(300, Number(stepDelayInput.value) || 1400),
      clickDelayMs: Math.max(150, Number(clickDelayInput.value) || 650),
      autoSubmit: autoSubmitCheck.checked,
      showHud: showHudCheck.checked,
      highlightAnswer: highlightCheck.checked,
      includeScreenshot: screenshotCheck.checked,
      customPrompt: customPromptInput.value
    };
  }

  let saveTimer = null;
  function scheduleSave(showSavedBadge = true) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const next = collectSettingsFromUI();
      const res = await chrome.runtime.sendMessage({
        type: "ELK_SAVE_SETTINGS",
        settings: next
      });
      if (res?.ok) {
        currentSettings = res.settings;
        if (showSavedBadge) {
          apiStatusMsg.className = "save-msg ok";
          apiStatusMsg.textContent = "✓ 保存しました";
        }
      }
    }, 180);
  }

  providerPreset.addEventListener("change", () => {
    const key = providerPreset.value;
    const preset = presets[key];
    updateApiKeyPlaceholder(key);
    if (preset) {
      apiFormat.value = preset.apiFormat;
      if (key !== "custom") {
        baseUrlInput.value = preset.baseUrl;
      }
      const savedModel = currentSettings.modelsByPreset?.[key];
      modelInput.value = savedModel || preset.defaultModel;

      let savedKey = currentSettings.apiKeysByPreset?.[key] || "";
      const deepseekKey = currentSettings.apiKeysByPreset?.deepseek || "";
      if (key.startsWith("gemini") && savedKey && savedKey === deepseekKey && savedKey.startsWith("sk-")) {
        savedKey = "";
      }
      apiKeyInput.value = savedKey;
    }
    scheduleSave(true);
  });

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      clearTimeout(saveTimer);
      const next = collectSettingsFromUI();
      const res = await chrome.runtime.sendMessage({
        type: "ELK_SAVE_SETTINGS",
        settings: next
      });
      if (res?.ok) {
        currentSettings = res.settings;
        apiStatusMsg.className = "save-msg ok";
        apiStatusMsg.textContent = "✓ 設定を保存しました！";
      }
    });
  }

  [
    apiFormat,
    modelInput,
    baseUrlInput,
    apiKeyInput,
    sttProviderSelect,
    sttApiKeyInput,
    localBrowserModelSelect,
    localSttUrlInput,
    stepDelayInput,
    clickDelayInput,
    autoSubmitCheck,
    showHudCheck,
    highlightCheck,
    screenshotCheck,
    customPromptInput
  ].forEach((el) => {
    el.addEventListener("input", () => scheduleSave(true));
    el.addEventListener("change", () => scheduleSave(true));
  });

  testApiBtn.addEventListener("click", async () => {
    const next = collectSettingsFromUI();
    await chrome.runtime.sendMessage({ type: "ELK_SAVE_SETTINGS", settings: next });
    currentSettings = { ...currentSettings, ...next };

    testApiBtn.disabled = true;
    apiStatusMsg.className = "save-msg";
    apiStatusMsg.textContent = "接続テスト中...";

    try {
      const res = await chrome.runtime.sendMessage({
        type: "ELK_TEST_API",
        settings: next
      });
      if (res?.ok) {
        apiStatusMsg.className = "save-msg ok";
        apiStatusMsg.textContent = `✓ 接続OK (${next.model})`;
      } else {
        apiStatusMsg.className = "save-msg err";
        apiStatusMsg.textContent = "✗ 失敗";
        errorBanner.classList.remove("hidden");
        errorBanner.textContent = res?.error || "接続テストに失敗しました";
      }
    } catch (err) {
      apiStatusMsg.className = "save-msg err";
      apiStatusMsg.textContent = "✗ エラー";
      errorBanner.classList.remove("hidden");
      errorBanner.textContent = err?.message || String(err);
    } finally {
      testApiBtn.disabled = false;
    }
  });

  if (sttProviderSelect) {
    sttProviderSelect.addEventListener("change", updateSttModeHint);
  }

  if (testSttBtn) {
    testSttBtn.addEventListener("click", async () => {
      const next = collectSettingsFromUI();
      await chrome.runtime.sendMessage({ type: "ELK_SAVE_SETTINGS", settings: next });
      currentSettings = { ...currentSettings, ...next };

      testSttBtn.disabled = true;
      sttStatusMsg.className = "save-msg";
      sttStatusMsg.textContent = "音声抽出＆文字起こしテスト中...";
      sttTestOutput.classList.remove("hidden");
      sttTestOutput.textContent =
        "テスト実行中 (最大25秒 / 初回DL時はモデル取得完了まで待機)...";

      try {
        const res = await chrome.runtime.sendMessage({
          type: "ELK_TEST_STT",
          settings: next,
          tabId: activeTabId
        });
        if (res?.ok) {
          sttStatusMsg.className = "save-msg ok";
          sttStatusMsg.textContent = `✓ 成功 (${res.elapsedMs}ms)`;
          sttTestOutput.textContent = res.report || res.transcript || "成功";
        } else {
          sttStatusMsg.className = "save-msg err";
          sttStatusMsg.textContent = "✗ 文字起こし失敗";
          sttTestOutput.textContent = res?.report || res?.error || "失敗";
        }
      } catch (err) {
        sttStatusMsg.className = "save-msg err";
        sttStatusMsg.textContent = "✗ エラー";
        sttTestOutput.textContent = err?.message || String(err);
      } finally {
        testSttBtn.disabled = false;
      }
    });
  }

  // Debug buttons
  inspectDomBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    showingManualSnapshot = true;
    debugStatusMsg.className = "save-msg";
    debugStatusMsg.textContent = "現在の画面DOMを解析中...";
    const res = await chrome.runtime.sendMessage({
      type: "ELK_BUILD_DEBUG_REPORT",
      tabId: activeTabId
    });
    if (res?.ok && res.report) {
      debugLogOutput.textContent = res.report;
      debugLogOutput.scrollTop = 0;
      debugStatusMsg.className = "save-msg ok";
      debugStatusMsg.textContent = "✓ 画面DOM診断を表示しました";
    } else {
      debugStatusMsg.className = "save-msg err";
      debugStatusMsg.textContent = "✗ 診断失敗: " + (res?.error || "不明");
    }
  });

  copyDebugReportBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    debugStatusMsg.className = "save-msg";
    debugStatusMsg.textContent = "診断レポートを生成中...";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "ELK_BUILD_DEBUG_REPORT",
        tabId: activeTabId
      });
      if (res?.ok && res.report) {
        await navigator.clipboard.writeText(res.report);
        showingManualSnapshot = true;
        debugLogOutput.textContent = res.report;
        debugStatusMsg.className = "save-msg ok";
        debugStatusMsg.textContent =
          "✓ クリップボードにコピーしました！そのままチャットに貼り付けてください";
      } else {
        debugStatusMsg.className = "save-msg err";
        debugStatusMsg.textContent = "✗ 失敗: " + (res?.error || "不明");
      }
    } catch (err) {
      debugStatusMsg.className = "save-msg err";
      debugStatusMsg.textContent = "✗ コピー失敗: " + (err?.message || String(err));
    }
  });

  function ensureApiKeyReady() {
    const preset = providerPreset.value;
    if (!apiKeyInput.value.trim() && preset !== "ollama" && preset !== "custom") {
      errorBanner.classList.remove("hidden");
      errorBanner.textContent = "先にAPI Keyを入力してください（DeepSeek等のキー）";
      apiKeyInput.focus();
      return false;
    }
    return true;
  }

  startStopBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    showingManualSnapshot = false;
    if (isRunning) {
      await chrome.runtime.sendMessage({ type: "ELK_STOP", tabId: activeTabId });
      return;
    }
    if (!ensureApiKeyReady()) return;

    const next = collectSettingsFromUI();
    await chrome.runtime.sendMessage({ type: "ELK_SAVE_SETTINGS", settings: next });
    await chrome.runtime.sendMessage({ type: "ELK_START_AUTO", tabId: activeTabId });
  });

  solveOnceBtn.addEventListener("click", async () => {
    if (!activeTabId || isRunning) return;
    showingManualSnapshot = false;
    if (!ensureApiKeyReady()) return;

    const next = collectSettingsFromUI();
    await chrome.runtime.sendMessage({ type: "ELK_SAVE_SETTINGS", settings: next });
    await chrome.runtime.sendMessage({ type: "ELK_SOLVE_ONCE", tabId: activeTabId });
  });

  resetCountBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    showingManualSnapshot = false;
    await chrome.runtime.sendMessage({ type: "ELK_RESET_COUNT", tabId: activeTabId });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ELK_STATUS_UPDATE" && msg.state?.tabId === activeTabId) {
      renderState(msg.state);
    }
    if (msg.type === "ELK_LOCAL_STT_PROGRESS" && testSttBtn?.disabled && sttStatusMsg) {
      const pct = typeof msg.progress === "number" ? ` (${Math.round(msg.progress)}%)` : "";
      const detail = msg.status || msg.message || msg.file || "モデル準備中";
      sttStatusMsg.textContent = `ローカルWhisper: ${detail}${pct}`;
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;

  const initRes = await chrome.runtime.sendMessage({
    type: "ELK_GET_INIT",
    tabId: activeTabId
  });

  if (initRes?.ok) {
    presets = initRes.presets || {};
    currentSettings = initRes.settings || {};
    populateSettingsUI(currentSettings);
    if (initRes.state) renderState(initRes.state);
  }
});
