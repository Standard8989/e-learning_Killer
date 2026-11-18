// background.js - e-learning Killer Service Worker (MV3) with Live Debug Logger & DOM Report

const PRESETS = {
  deepseek: {
    label: "DeepSeek",
    apiFormat: "openai",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash"
  },
  openai: {
    label: "OpenAI",
    apiFormat: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini"
  },
  gemini_openai: {
    label: "Google Gemini (OpenAI互換)",
    apiFormat: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash"
  },
  gemini_native: {
    label: "Google Gemini (Native API)",
    apiFormat: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash"
  },
  anthropic: {
    label: "Anthropic Claude",
    apiFormat: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-haiku-latest"
  },
  openrouter: {
    label: "OpenRouter",
    apiFormat: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-chat"
  },
  groq: {
    label: "Groq",
    apiFormat: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile"
  },
  ollama: {
    label: "Ollama (ローカルLLM)",
    apiFormat: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:14b"
  },
  custom: {
    label: "カスタム (任意のOpenAI互換API)",
    apiFormat: "openai",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat"
  }
};

const DEFAULT_SETTINGS = {
  providerPreset: "deepseek",
  apiFormat: "openai",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  apiKeysByPreset: {},
  model: "deepseek-flash",
  modelsByPreset: {},
  sttProvider: "auto",
  sttApiKey: "",
  localSttUrl: "http://127.0.0.1:8765/inference",
  localBrowserModel: "onnx-community/whisper-base.en",
  autoSubmit: true,
  stepDelayMs: 1400,
  clickDelayMs: 650,
  maxSteps: 200,
  showHud: true,
  highlightAnswer: true,
  includeScreenshot: false,
  customPrompt: ""
};

const tabSessions = new Map();
const audioTranscriptCache = new Map();
const deadLocalSttUrls = new Map();
let transcriptCacheLoaded = false;

async function ensureTranscriptCacheLoaded() {
  if (transcriptCacheLoaded) return;
  transcriptCacheLoaded = true;
  try {
    const res = await chrome.storage.local.get("elkTranscriptCache");
    const saved = res?.elkTranscriptCache;
    if (saved && typeof saved === "object") {
      for (const [k, entry] of Object.entries(saved)) {
        if (entry && typeof entry.text === "string" && entry.text) {
          audioTranscriptCache.set(k, entry.text);
        }
      }
    }
  } catch (_) {}
}

async function persistTranscriptKeys(keys, text) {
  if (!text) return;
  const cleanKeys = (Array.isArray(keys) ? keys : [keys]).filter(
    (k) => typeof k === "string" && k.length > 0 && !k.startsWith("page:")
  );
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    if (k) audioTranscriptCache.set(k, text);
  }
  if (cleanKeys.length === 0) return;
  try {
    const res = await chrome.storage.local.get("elkTranscriptCache");
    const mapObj = res?.elkTranscriptCache && typeof res.elkTranscriptCache === "object"
      ? { ...res.elkTranscriptCache }
      : {};
    const now = Date.now();
    for (const k of cleanKeys) {
      mapObj[k] = { text, ts: now };
    }
    const entries = Object.entries(mapObj)
      .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
      .slice(0, 60);
    await chrome.storage.local.set({ elkTranscriptCache: Object.fromEntries(entries) });
  } catch (_) {}
}

function createEmptyUsage() {
  return {
    llmCalls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    sttCalls: 0,
    audioCacheHits: 0
  };
}

function recordSessionUsage(session, usage) {
  if (!session || !usage) return;
  if (!session.usage) session.usage = createEmptyUsage();
  session.usage.llmCalls += 1;
  session.usage.promptTokens += Number(usage.promptTokens) || 0;
  session.usage.cachedTokens += Number(usage.cachedTokens) || 0;
  session.usage.completionTokens += Number(usage.completionTokens) || 0;
  session.usage.reasoningTokens += Number(usage.reasoningTokens) || 0;
}

function extractTokenUsage(apiFormat, data) {
  if (!data || typeof data !== "object") return null;
  if (apiFormat === "openai" && data.usage) {
    const u = data.usage;
    return {
      promptTokens: Number(u.prompt_tokens) || 0,
      cachedTokens:
        Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens) || 0,
      completionTokens: Number(u.completion_tokens) || 0,
      reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens) || 0
    };
  }
  if (apiFormat === "anthropic" && data.usage) {
    const u = data.usage;
    return {
      promptTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
      cachedTokens: Number(u.cache_read_input_tokens) || 0,
      completionTokens: Number(u.output_tokens) || 0,
      reasoningTokens: 0
    };
  }
  if (apiFormat === "gemini" && data.usageMetadata) {
    const m = data.usageMetadata;
    return {
      promptTokens: Number(m.promptTokenCount) || 0,
      cachedTokens: Number(m.cachedContentTokenCount) || 0,
      completionTokens: Number(m.candidatesTokenCount) || 0,
      reasoningTokens: Number(m.thoughtsTokenCount) || 0
    };
  }
  return null;
}

function computeAudioFingerprint(audioRes) {
  const b64 = String(audioRes?.base64 || "");
  if (!b64) return "";
  const len = b64.length;
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  const step = Math.max(1, Math.floor(len / 96));
  for (let i = 0; i < len; i += step) {
    const end = Math.min(len, i + 12);
    for (let j = i; j < end; j++) {
      const code = b64.charCodeAt(j);
      h1 ^= code;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = ((h2 << 5) - h2 + code) >>> 0;
    }
  }
  return `audioHash:${len}:${h1.toString(16)}_${h2.toString(16)}`;
}

function nowTimeStr() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function getOrCreateSession(tabId) {
  if (!tabSessions.has(tabId)) {
    tabSessions.set(tabId, {
      tabId,
      running: false,
      mode: "idle",
      phase: "待機中",
      solvedCount: 0,
      stepCount: 0,
      lastPageUrl: "",
      answeredBlockKeys: new Set(),
      playedMediaCardKeys: new Set(),
      sawSequentialCardLock: false,
      lastPlayedMediaAt: 0,
      audioWaitConsecutive: 0,
      recordingWaitOnce: false,
      lastAnsweredBaseKey: null,
      lastAnsweredAt: 0,
      waitedForSameKey: false,
      lastClearedTileHash: null,
      courseHomeUrl: "",
      lastStartedCourseLessonKey: "",
      attemptedCourseLessonKeys: new Set(),
      courseLessonRetryCounts: new Map(),
      lessonStepCount: 0,
      courseWaitCount: 0,
      courseScrolledOnce: false,
      courseReturnAttempts: 0,
      consecutiveStepErrors: 0,
      lastStateHash: null,
      sameStateCount: 0,
      lastReason: "",
      lastAnswerSummary: "",
      usage: createEmptyUsage(),
      error: null,
      logs: [],
      abortController: null
    });
  }
  return tabSessions.get(tabId);
}

function deriveCourseUrl(rawUrl, fallbackHomeUrl = "") {
  const str = String(rawUrl || "").trim();
  const fallback = String(fallbackHomeUrl || "").trim();
  if (!str) return fallback;
  try {
    const parsed = new URL(str);
    const match = parsed.pathname.match(/^(.*\/courses\/[^/?#]+)/i);
    if (!match) return fallback;
    const baseCoursePath = match[1].replace(/\/+$/, "");
    if (fallback) {
      try {
        const fbUrl = new URL(fallback);
        if (fbUrl.origin === parsed.origin && fbUrl.pathname.replace(/\/+$/, "") === baseCoursePath) {
          return fallback;
        }
      } catch (_) {}
    }
    const locale = parsed.searchParams.get("locale");
    return `${parsed.origin}${baseCoursePath}${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`;
  } catch (_) {
    return fallback;
  }
}

const COMPLETION_TEXT_REGEX =
  /(レッスン完了|レッスン終了|トレーニング完了|テスト完了|学習完了|(?:テスト|レッスン)に合格しました|不合格|congratulations|lesson\s*complete)/i;

function extractLessonId(rawUrl) {
  const match = String(rawUrl || "").match(/\/lessons\/([^/?#]+)/i);
  return match ? match[1] : "";
}

async function handleLessonCompletionTransition(
  tabId,
  session,
  frameData,
  isAutoMode,
  logTag = "DONE",
  customPhase = ""
) {
  const courseUrl = deriveCourseUrl(frameData.url, session.courseHomeUrl);
  if (isAutoMode && !frameData.isCourseDashboard && courseUrl) {
    resetPerLessonState(session);
    session.lessonStepCount = 0;
    session.sameStateCount = 0;
    session.lastStateHash = null;
    session.courseReturnAttempts = 0;
    session.phase = customPhase || "🏠 レッスン完了 → コース画面へ戻っています...";
    session.lastAnswerSummary = customPhase ? "テスト不合格 (再挑戦準備)" : "レッスン完了 (次レッスンへ移動)";
    appendLog(session, `${logTag} LESSON -> コース画面へ戻る: ${courseUrl}`);
    await broadcastStatus(tabId);
    await chrome.tabs.update(tabId, { url: courseUrl });
    return { done: false, customNextDelayMs: 1600 };
  }
  session.phase = "全問完了しました！";
  session.lastAnswerSummary = "テスト完了を検出しました";
  appendLog(session, `${logTag}: 完了画面を検出したため終了`);
  await broadcastStatus(tabId);
  return { done: true };
}

function resetPerLessonState(session) {
  session.answeredBlockKeys.clear();
  session.playedMediaCardKeys.clear();
  session.sawSequentialCardLock = false;
  session.lastPlayedMediaAt = 0;
  session.audioWaitConsecutive = 0;
  session.recordingWaitOnce = false;
  session.waitedForSameKey = false;
  session.lastAnsweredBaseKey = null;
  session.lastClearedTileHash = null;
}

async function waitForTabUrlTransition(tabId, checkFn, signal, maxWaitMs = 2200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (signal?.aborted) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && checkFn(tab.url)) return true;
    } catch (_) {
      return false;
    }
    await sleep(300, signal);
  }
  return false;
}

function appendLog(session, line) {
  const entry = `[${nowTimeStr()}] ${line}`;
  session.logs.push(entry);
  if (session.logs.length > 80) {
    session.logs.splice(0, session.logs.length - 80);
  }
}

function serializeSessionState(session) {
  return {
    tabId: session.tabId,
    running: session.running,
    mode: session.mode,
    phase: session.phase,
    solvedCount: session.solvedCount,
    stepCount: session.stepCount,
    lastReason: session.lastReason,
    lastAnswerSummary: session.lastAnswerSummary,
    usage: session.usage ? { ...session.usage } : createEmptyUsage(),
    error: session.error,
    logs: session.logs.slice(-40)
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get("elkSettings");
  return { ...DEFAULT_SETTINGS, ...(stored.elkSettings || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await chrome.storage.local.set({ elkSettings: merged });
  return merged;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let keepAliveTimer = null;
    const cleanup = () => {
      if (keepAliveTimer !== null) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (ms > 15000 && typeof chrome?.runtime?.getPlatformInfo === "function") {
      keepAliveTimer = setInterval(() => {
        try {
          chrome.runtime.getPlatformInfo(() => {});
        } catch (_) {}
      }, 15000);
    }
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          cleanup();
          resolve();
        },
        { once: true }
      );
    }
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000, externalSignal = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout(${timeoutMs}ms)`)), timeoutMs);
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function sendMessageWithTimeout(tabId, message, options = {}, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: `タブ通信タイムアウト (${timeoutMs}ms)` });
    }, timeoutMs);
    chrome.tabs
      .sendMessage(tabId, message, options)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err?.message || String(err) });
      });
  });
}

function arrayBufferToBase64Bg(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchAudioInBackground(url, signal) {
  if (!url || !/^https?:/i.test(url)) return null;
  const res = await fetchWithTimeout(url, { cache: "no-store" }, 6000, signal);
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  const mimeType =
    contentType && contentType.startsWith("audio/")
      ? contentType
      : /\.m4a(\?|$)/i.test(url)
      ? "audio/mp4"
      : /\.wav(\?|$)/i.test(url)
      ? "audio/wav"
      : /\.ogg(\?|$)/i.test(url)
      ? "audio/ogg"
      : "audio/mpeg";
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 20 * 1024 * 1024) return null;
  return {
    ok: true,
    url,
    mimeType,
    sizeBytes: buf.byteLength,
    base64: arrayBufferToBase64Bg(buf)
  };
}

async function broadcastStatus(tabId) {
  const session = getOrCreateSession(tabId);
  const payload = {
    type: "ELK_STATUS_UPDATE",
    state: serializeSessionState(session)
  };

  try {
    await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
  } catch (_) {}

  try {
    await chrome.runtime.sendMessage(payload);
  } catch (_) {}
}

// Injected into the page's MAIN JS world to stamp React Fiber audio/hints onto question cards and capture Web Audio / HTML5 Audio
function installMainWorldAudioHook() {
  const isSfx = (u) =>
    !u ||
    /\/app\/audio\/|\/(question_correct|question_incorrect|question_answered|activity_done|item_done|key_tap|got_green_check_mark|got_gold_check_mark|beep|click|ding|sfx)\.(mp3|m4a|wav|ogg|aac)(\?|$|#)/i.test(
      u
    );

  // Build lookup of preloaded content audio URLs by filename basename
  const preloadedAudioByBasename = new Map();
  try {
    const entries = performance.getEntriesByType("resource") || [];
    for (const e of entries) {
      const name = e.name || "";
      if (!isSfx(name) && /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$|#)/i.test(name)) {
        const base = name.split("?")[0].split("/").pop();
        if (base) preloadedAudioByBasename.set(base.toLowerCase(), name);
      }
    }
  } catch (_) {}

  const resolveAudioString = (raw) => {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (s.length < 4 || s.length > 450) return null;
    const m = s.match(/([a-zA-Z0-9_.-]+\.(?:mp3|m4a|wav|ogg|aac|flac|opus))(\?[^\s"'<>]*)?/i);
    if (!m) return null;
    const base = m[1].toLowerCase();
    if (preloadedAudioByBasename.has(base)) {
      return preloadedAudioByBasename.get(base);
    }
    try {
      const full = new URL(s, location.href).href;
      if (!isSfx(full)) return full;
    } catch (_) {}
    return null;
  };

  // Stamp per-card audio URLs & hints from MAIN-world React Fiber (__reactFiber$ / __reactProps$) onto DOM attributes
  try {
    const cards = document.querySelectorAll('[id^="interaction-"]');
    const SKIP_KEYS = new Set([
      "_owner",
      "stateNode",
      "return",
      "child",
      "sibling",
      "alternate",
      "dependencies",
      "_store",
      "ref"
    ]);

    const inspectFiberLevel = (fiber) => {
      const levelUrls = new Set();
      const levelHints = [];
      const seen = new WeakSet();

      const walkObj = (obj, depth) => {
        if (!obj || typeof obj !== "object" || depth > 9 || seen.has(obj)) return;
        if (obj instanceof Node || obj instanceof Window) return;
        seen.add(obj);

        const keys = Object.keys(obj);
        for (let i = 0; i < Math.min(keys.length, 60); i++) {
          const k = keys[i];
          if (SKIP_KEYS.has(k)) continue;
          let v;
          try {
            v = obj[k];
          } catch (_) {
            continue;
          }
          if (typeof v === "string") {
            const audioMatch = resolveAudioString(v);
            if (audioMatch) {
              levelUrls.add(audioMatch);
            } else if (
              /^(transcript|script|audioScript|dialogue|narration|explanation|feedback|commentary|rationale|sentence|example|correctAnswer|solution)$/i.test(
                k
              ) &&
              v.trim().length >= 2 &&
              v.trim().length <= 1500
            ) {
              const clean = v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              if (clean && !levelHints.includes(`${k}: ${clean}`)) {
                levelHints.push(`${k}: ${clean}`);
              }
            }
          } else if (v && typeof v === "object") {
            walkObj(v, depth + 1);
          }
        }
      };

      if (fiber.memoizedProps) walkObj(fiber.memoizedProps, 0);
      let hook = fiber.memoizedState;
      let hCount = 0;
      while (hook && typeof hook === "object" && hCount < 25) {
        walkObj(hook.memoizedState !== undefined ? hook.memoizedState : hook, 0);
        hook = hook.next;
        hCount++;
      }

      return { levelUrls, levelHints };
    };

    cards.forEach((card) => {
      if (card.getAttribute("data-elk-fiber-audio")) return;

      let foundUrl = null;
      const foundHints = [];

      const els = [card, ...Array.from(card.querySelectorAll("*")).slice(0, 50)];
      for (const el of els) {
        if (foundUrl) break;
        const rks = Object.keys(el);
        for (const rk of rks) {
          if (rk.startsWith("__reactFiber$") || rk.startsWith("__reactProps$")) {
            let f = el[rk];
            let up = 0;
            while (f && up < 18) {
              // Stop if this fiber belongs to an ancestor DOM container that holds multiple interaction cards
              if (
                f.stateNode instanceof Element &&
                f.stateNode !== card &&
                !card.contains(f.stateNode) &&
                f.stateNode.querySelectorAll('[id^="interaction-"]').length > 1
              ) {
                break;
              }
              const { levelUrls, levelHints } = inspectFiberLevel(f);
              if (levelUrls.size > 1) {
                // Reached parent list holding multiple questions' audio URLs -> stop ascending
                break;
              }
              for (const h of levelHints) {
                if (!foundHints.includes(h)) foundHints.push(h);
              }
              if (levelUrls.size === 1) {
                foundUrl = Array.from(levelUrls)[0];
                break;
              }
              f = f.return;
              up++;
            }
          }
        }
      }

      if (foundUrl) {
        card.setAttribute("data-elk-fiber-audio", foundUrl);
      }
      if (foundHints.length > 0) {
        card.setAttribute("data-elk-fiber-hint", foundHints.join(" | ").slice(0, 2000));
      }
    });

    // Also stamp shared/fixed-bottom audio player outside [id^="interaction-"] cards (keyed to current URL!)
    const prevSharedHref = document.documentElement.getAttribute("data-elk-shared-fiber-href");
    if (prevSharedHref !== location.href) {
      document.documentElement.removeAttribute("data-elk-shared-fiber-audio");
      document.documentElement.removeAttribute("data-elk-shared-fiber-hint");
      document.documentElement.removeAttribute("data-elk-shared-fiber-href");
      document.documentElement.removeAttribute("data-elk-last-audio");
    }
    if (!document.documentElement.getAttribute("data-elk-shared-fiber-audio")) {
      const playerSeeds = new Set(Array.from(document.querySelectorAll("audio, video, source")));
      document.querySelectorAll("div, span, button").forEach((el) => {
        if (playerSeeds.size > 16 || el.closest('[id^="interaction-"]')) return;
        const txt = (el.textContent || "").trim();
        if (txt.length <= 16 && /\b00:\d{2}\b/.test(txt)) {
          playerSeeds.add(el);
          if (el.parentElement) playerSeeds.add(el.parentElement);
        }
      });

      let sharedUrl = null;
      const sharedHints = [];
      for (const seed of playerSeeds) {
        if (sharedUrl) break;
        const rks = Object.keys(seed);
        for (const rk of rks) {
          if (rk.startsWith("__reactFiber$") || rk.startsWith("__reactProps$")) {
            let f = seed[rk];
            let up = 0;
            while (f && up < 16) {
              const { levelUrls, levelHints } = inspectFiberLevel(f);
              for (const h of levelHints) {
                if (!sharedHints.includes(h)) sharedHints.push(h);
              }
              if (levelUrls.size === 1) {
                sharedUrl = Array.from(levelUrls)[0];
                break;
              }
              if (levelUrls.size > 1) break;
              f = f.return;
              up++;
            }
          }
          if (sharedUrl) break;
        }
      }
      if (sharedUrl) {
        document.documentElement.setAttribute("data-elk-shared-fiber-audio", sharedUrl);
        document.documentElement.setAttribute("data-elk-shared-fiber-href", location.href);
      }
      if (sharedHints.length > 0) {
        document.documentElement.setAttribute(
          "data-elk-shared-fiber-hint",
          sharedHints.join(" | ").slice(0, 2000)
        );
      }
    }
  } catch (_) {}

  if (window.__ELK_MAIN_AUDIO_HOOK_V4__) return;
  window.__ELK_MAIN_AUDIO_HOOK_V4__ = true;

  // Encode a Web Audio API AudioBuffer into a 16kHz mono 16-bit PCM WAV Base64 string in ~2ms!
  const audioBufferToWavBase64 = (audioBuffer) => {
    const srcRate = audioBuffer.sampleRate || 44100;
    const targetRate = Math.min(16000, srcRate);
    const ratio = srcRate / targetRate;
    const srcLen = audioBuffer.length;
    const outLen = Math.floor(srcLen / ratio);
    if (outLen <= 0 || outLen > 16000 * 120) return null;

    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;

    const buffer = new ArrayBuffer(44 + outLen * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + outLen * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, outLen * 2, true);

    let offset = 44;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(srcLen - 1, Math.floor(i * ratio));
      let sample = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  // Hook Web Audio API AudioBufferSourceNode.prototype.start to capture preloaded Web Audio buffers!
  try {
    if (typeof AudioBufferSourceNode !== "undefined" && AudioBufferSourceNode.prototype.start) {
      const origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        try {
          const buf = this.buffer;
          if (buf && buf.duration >= 0.55 && buf.duration <= 120) {
            const wavB64 = audioBufferToWavBase64(buf);
            if (wavB64) {
              document.documentElement.setAttribute("data-elk-captured-wav", wavB64);
            }
          }
        } catch (_) {}
        return origStart.apply(this, args);
      };
    }
  } catch (_) {}

  const recordAudioUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== "string") return;
    try {
      const full = new URL(rawUrl, location.href).href;
      if (!isSfx(full)) {
        document.documentElement.setAttribute("data-elk-last-audio", full);
      }
    } catch (_) {}
  };

  const getMediaSrc = (el) => {
    if (!el) return "";
    const sourceEl = el.querySelector ? el.querySelector("source[src]") : null;
    return (
      (sourceEl && (sourceEl.src || sourceEl.getAttribute("src"))) ||
      el.currentSrc ||
      el.src ||
      (el.getAttribute && el.getAttribute("src")) ||
      ""
    );
  };

  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try {
        const src = getMediaSrc(this);
        if (src) recordAudioUrl(src);
        this.addEventListener("loadstart", () => recordAudioUrl(getMediaSrc(this)), { once: true });
        this.addEventListener("playing", () => recordAudioUrl(getMediaSrc(this)), { once: true });
      } catch (_) {}
      return origPlay.apply(this, args);
    };
  } catch (_) {}

  try {
    const OrigAudio = window.Audio;
    if (typeof OrigAudio === "function") {
      window.Audio = function (src, ...rest) {
        if (src) recordAudioUrl(src);
        return new OrigAudio(src, ...rest);
      };
      window.Audio.prototype = OrigAudio.prototype;
    }
  } catch (_) {}

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (typeof url === "string" && /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$)/i.test(url)) {
        recordAudioUrl(url);
      }
      return origOpen.call(this, method, url, ...rest);
    };
  } catch (_) {}

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, ...rest) {
        const u = typeof input === "string" ? input : input?.url || "";
        if (typeof u === "string" && /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$)/i.test(u)) {
          recordAudioUrl(u);
        }
        return origFetch.call(this, input, ...rest);
      };
    }
  } catch (_) {}
}

async function ensureContentScripts(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: installMainWorldAudioHook
    })
    .catch(() => {});

  try {
    await chrome.tabs.sendMessage(tabId, { type: "ELK_PING" }, { frameId: 0 });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"]
      });
      await sleep(150);
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function waitForTabReady(tabId, signal, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return false;
      if (tab.status === "complete") return true;
    } catch (_) {
      return false;
    }
    await sleep(250, signal);
  }
  return true;
}

async function scanBestFrame(
  tabId,
  answeredBlockKeys = [],
  includeFullDebug = false,
  playedMediaCardKeys = []
) {
  await ensureContentScripts(tabId);

  let frames = [{ frameId: 0 }];
  try {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(allFrames) && allFrames.length > 0) {
      frames = allFrames;
    }
  } catch (_) {}

  const candidates = [];
  for (const frame of frames) {
    try {
      const res = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "ELK_EXTRACT_STATE",
          answeredBlockKeys,
          includeFullDebug,
          playedMediaCardKeys
        },
        { frameId: frame.frameId }
      );
      if (res && res.ok && res.data) {
        candidates.push({
          frameId: frame.frameId,
          url: frame.url || "",
          data: res.data
        });
      }
    } catch (_) {}
  }

  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = -1;

  for (const c of candidates) {
    const d = c.data;
    let score = 0;
    score += (d.options || []).length * 40;
    score += (d.questionSummary?.lockedCount || 0) * 15;
    score += (d.questionSummary?.answeredCount || 0) * 8;
    score += (d.selects || []).length * 30;
    score += (d.textInputs || []).length * 30;
    score += (d.inlineInputPills || []).length * 12;
    score += (d.mediaCards?.totalCount || 0) * 18;
    score += (d.courseLessons || []).length * 25;
    if (d.isCourseDashboard) score += 20;
    if (d.courseReturnBtn) score += 15;
    score += (d.buttons || []).filter((b) => b.kind === "submit" || b.kind === "next").length * 14;
    score += Math.min((d.pageText || "").length, 2000) / 100;
    if (d.hasQuizKeywords) score += 20;
    if (c.frameId === 0) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  best.totalFramesScanned = candidates.length;
  return best;
}

function parseJsonFromLLM(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("AIからの応答が空でした");
  }

  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf("{");
    if (start === -1) {
      throw new Error("AI応答からJSONを抽出できませんでした: " + cleaned.slice(0, 120));
    }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return JSON.parse(cleaned.slice(start, i + 1));
          }
        }
      }
    }
    throw new Error("AI応答のJSON形式が不正です: " + cleaned.slice(0, 120));
  }
}

function parseRetryAfterMs(res, errText = "") {
  try {
    const raw = res?.headers?.get?.("retry-after");
    if (raw) {
      const secs = Number(raw);
      if (!Number.isNaN(secs) && secs > 0) return Math.min(45000, Math.round(secs * 1000));
    }
  } catch (_) {}
  try {
    const textMatch = String(errText || "").match(/try again in\s+([\d.]+)\s*(ms|s)\b/i);
    if (textMatch) {
      const val = Number(textMatch[1]);
      if (!Number.isNaN(val) && val > 0) {
        const ms = textMatch[2].toLowerCase() === "ms" ? val : val * 1000;
        return Math.min(45000, Math.round(ms + 400));
      }
    }
  } catch (_) {}
  return 0;
}

function makeLlmError(
  message,
  {
    retryable = true,
    retryAfterMs = 0,
    disableJsonMode = false,
    disableReasoningEffort = false,
    bumpMinMaxTokens = 0
  } = {}
) {
  const err = new Error(message);
  err.retryable = retryable;
  err.retryAfterMs = retryAfterMs;
  err.disableJsonMode = disableJsonMode;
  err.disableReasoningEffort = disableReasoningEffort;
  err.bumpMinMaxTokens = bumpMinMaxTokens;
  return err;
}

async function callLLMSingleAttempt(
  settings,
  systemPrompt,
  userPrompt,
  screenshotDataUrl,
  signal,
  maxOutputTokens = 0,
  attemptOpts = {}
) {
  const apiFormat = settings.apiFormat || "openai";
  const baseUrl = (settings.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (settings.apiKey || "").trim();
  const model = (settings.model || "").trim();
  const {
    forceJsonMode = true,
    allowReasoningEffort = true,
    temperatureOverride = null,
    minMaxTokens = 0,
    timeoutMs = 45000,
    onUsage = null
  } = attemptOpts;

  if (!baseUrl) throw makeLlmError("Base URLが設定されていません", { retryable: false });
  if (!model) throw makeLlmError("モデル名が設定されていません", { retryable: false });
  if (!apiKey && settings.providerPreset !== "ollama" && settings.providerPreset !== "custom") {
    throw makeLlmError("APIキーが未設定です。拡張機能ポップアップの「API設定」から入力してください。", {
      retryable: false
    });
  }

  if (apiFormat === "openai") {
    const endpoint = baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const userContent = screenshotDataUrl
      ? [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: screenshotDataUrl } }
        ]
      : userPrompt;

    const isStrictReasoner = /reasoner|deepseek-r1|qwq|^o[134](?:-|$)|\bgpt-5/i.test(model);
    const isDeepSeekDefaultThinking =
      baseUrl.includes("api.deepseek.com") ||
      /^deepseek-(?:flash|v4|chat)/i.test(model);
    const isThinkingModel =
      isStrictReasoner ||
      isDeepSeekDefaultThinking ||
      /\bgpt-oss\b|qwen3|thinking|gemini-2\.[59]|gemini-3/i.test(model);
    const supportsLowEffort =
      (!isStrictReasoner && isDeepSeekDefaultThinking) ||
      /\bgpt-oss\b|gemini-2\.[59]|gemini-3/i.test(model);
    const thinkingFloor = isThinkingModel ? 2048 : 0;
    const effectiveMaxTokens = Math.max(
      Number(maxOutputTokens) || 0,
      Number(minMaxTokens) || 0,
      thinkingFloor
    );

    const buildBody = (useJsonMode, useReasoningEffort) => {
      const body = {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      };
      if (!isStrictReasoner) {
        body.temperature = temperatureOverride != null ? temperatureOverride : 0.0;
        if (effectiveMaxTokens > 0) {
          body.max_tokens = useJsonMode
            ? effectiveMaxTokens
            : Math.max(effectiveMaxTokens, 1400);
        }
      }
      if (useReasoningEffort && supportsLowEffort) {
        body.reasoning_effort = "low";
      }
      if (useJsonMode && !isStrictReasoner) {
        body.response_format = { type: "json_object" };
      }
      return body;
    };

    let currentJsonMode = forceJsonMode;
    let currentReasoningEffort = allowReasoningEffort;
    let res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(buildBody(currentJsonMode, currentReasoningEffort))
      },
      timeoutMs,
      signal
    );

    if (res.status === 404 && baseUrl.includes("generativelanguage.googleapis.com")) {
      const discovered = await discoverGeminiModels(apiKey, signal).catch(() => null);
      if (discovered && discovered.models.length > 0) {
        for (const fallbackModel of discovered.models.slice(0, 3)) {
          const retryBody = buildBody(currentJsonMode, currentReasoningEffort);
          retryBody.model = fallbackModel;
          res = await fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers,
              body: JSON.stringify(retryBody)
            },
            timeoutMs,
            signal
          );
          if (res.status !== 404) break;
        }
      }
    }

    if (res.status === 400 && (currentJsonMode || currentReasoningEffort)) {
      const errPreview = await res.clone().text().catch(() => "");
      const badJsonMode =
        currentJsonMode &&
        /response_format|json_object|json_validate_failed|Failed to generate JSON/i.test(errPreview);
      const badReasoningEffort =
        currentReasoningEffort && /reasoning_effort/i.test(errPreview);
      if (badJsonMode || badReasoningEffort) {
        if (badJsonMode) currentJsonMode = false;
        if (badReasoningEffort) currentReasoningEffort = false;
        res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers,
            body: JSON.stringify(buildBody(currentJsonMode, currentReasoningEffort))
          },
          timeoutMs,
          signal
        );
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(res, errText);
      const isAuthErr = res.status === 401 || res.status === 403;
      const isJsonValidate = /json_validate_failed|Failed to generate JSON|response_format/i.test(errText);
      const isTransientStatus = res.status === 408 || res.status === 429 || res.status >= 500 || isJsonValidate;
      throw makeLlmError(`APIエラー (${res.status}): ${errText.slice(0, 200)}`, {
        retryable: !isAuthErr && isTransientStatus,
        retryAfterMs,
        disableJsonMode: isJsonValidate,
        disableReasoningEffort: /reasoning_effort/i.test(errText)
      });
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content || "";
    const finishReason = String(choice?.finish_reason || "");
    const reasoningLen = String(
      choice?.message?.reasoning || choice?.message?.reasoning_content || ""
    ).length;

    if (!String(content).trim()) {
      const refusal = String(choice?.message?.refusal || "").trim();
      const bumped =
        finishReason === "length" || reasoningLen > 0
          ? Math.min(4096, Math.max(2400, effectiveMaxTokens * 2 || 2400))
          : 0;
      const suffixParts = [];
      if (finishReason) suffixParts.push(`finish=${finishReason}`);
      if (reasoningLen > 0) suffixParts.push(`reasoning=${reasoningLen}文字`);
      const detail = suffixParts.length > 0 ? ` (${suffixParts.join(", ")})` : "";
      throw makeLlmError(
        refusal ? `AIが応答を拒否しました: ${refusal.slice(0, 120)}` : `AIからの応答が空でした${detail}`,
        {
          retryable: true,
          disableJsonMode: true,
          disableReasoningEffort: !currentReasoningEffort,
          bumpMinMaxTokens: bumped
        }
      );
    }

    try {
      const parsed = parseJsonFromLLM(content);
      if (onUsage) onUsage(extractTokenUsage("openai", data));
      return parsed;
    } catch (parseErr) {
      const bumped =
        finishReason === "length"
          ? Math.min(4096, Math.max(2400, effectiveMaxTokens * 2 || 2400))
          : 0;
      throw makeLlmError(parseErr?.message || String(parseErr), {
        retryable: true,
        disableJsonMode: true,
        bumpMinMaxTokens: bumped
      });
    }
  }

  if (apiFormat === "anthropic") {
    const endpoint = baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl}/messages`;
    const userContent = [];

    if (screenshotDataUrl) {
      const match = screenshotDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] }
        });
      }
    }
    userContent.push({ type: "text", text: userPrompt });

    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: Math.max(1024, Number(minMaxTokens) || 0),
          temperature: temperatureOverride != null ? temperatureOverride : 0.0,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }]
        })
      },
      timeoutMs,
      signal
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(res);
      const isAuthErr = res.status === 401 || res.status === 403;
      const isTransientStatus = res.status === 408 || res.status === 429 || res.status >= 500 || res.status === 529;
      throw makeLlmError(`Anthropic APIエラー (${res.status}): ${errText.slice(0, 200)}`, {
        retryable: !isAuthErr && isTransientStatus,
        retryAfterMs
      });
    }

    const data = await res.json();
    const textPart = (data?.content || []).find((c) => c.type === "text")?.text || "";
    try {
      const parsed = parseJsonFromLLM(textPart);
      if (onUsage) onUsage(extractTokenUsage("anthropic", data));
      return parsed;
    } catch (parseErr) {
      throw makeLlmError(parseErr?.message || String(parseErr), { retryable: true });
    }
  }

  if (apiFormat === "gemini") {
    const discovered = await discoverGeminiModels(apiKey, signal);
    const candidateModels = Array.from(
      new Set([
        ...(model.startsWith("gemini") ? [model] : []),
        ...discovered.models
      ])
    );

    const parts = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
    if (screenshotDataUrl) {
      const match = screenshotDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
    }

    let lastRes = null;
    for (const m of candidateModels.slice(0, 5)) {
      const endpoint = `https://generativelanguage.googleapis.com/${discovered.apiVersion}/models/${encodeURIComponent(
        m
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const genConfig = {
        temperature: temperatureOverride != null ? temperatureOverride : 0.0
      };
      if (forceJsonMode) {
        genConfig.responseMimeType = "application/json";
      }
      lastRes = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: genConfig
          })
        },
        timeoutMs,
        signal
      );
      if (lastRes.ok) break;
      if (lastRes.status !== 404 && lastRes.status !== 400 && lastRes.status !== 429) break;
    }

    if (!lastRes.ok) {
      const errText = await lastRes.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(lastRes);
      const isAuthErr = lastRes.status === 401 || lastRes.status === 403 || /API_KEY_INVALID/i.test(errText);
      throw makeLlmError(`Gemini APIエラー (${lastRes.status}): ${errText.slice(0, 200)}`, {
        retryable: !isAuthErr,
        retryAfterMs,
        disableJsonMode: lastRes.status === 400
      });
    }

    const data = await lastRes.json();
    const textPart =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
    try {
      const parsed = parseJsonFromLLM(textPart);
      if (onUsage) onUsage(extractTokenUsage("gemini", data));
      return parsed;
    } catch (parseErr) {
      throw makeLlmError(parseErr?.message || String(parseErr), {
        retryable: true,
        disableJsonMode: true
      });
    }
  }

  throw makeLlmError(`未対応のAPIフォーマットです: ${apiFormat}`, { retryable: false });
}

async function callLLM(
  settings,
  systemPrompt,
  userPrompt,
  screenshotDataUrl,
  signal,
  maxOutputTokens = 0,
  retryOpts = {}
) {
  const maxAttempts = Math.max(1, Number(retryOpts.maxAttempts) || 4);
  const backoffSchedule = Array.isArray(retryOpts.backoffMs)
    ? retryOpts.backoffMs
    : [2500, 6000, 12000];
  const validateDecision = typeof retryOpts.validateDecision === "function"
    ? retryOpts.validateDecision
    : null;
  const onRetry = typeof retryOpts.onRetry === "function" ? retryOpts.onRetry : null;
  const onUsage = typeof retryOpts.onUsage === "function" ? retryOpts.onUsage : null;

  let forceJsonMode = true;
  let allowReasoningEffort = true;
  let dynamicMinMaxTokens = 0;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const attemptTemp = attempt === 1 ? null : Math.min(0.45, (attempt - 1) * 0.15);
    const minMaxTokens = Math.max(dynamicMinMaxTokens, attempt === 1 ? 0 : 1400);

    try {
      const parsed = await callLLMSingleAttempt(
        settings,
        systemPrompt,
        userPrompt,
        screenshotDataUrl,
        signal,
        maxOutputTokens,
        {
          forceJsonMode,
          allowReasoningEffort,
          temperatureOverride: attemptTemp,
          minMaxTokens,
          onUsage
        }
      );
      if (validateDecision) {
        const validationErr = validateDecision(parsed);
        if (validationErr) {
          throw makeLlmError(validationErr, { retryable: true, disableJsonMode: false });
        }
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || err?.name === "AbortError") throw err;
      if (err?.retryable === false || attempt >= maxAttempts) throw err;

      if (err?.disableJsonMode) {
        forceJsonMode = false;
      }
      if (err?.disableReasoningEffort) {
        allowReasoningEffort = false;
      }
      if (Number(err?.bumpMinMaxTokens) > dynamicMinMaxTokens) {
        dynamicMinMaxTokens = Math.min(4096, Number(err.bumpMinMaxTokens));
      }

      const baseDelay = backoffSchedule[Math.min(attempt - 1, backoffSchedule.length - 1)] || 5000;
      const jitter = Math.floor(Math.random() * 800);
      const waitMs = Math.max(Number(err?.retryAfterMs) || 0, baseDelay + jitter);

      if (onRetry) {
        await onRetry({
          attempt,
          maxAttempts,
          waitMs,
          reason: err?.message || String(err)
        });
      }
      await sleep(waitMs, signal);
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }
  }

  throw lastErr || new Error("AI呼び出しに失敗しました");
}

// ============================================================================
// Dynamic Gemini Model Discovery (ListModels) & Audio Speech-to-Text
// ============================================================================
const geminiModelListCache = new Map();
const deadGeminiModels = new Set();

async function discoverGeminiModels(apiKey, signal) {
  const cleanKey = (apiKey || "").trim();
  const cached = geminiModelListCache.get(cleanKey);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    const aliveModels = cached.models.filter((m) => !deadGeminiModels.has(m));
    if (aliveModels.length > 0) {
      return { ...cached, models: aliveModels };
    }
  }

  for (const apiVer of ["v1beta", "v1"]) {
    const url = `https://generativelanguage.googleapis.com/${apiVer}/models?key=${encodeURIComponent(
      cleanKey
    )}`;
    let res;
    try {
      res = await fetchWithTimeout(url, { method: "GET" }, 5000, signal);
    } catch (_) {
      continue;
    }
    if (res.status === 400 || res.status === 403) {
      const errText = await res.text().catch(() => "");
      const keyPrefix = cleanKey.slice(0, 5);
      if (/API_KEY_INVALID|API key not valid/i.test(errText) || !cleanKey.startsWith("AIza")) {
        throw new Error(
          `Gemini用のAPIキーが無効です(現在 "${keyPrefix}..." が設定されています)。Google AI Studioで発行した「AIza...」で始まるキー、またはGroqの「gsk_...」キーを「音声用API Key」に入力してください`
        );
      }
      throw new Error(`Gemini認証エラー (${res.status}): ${errText.slice(0, 140)}`);
    }
    if (!res.ok) continue;

    const data = await res.json().catch(() => ({}));
    const rawModels = Array.isArray(data?.models) ? data.models : [];
    const generateModels = rawModels
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(
        (id) =>
          id.startsWith("gemini") &&
          !deadGeminiModels.has(id) &&
          !/embedding|imagen|veo|tts|aqa|bisheng|learnlm|robotics|computer-use|image|dialog|live|native-audio|thinking|transcribe|gemma|audio-out/i.test(
            id
          )
      );

    if (generateModels.length > 0) {
      const scoreModel = (id) => {
        let s = 0;
        if (/flash/i.test(id)) s += 100;
        if (/pro/i.test(id)) s += 30;
        if (!/preview|exp|8b/i.test(id)) s += 40;
        if (id === "gemini-2.5-flash-lite" || id === "gemini-flash-lite-latest") s += 38;
        else if (id === "gemini-flash-latest" || id === "gemini-2.5-flash") s += 36;
        else if (id === "gemini-2.0-flash" || id === "gemini-2.0-flash-001") s += 34;
        else if (/2\.5|2-5/i.test(id)) s += 25;
        else if (/3\.0|3-0|3-flash/i.test(id)) s += 22;
        else if (/2\.0|2-0/i.test(id)) s += 20;
        return s;
      };
      generateModels.sort((a, b) => scoreModel(b) - scoreModel(a));
      const result = { apiVersion: apiVer, models: generateModels, ts: Date.now() };
      geminiModelListCache.set(cleanKey, result);
      return result;
    }
  }

  return {
    apiVersion: "v1beta",
    models: [
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-pro-latest"
    ].filter((m) => !deadGeminiModels.has(m)),
    ts: Date.now()
  };
}

let creatingOffscreenPromise = null;
const activeProgressListeners = new Set();

async function waitForOffscreenReady(maxAttempts = 25) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "ELK_OFFSCREEN_PING"
      });
      if (pong?.ok) return true;
    } catch (_) {
      // offscreen.js module still loading/initializing
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function ensureOffscreenDocument() {
  let hasContext = false;
  if (typeof chrome.runtime.getContexts === "function") {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    hasContext = existing.length > 0;
  }
  if (!hasContext) {
    if (!creatingOffscreenPromise) {
      creatingOffscreenPromise = chrome.offscreen
        .createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Run in-browser local Whisper STT (WASM) and audio PCM resampling"
        })
        .catch((err) => {
          // Ignore if already created concurrently
          if (!/Only a single offscreen document/i.test(String(err?.message || err))) {
            throw err;
          }
        })
        .finally(() => {
          creatingOffscreenPromise = null;
        });
    }
    await creatingOffscreenPromise;
  }

  const ready = await waitForOffscreenReady();
  if (!ready) {
    throw new Error("オフスクリーンドキュメント (offscreen.html) の初期化応答がありません");
  }
}

async function sendOffscreenMessage(payload) {
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({ ...payload, target: "offscreen" });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/Receiving end does not exist|message port closed/i.test(msg)) {
      throw err;
    }
    await new Promise((r) => setTimeout(r, 150));
    await ensureOffscreenDocument();
    return await chrome.runtime.sendMessage({ ...payload, target: "offscreen" });
  }
}

function buildLocalSttUrlCandidates(localSttUrl) {
  const raw = (localSttUrl || "http://127.0.0.1:8765/inference").trim();
  const list = [raw];
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (u.port === "8765" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
      list.push(`http://${u.hostname}:18765${u.pathname && u.pathname !== "/" ? u.pathname : "/inference"}`);
    }
  } catch (_) {}
  return Array.from(new Set(list));
}

async function isSingleLocalSttEndpointAlive(urlStr, signal) {
  try {
    const u = new URL(/^https?:\/\//i.test(urlStr) ? urlStr : `http://${urlStr}`);
    const deadUntil = deadLocalSttUrls.get(u.origin) || 0;
    if (deadUntil > Date.now()) return false;

    const res = await fetchWithTimeout(`${u.origin}/`, { method: "GET" }, 450, signal);
    if (!res.ok) {
      if (res.status === 404) {
        deadLocalSttUrls.set(u.origin, Date.now() + 60000);
      }
      return false;
    }
    const serverHdr = (res.headers?.get?.("server") || "").toLowerCase();
    const bodyText = await res.text().catch(() => "");
    if (serverHdr.includes("whisper") || /whisper/i.test(bodyText) || /"status"\s*:\s*"ok"/i.test(bodyText)) {
      return true;
    }
    deadLocalSttUrls.set(u.origin, Date.now() + 60000);
    return false;
  } catch (_) {
    return false;
  }
}

async function findAliveLocalSttUrl(localSttUrl, signal) {
  for (const cand of buildLocalSttUrlCandidates(localSttUrl)) {
    if (await isSingleLocalSttEndpointAlive(cand, signal)) {
      return cand;
    }
  }
  return null;
}

async function isLocalSttServerAlive(localSttUrl, signal) {
  return Boolean(await findAliveLocalSttUrl(localSttUrl, signal));
}

async function ensureWavAudio(audioRes) {
  const u = audioRes.url || "";
  if (
    audioRes.mimeType === "audio/wav" &&
    (u.startsWith("webaudio://") || u.startsWith("synthetic://"))
  ) {
    return audioRes;
  }
  const conv = await sendOffscreenMessage({
    type: "ELK_OFFSCREEN_DECODE_WAV",
    base64: audioRes.base64
  });
  if (conv?.ok && conv.base64) {
    return {
      ...audioRes,
      mimeType: "audio/wav",
      sizeBytes: conv.sizeBytes,
      base64: conv.base64
    };
  }
  return audioRes;
}

async function resolveSttCredentialsAsync(settings, signal, opts = {}) {
  const allowLocalServerFallback = opts.allowLocalServerFallback !== false;
  const keys = settings.apiKeysByPreset || {};
  const explicitProvider = settings.sttProvider || "auto";
  const explicitKey = (settings.sttApiKey || "").trim();
  const deepseekKey = (keys.deepseek || "").trim();
  const localSttUrl = (settings.localSttUrl || "http://127.0.0.1:8765/inference").trim();
  const localBrowserModel =
    (settings.localBrowserModel || "onnx-community/whisper-base.en").trim();

  // Helper to ignore keys that were accidentally duplicated from deepseek into gemini/openai slots
  const getValidPresetKey = (presetName) => {
    const k = (keys[presetName] || "").trim();
    if (!k) return "";
    if (presetName.startsWith("gemini") && k === deepseekKey && k.startsWith("sk-")) {
      return "";
    }
    return k;
  };

  if (explicitProvider === "local_browser") {
    return { provider: "local_browser", modelId: localBrowserModel };
  }
  if (explicitProvider === "local_server") {
    const aliveUrl = await findAliveLocalSttUrl(localSttUrl, signal);
    if (aliveUrl) {
      return {
        provider: "local_server",
        url: aliveUrl,
        fallbackToBrowser: allowLocalServerFallback,
        browserModelId: localBrowserModel
      };
    }
    if (allowLocalServerFallback) {
      return {
        provider: "local_browser",
        modelId: localBrowserModel
      };
    }
    return {
      provider: "local_server",
      url: localSttUrl,
      fallbackToBrowser: false,
      browserModelId: localBrowserModel
    };
  }
  if (explicitProvider === "groq") {
    const k =
      explicitKey ||
      getValidPresetKey("groq") ||
      (settings.providerPreset === "groq" ? (settings.apiKey || "").trim() : "");
    if (k) return { provider: "groq", apiKey: k, browserModelId: localBrowserModel };
  }
  if (explicitProvider === "gemini") {
    const k =
      explicitKey ||
      getValidPresetKey("gemini_openai") ||
      getValidPresetKey("gemini_native") ||
      (settings.providerPreset?.startsWith("gemini") ? (settings.apiKey || "").trim() : "");
    if (k) return { provider: "gemini", apiKey: k, browserModelId: localBrowserModel };
  }
  if (explicitProvider === "openai") {
    const k =
      explicitKey ||
      getValidPresetKey("openai") ||
      (settings.providerPreset === "openai" ? (settings.apiKey || "").trim() : "");
    if (k) return { provider: "openai", apiKey: k, browserModelId: localBrowserModel };
  }
  if (explicitProvider === "elevenlabs") {
    const k = explicitKey;
    if (k) return { provider: "elevenlabs", apiKey: k, browserModelId: localBrowserModel };
  }

  // If explicit non-auto cloud provider was selected without a key, fail cleanly with actionable guidance
  if (explicitProvider !== "auto") {
    return null;
  }

  // --- AUTO MODE PRIORITY ---
  // 1. If PC local whisper-server.exe (.bat) is currently running on localhost, use it first (fastest & highest accuracy)!
  const aliveAutoUrl = await findAliveLocalSttUrl(localSttUrl, signal);
  if (aliveAutoUrl) {
    return {
      provider: "local_server",
      url: aliveAutoUrl,
      fallbackToBrowser: true,
      browserModelId: localBrowserModel
    };
  }

  // 2. Check configured API keys (Groq -> ElevenLabs -> OpenAI -> Gemini, all with automatic fallback to local_browser!)
  if (explicitKey) {
    if (explicitKey.startsWith("gsk_")) {
      return {
        provider: "groq",
        apiKey: explicitKey,
        fallbackToBrowser: true,
        browserModelId: localBrowserModel
      };
    }
    if (explicitKey.startsWith("AIza")) {
      return {
        provider: "gemini",
        apiKey: explicitKey,
        fallbackToBrowser: true,
        browserModelId: localBrowserModel
      };
    }
    if (explicitKey.startsWith("sk_")) {
      return {
        provider: "elevenlabs_or_gemini",
        apiKey: explicitKey,
        fallbackToBrowser: true,
        browserModelId: localBrowserModel
      };
    }
    return {
      provider: "openai",
      apiKey: explicitKey,
      fallbackToBrowser: true,
      browserModelId: localBrowserModel
    };
  }

  const allCandidateKeys = [
    getValidPresetKey("groq"),
    getValidPresetKey("gemini_openai"),
    getValidPresetKey("gemini_native"),
    getValidPresetKey("openai"),
    (settings.apiKey || "").trim()
  ].filter(Boolean);

  const groqKey = allCandidateKeys.find((k) => k.startsWith("gsk_")) || getValidPresetKey("groq");
  if (groqKey) {
    return {
      provider: "groq",
      apiKey: groqKey,
      fallbackToBrowser: true,
      browserModelId: localBrowserModel
    };
  }

  const openaiKey = getValidPresetKey("openai");
  if (openaiKey && openaiKey !== deepseekKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      fallbackToBrowser: true,
      browserModelId: localBrowserModel
    };
  }

  const geminiKey =
    allCandidateKeys.find((k) => k.startsWith("AIza")) ||
    getValidPresetKey("gemini_openai") ||
    getValidPresetKey("gemini_native");
  if (geminiKey) {
    return {
      provider: "gemini",
      apiKey: geminiKey,
      fallbackToBrowser: true,
      browserModelId: localBrowserModel
    };
  }

  // 3. Zero API keys needed: automatically use in-browser local Whisper (WASM)!
  return {
    provider: "local_browser",
    modelId: localBrowserModel
  };
}

function base64ToUint8Array(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function transcribeWithLocalServer(serverUrlRaw, audioRes, candidateHint, signal, onProgress) {
  const urlCandidatesRaw = buildLocalSttUrlCandidates(serverUrlRaw);
  const candidateUrls = [];
  for (const cand of urlCandidatesRaw) {
    const baseObj = new URL(/^https?:\/\//i.test(cand) ? cand : `http://${cand}`);
    const origin = baseObj.origin;
    candidateUrls.push(
      baseObj.pathname && baseObj.pathname !== "/" ? baseObj.href : `${origin}/inference`,
      `${origin}/inference`,
      `${origin}/v1/audio/transcriptions`
    );
  }
  const uniqueEndpoints = Array.from(new Set(candidateUrls));

  if (onProgress) await onProgress("PCローカルサーバー変換中");
  const wavAudio = await ensureWavAudio(audioRes);
  const bytes = base64ToUint8Array(wavAudio.base64);
  const blob = new Blob([bytes], { type: "audio/wav" });

  let lastErr = "";
  for (const endpoint of uniqueEndpoints) {
    const epOrigin = new URL(endpoint).origin;
    if ((deadLocalSttUrls.get(epOrigin) || 0) > Date.now()) continue;

    if (onProgress) await onProgress(`PCローカルWhisper`);
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("response_format", "json");
    form.append("model", "whisper-1");
    if (candidateHint) {
      form.append(
        "prompt",
        `English phrases (expand contractions like might've/can't've/must've): ${candidateHint}`
      );
    }

    let res;
    try {
      res = await fetchWithTimeout(endpoint, { method: "POST", body: form }, 25000, signal);
    } catch (netErr) {
      lastErr = `PCローカルサーバー (${epOrigin}) に接続できません。local-stt\\2_ローカル音声サーバー起動.bat を起動してください`;
      continue;
    }

    if (res.status === 404) {
      lastErr = `404 (${endpoint})`;
      if (endpoint.endsWith("/v1/audio/transcriptions")) {
        deadLocalSttUrls.set(epOrigin, Date.now() + 60000);
      }
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`PCローカルサーバーエラー (${res.status}): ${errText.slice(0, 140)}`);
    }

    deadLocalSttUrls.delete(epOrigin);
    const ct = res.headers?.get?.("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await res.json();
      return String(data?.text || "").replace(/\s+/g, " ").trim();
    }
    const rawTxt = await res.text();
    try {
      const parsed = JSON.parse(rawTxt);
      return String(parsed?.text || "").replace(/\s+/g, " ").trim();
    } catch (_) {
      return rawTxt.replace(/\s+/g, " ").trim();
    }
  }

  throw new Error(
    lastErr ||
      "PCローカルサーバーに接続できません。local-stt\\2_ローカル音声サーバー起動.bat を起動してください"
  );
}

async function transcribeWithLocalBrowser(modelId, audioRes, candidateHint, signal, onProgress) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const shortName = (modelId || "whisper-base.en").split("/").pop();
  if (onProgress) await onProgress(`ブラウザ内 ${shortName}`);

  const progressCb = async (msg) => {
    if (onProgress && msg?.progress !== undefined) {
      await onProgress(`初回モデルDL ${msg.progress}% (${shortName})`);
    }
  };
  activeProgressListeners.add(progressCb);

  try {
    const res = await sendOffscreenMessage({
      type: "ELK_OFFSCREEN_TRANSCRIBE_LOCAL",
      modelId: modelId || "onnx-community/whisper-base.en",
      base64: audioRes.base64,
      mimeType: audioRes.mimeType || "audio/mpeg",
      candidateHint: candidateHint || ""
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    if (!res?.ok) {
      throw new Error(res?.error || "ブラウザ内ローカルWhisperの文字起こしに失敗しました");
    }
    return String(res.text || "").trim();
  } finally {
    activeProgressListeners.delete(progressCb);
  }
}

async function transcribeWithElevenLabs(apiKey, audioRes, signal) {
  const bytes = base64ToUint8Array(audioRes.base64);
  const blob = new Blob([bytes], { type: audioRes.mimeType || "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model_id", "scribe_v1");

  const res = await fetchWithTimeout(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form
    },
    12000,
    signal
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs STTエラー (${res.status}): ${errText.slice(0, 140)}`);
  }
  const data = await res.json();
  return (data?.text || "").trim();
}

async function transcribeAudioBase64(
  sttCreds,
  audioRes,
  candidateOptionTexts = [],
  signal,
  onProgress = null
) {
  let { provider, apiKey, url, modelId, fallbackToBrowser, browserModelId } = sttCreds;
  const candidateHint =
    Array.isArray(candidateOptionTexts) && candidateOptionTexts.length > 0
      ? candidateOptionTexts.join(", ")
      : "";

  if (provider === "local_browser") {
    return await transcribeWithLocalBrowser(
      modelId || browserModelId || "onnx-community/whisper-base.en",
      audioRes,
      candidateHint,
      signal,
      onProgress
    );
  }

  const runCloudOrServer = async () => {
    if (provider === "local_server") {
      return await transcribeWithLocalServer(url, audioRes, candidateHint, signal, onProgress);
    }

    if (apiKey && apiKey.startsWith("gsk_")) {
      provider = "groq";
    }

    if (provider === "elevenlabs") {
      if (onProgress) await onProgress("elevenlabs");
      return await transcribeWithElevenLabs(apiKey, audioRes, signal);
    }

    if (provider === "elevenlabs_or_gemini") {
      try {
        if (onProgress) await onProgress("elevenlabs");
        return await transcribeWithElevenLabs(apiKey, audioRes, signal);
      } catch (_) {
        provider = "gemini";
      }
    }

    if (provider === "groq" || provider === "openai") {
      const endpoint =
        provider === "groq"
          ? "https://api.groq.com/openai/v1/audio/transcriptions"
          : "https://api.openai.com/v1/audio/transcriptions";
      const model = provider === "groq" ? "whisper-large-v3-turbo" : "whisper-1";
      if (onProgress) await onProgress(`${provider}/${model}`);

      const bytes = base64ToUint8Array(audioRes.base64);
      const ext =
        audioRes.mimeType === "audio/mp4"
          ? "m4a"
          : audioRes.mimeType === "audio/wav"
          ? "wav"
          : audioRes.mimeType === "audio/ogg"
          ? "ogg"
          : "mp3";
      const blob = new Blob([bytes], { type: audioRes.mimeType || "audio/mpeg" });

      const form = new FormData();
      form.append("file", blob, `audio.${ext}`);
      form.append("model", model);
      form.append("response_format", "json");
      if (candidateHint) {
        form.append(
          "prompt",
          `Vocabulary / candidate phrases (expand contractions like can't've to can't have, must've to must have, might've to might have): ${candidateHint}`
        );
      }

      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form
        },
        12000,
        signal
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`音声文字起こしエラー (${provider} ${res.status}): ${errText.slice(0, 160)}`);
      }

      const data = await res.json();
      return (data?.text || "").trim();
    }

    if (provider === "gemini") {
      let discovered;
      try {
        if (onProgress) await onProgress("Geminiモデル確認");
        discovered = await discoverGeminiModels(apiKey, signal);
      } catch (discErr) {
        if (apiKey && apiKey.startsWith("sk_")) {
          try {
            if (onProgress) await onProgress("elevenlabs");
            return await transcribeWithElevenLabs(apiKey, audioRes, signal);
          } catch (_) {}
        }
        throw discErr;
      }

      const promptLines = [
        "Listen to this audio carefully and transcribe it.",
        "1. Write the exact spoken English sentence.",
        "2. Expand modal contractions (e.g. \"must've\" -> \"must have\", \"can't've\" -> \"can't have\", \"might've\" -> \"might have\", \"may've\" -> \"may have\").",
        candidateHint
          ? `3. State which candidate option is heard: [${candidateHint}].`
          : ""
      ]
        .filter(Boolean)
        .join("\n");

      let lastStatus = "timeout";
      let lastErrText = "";
      const triedModels = [];

      const candidateList = discovered.models.slice(0, 4);
      for (let pass = 0; pass < 2; pass++) {
        const modelsForPass = pass === 0 ? candidateList : candidateList.slice(0, 2);
        if (pass === 1) {
          await sleep(800, signal);
        }

        for (const m of modelsForPass) {
          if (signal?.aborted) break;
          if (deadGeminiModels.has(m)) continue;
          if (onProgress) await onProgress(m);

          const endpoint = `https://generativelanguage.googleapis.com/${discovered.apiVersion}/models/${encodeURIComponent(
            m
          )}:generateContent?key=${encodeURIComponent(apiKey)}`;

          const genConfig = { temperature: 0.0 };
          if (/flash/i.test(m)) {
            genConfig.thinkingConfig = { thinkingBudget: 0 };
          }

          const buildPayload = (cfg) =>
            JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: promptLines },
                    {
                      inlineData: {
                        mimeType: audioRes.mimeType || "audio/mpeg",
                        data: audioRes.base64
                      }
                    }
                  ]
                }
              ],
              generationConfig: cfg
            });

          try {
            let res = await fetchWithTimeout(
              endpoint,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: buildPayload(genConfig)
              },
              12000,
              signal
            );

            if (res.status === 400 && genConfig.thinkingConfig) {
              res = await fetchWithTimeout(
                endpoint,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: buildPayload({ temperature: 0.0 })
                },
                12000,
                signal
              );
            }

            lastStatus = res.status;
            if (res.status === 404) {
              deadGeminiModels.add(m);
            }

            if (res.ok) {
              const data = await res.json();
              const text = (
                data?.candidates?.[0]?.content?.parts
                  ?.filter((p) => !p.thought && p.text)
                  .map((p) => p.text)
                  .join("\n") || ""
              ).trim();
              if (text) return text;
              const finishReason = data?.candidates?.[0]?.finishReason || "EMPTY";
              triedModels.push(`${m}:200(${finishReason})`);
            } else {
              lastErrText = await res.text().catch(() => "");
              triedModels.push(`${m}:${res.status}`);
              if (res.status === 401 || res.status === 403) {
                break;
              }
            }
          } catch (fetchErr) {
            if (signal?.aborted) throw fetchErr;
            lastStatus = "timeout";
            lastErrText = fetchErr?.message || String(fetchErr);
            triedModels.push(`${m}:timeout`);
          }
        }

        if (lastStatus !== 503 || signal?.aborted) {
          break;
        }
      }

      throw new Error(
        `Gemini音声文字起こしエラー (${lastStatus}, 試行モデル: ${triedModels.join(
          ", "
        )}): ${lastErrText.slice(0, 140)}`
      );
    }

    throw new Error(`未対応の音声文字起こしプロバイダ: ${provider}`);
  };

  try {
    return await runCloudOrServer();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (fallbackToBrowser && provider !== "local_browser") {
      if (onProgress) await onProgress(`API失敗->ブラウザ内Whisper切替`);
      return await transcribeWithLocalBrowser(
        browserModelId || "onnx-community/whisper-base.en",
        audioRes,
        candidateHint,
        signal,
        onProgress
      );
    }
    throw err;
  }
}

const STATIC_SYSTEM_PROMPT = [
  "語学・eラーニング問題を正確に解くAI。必ずJSON1オブジェクトのみ出力。",
  'スキーマ:{"reason":"本文や音声根拠と各選択肢の比較(日本語100字以内)","status":"answer"|"next_only"|"completed"|"wait","selectedOptionIds":["opt-0"],"selectValues":[{"id":"sel-0","value":"..."}],"textValues":[{"id":"txt-0","value":"..."}],"clickButtonId":"btn-0"|null}',
  "厳守ルール:",
  "1. 先頭に[共有本文・音声]がある場合は該当箇所の根拠と言い換えを必ず照合し、直感で選ばない。複数空欄がある箇所は[空欄:id]/Q番号の前後文脈のみ参照。",
  '2. options/selects/空textInputsがあればstatus="answer"。単一選択は1つ、複数選択指示は該当全ID。文字タイル問題(tileCountあり)は全文字を使い切った完成語を"spelledAnswer"に出力（selectedOptionIdsは省略可）。clickButtonIdはbuttons内から確定/次へ用を選び無ければnull。',
  '3. 未解答欄が無く進む画面は"next_only"、終了時は"completed"。'
].join("\n");

function mapSpelledAnswerToOptionIds(spelledAnswer, options) {
  const cleanSpelled = String(spelledAnswer || "").replace(/\s+/g, "");
  const usedIds = new Set();
  const mappedIds = [];
  const unmatchedChars = [];
  let i = 0;
  while (i < cleanSpelled.length) {
    let matchedOpt = null;
    for (const len of [2, 1]) {
      if (i + len > cleanSpelled.length) continue;
      const sub = cleanSpelled.slice(i, i + len).toLowerCase();
      matchedOpt = (options || []).find(
        (o) => !usedIds.has(o.id) && (o.text || "").toLowerCase() === sub
      );
      if (matchedOpt) {
        usedIds.add(matchedOpt.id);
        mappedIds.push(matchedOpt.id);
        i += len;
        break;
      }
    }
    if (!matchedOpt) {
      unmatchedChars.push(cleanSpelled[i]);
      i += 1;
    }
  }
  return { mappedIds, unmatchedChars };
}

function buildPrompts(frameData, settings, alreadyAnsweredCurrentQuestion, allowGlobalSubmit) {
  const isLetterTileQuestion =
    Array.isArray(frameData.options) &&
    frameData.options.length >= 3 &&
    frameData.options.every((o) => o.type === "tile-order" || (o.text || "").length <= 2);

  const compactOptions = (frameData.options || []).map((o) => {
    const out = { id: o.id, text: o.text };
    if (
      !isLetterTileQuestion &&
      o.type &&
      o.type !== "button-choice" &&
      o.type !== "radio"
    ) {
      out.type = o.type;
    }
    if (o.checked) out.checked = true;
    return out;
  });

  const compactButtons = (frameData.buttons || [])
    .filter((b) => allowGlobalSubmit || b.belongsToActiveQuestion)
    .map((b) => ({ id: b.id, text: b.text }));

  const compactSelects = (frameData.selects || []).map((s) => ({
    id: s.id,
    ...(s.currentValue ? { currentValue: s.currentValue } : {}),
    ...(s.contextSnippet ? { contextSnippet: s.contextSnippet } : {}),
    choices: s.choices.map((c) => ({ value: c.value, text: c.text }))
  }));

  const compactTexts = (frameData.textInputs || []).map((t) => ({
    id: t.id,
    ...(t.qLabel ? { qLabel: t.qLabel } : {}),
    ...(t.currentValue ? { currentValue: t.currentValue } : {}),
    ...(t.contextSnippet ? { contextSnippet: t.contextSnippet } : {})
  }));

  const rawQText = frameData.activeQuestionText || frameData.pageText || "";
  const qText = rawQText.replace(
    /(?:\r?\n)+\s*(?:確認|確認する|解答|解答する|回答|回答する|チェック|提出|提出する)\s*$/i,
    ""
  );
  const rawShared = (frameData.sharedContext || "").trim();
  const useSharedPrefix = rawShared && rawShared !== rawQText.trim();

  const payload = {
    ...(alreadyAnsweredCurrentQuestion ? { alreadyAnswered: true } : {}),
    q: qText,
    ...(compactOptions.length > 0 ? { options: compactOptions } : {}),
    ...(isLetterTileQuestion ? { tileCount: compactOptions.length } : {}),
    ...(compactSelects.length > 0 ? { selects: compactSelects } : {}),
    ...(compactTexts.length > 0 ? { textInputs: compactTexts } : {}),
    ...(compactButtons.length > 0 ? { buttons: compactButtons } : {})
  };

  // Place static context first so DeepSeek/OpenAI prefix caching reuses shared passage & transcript tokens across Q1..Qn!
  const userSections = [];
  if (settings.customPrompt) {
    userSections.push(`[指示]\n${settings.customPrompt}`);
  }
  if (useSharedPrefix) {
    userSections.push(`[共有本文・音声]\n${rawShared}`);
  }
  userSections.push(`問題JSON:${JSON.stringify(payload)}`);

  const isBatchInputs = compactTexts.length >= 2 || compactSelects.length >= 2;
  const maxOutputTokens = isBatchInputs ? 1000 : isLetterTileQuestion ? 900 : 600;

  return {
    systemPrompt: STATIC_SYSTEM_PROMPT,
    userPrompt: userSections.join("\n\n"),
    maxOutputTokens
  };
}

async function executeSingleStep(tabId, isAutoMode) {
  const session = getOrCreateSession(tabId);
  const settings = await getSettings();
  const signal = session.abortController?.signal;

  session.phase = "問題を検出中...";
  session.error = null;
  await broadcastStatus(tabId);

  const ready = await waitForTabReady(tabId, signal);
  if (!ready || signal?.aborted) return { done: true };

  const bestFrame = await scanBestFrame(
    tabId,
    Array.from(session.answeredBlockKeys),
    false,
    Array.from(session.playedMediaCardKeys)
  );
  if (!bestFrame) {
    throw new Error(
      "このページにはアクセスできません（ページを再読み込みしてからもう一度お試しください）"
    );
  }

  const { frameId, data: initialFrameData } = bestFrame;
  let frameData = initialFrameData;

  // Clear per-page answered/played memory if URL changed
  if (frameData.url && session.lastPageUrl && frameData.url !== session.lastPageUrl) {
    const prevLessonId = extractLessonId(session.lastPageUrl);
    const nextLessonId = extractLessonId(frameData.url);
    session.answeredBlockKeys.clear();
    session.playedMediaCardKeys.clear();
    session.sawSequentialCardLock = false;
    session.lastPlayedMediaAt = 0;
    session.audioWaitConsecutive = 0;
    session.recordingWaitOnce = false;
    session.courseWaitCount = 0;
    session.courseScrolledOnce = false;
    session.courseReturnAttempts = 0;
    session.lastClearedTileHash = null;
    if (prevLessonId !== nextLessonId) {
      session.lessonStepCount = 0;
    }
    appendLog(session, `NAV: URL遷移を検知 -> セッション解答履歴をクリア`);
  }
  session.lastPageUrl = frameData.url || session.lastPageUrl;

  const qSummary = frameData.questionSummary || {
    totalBlocks: 0,
    activeCount: 0,
    answeredCount: 0,
    lockedCount: 0
  };
  const mc = frameData.mediaCards || null;

  const btnsBrief = (frameData.buttons || [])
    .map((b) => `${b.id}:"${b.text}"(${b.kind}${b.belongsToActiveQuestion ? ",activeQ" : ""})`)
    .join(", ");
  const mcBrief =
    mc && mc.totalCount > 0
      ? ` mc=${mc.totalCount}[act=${mc.activeCount},lock=${mc.lockedCount},play=${mc.playingCount},unplayed=${mc.unplayedActiveCount}]`
      : "";
  const txtBrief =
    (frameData.textInputs || []).length > 0 || (frameData.inlineInputPills || []).length > 0
      ? ` txt=${(frameData.textInputs || []).length} pills=${(frameData.inlineInputPills || []).length}`
      : "";

  appendLog(
    session,
    `SCAN(f=${frameId}/${bestFrame.totalFramesScanned}): blocks=${qSummary.totalBlocks} [act=${qSummary.activeCount}, ans=${qSummary.answeredCount}, lock=${qSummary.lockedCount}]${mcBrief}${txtBrief} target=${frameData.activeQuestionId || "none"} sharedLen=${(frameData.sharedContext || "").length} btns=[${btnsBrief}]`
  );

  if (Array.isArray(frameData.blocksSummary) && frameData.blocksSummary.length > 0) {
    const briefBlocks = frameData.blocksSummary
      .map(
        (b) =>
          `${b.qId}:${b.status}(${b.reason}${
            b.checkedTexts.length ? `,chk="${b.checkedTexts[0]}"` : ""
          })`
      )
      .join(" | ");
    appendLog(session, `BLOCKS: ${briefBlocks}`);
  }

  // Case C_DASH: Course Dashboard ("フォーカス" / "スタート") -> Pick next uncompleted lesson in Auto mode
  if (frameData.isCourseDashboard) {
    if (frameData.url) {
      session.courseHomeUrl = frameData.url;
    }
    resetPerLessonState(session);
    session.lessonStepCount = 0;

    const courseLessons = Array.isArray(frameData.courseLessons) ? frameData.courseLessons : [];
    appendLog(
      session,
      `COURSE: ダッシュボード検出 (lessons=${courseLessons.length}, goalDone=${Boolean(
        frameData.courseGoalDone
      )}, attempted=${session.attemptedCourseLessonKeys.size})`
    );

    if (frameData.courseGoalDone) {
      session.phase = "🎉 全レッスンの完了目標を達成しました！";
      session.lastAnswerSummary = "進捗率100%を達成";
      session.lastReason = "コース画面で修了目標の達成を確認したため停止しました。";
      appendLog(session, "DONE: コース修了目標を達成");
      await broadcastStatus(tabId);
      return { done: true };
    }

    const nextLesson =
      courseLessons.find((l) => !session.attemptedCourseLessonKeys.has(l.key)) || null;

    if (!nextLesson) {
      if (courseLessons.length === 0 && isAutoMode && session.courseWaitCount < 5) {
        session.courseWaitCount += 1;
        session.phase = `⏳ コース画面のレッスン読み込みを待機中 (${session.courseWaitCount}/5)...`;
        appendLog(session, `COURSE WAIT: レッスン一覧待機 (${session.courseWaitCount}/5)`);
        await broadcastStatus(tabId);
        return { done: false, customNextDelayMs: 900 };
      }

      if (isAutoMode && frameData.canScrollMore && !session.courseScrolledOnce) {
        session.courseScrolledOnce = true;
        session.phase = "他のレッスンを探すためスクロール中...";
        appendLog(session, "COURSE SCROLL: 下方向の未完了レッスンを確認");
        await broadcastStatus(tabId);
        await chrome.tabs.sendMessage(
          tabId,
          { type: "ELK_EXECUTE_ACTION", payload: { status: "scroll_down" } },
          { frameId }
        );
        return { done: false, customNextDelayMs: 800 };
      }

      session.phase =
        courseLessons.length > 0
          ? "表示中の未完了レッスンを一通り完了しました！"
          : "コース画面で開始可能なレッスンが見つかりませんでした";
      session.lastAnswerSummary =
        courseLessons.length > 0 ? "今回のレッスン周回完了" : "開始可能レッスンなし";
      session.lastReason =
        courseLessons.length > 0
          ? "このセッションでコース画面に表示中のレッスンを一通り実行したため終了しました。"
          : "コース画面に「スタート」可能なレッスンが表示されていませんでした。";
      appendLog(session, `DONE: ${session.phase}`);
      await broadcastStatus(tabId);
      return { done: true };
    }

    session.courseWaitCount = 0;
    session.courseScrolledOnce = false;
    session.sameStateCount = 0;
    session.lastStateHash = null;
    if (isAutoMode) {
      session.attemptedCourseLessonKeys.add(nextLesson.key);
      session.lastStartedCourseLessonKey = nextLesson.key;
    }
    session.lastReason = `コース画面から次のレッスン「${nextLesson.label}」を開始します。`;
    session.lastAnswerSummary = `[開始] ${nextLesson.label}`;
    session.phase = `📚 レッスン開始: ${nextLesson.label}`;
    await broadcastStatus(tabId);

    const execRes = await chrome.tabs.sendMessage(
      tabId,
      {
        type: "ELK_EXECUTE_ACTION",
        payload: {
          status: "click_course_start",
          courseBtnId: nextLesson.id,
          highlightAnswer: settings.highlightAnswer
        }
      },
      { frameId }
    );
    appendLog(session, `EXEC: ${(execRes?.actionsTaken || ["clicked course start"]).join(" | ")}`);
    session.stepCount += 1;

    if (!isAutoMode) {
      session.phase = `「${nextLesson.label}」を開始しました`;
      await broadcastStatus(tabId);
      return { done: true };
    }

    const enteredLesson = await waitForTabUrlTransition(
      tabId,
      (u) => /\/lessons\//i.test(u) || u !== frameData.url,
      signal,
      2500
    );
    if (enteredLesson) {
      appendLog(session, "NAV: レッスン画面への遷移を確認");
    }
    session.phase = "📚 レッスンを開いています...";
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: enteredLesson ? 900 : 1200 };
  }

  // Case TEST_DONE: Test Result / Review screen ("テスト結果 (解答と解説)" / "今回のテスト結果 ...")
  // The test is already graded and saved; never traverse P1->P2->P3 review parts or call STT/LLM!
  // If failed (< pass threshold, e.g. 60% < 70%), unlock retry up to 2 times (3 attempts total).
  if (frameData.isResultReview) {
    resetPerLessonState(session);
    session.lessonStepCount = 0;

    if (isAutoMode && frameData.resultOutcome === "fail") {
      const lessonIdTag = extractLessonId(frameData.url);
      const retryKey = session.lastStartedCourseLessonKey || (lessonIdTag ? `lesson:${lessonIdTag}` : "current-lesson");
      const usedRetries = session.courseLessonRetryCounts.get(retryKey) || 0;
      const scoreLabel = frameData.resultScorePercent != null ? `${frameData.resultScorePercent}%` : "不合格";

      if (usedRetries < 2) {
        session.courseLessonRetryCounts.set(retryKey, usedRetries + 1);
        if (session.lastStartedCourseLessonKey) {
          session.attemptedCourseLessonKeys.delete(session.lastStartedCourseLessonKey);
        }
        appendLog(
          session,
          `RESULT FAIL (${scoreLabel}) -> コース画面から再挑戦 (${usedRetries + 1}/2)`
        );
        return handleLessonCompletionTransition(
          tabId,
          session,
          frameData,
          true,
          "RETRY",
          `🔄 テスト不合格 (${scoreLabel}) → 再挑戦のため戻っています (${usedRetries + 1}/2)...`
        );
      }
      appendLog(session, `RESULT FAIL (${scoreLabel}): 再挑戦上限(2回)到達のため次レッスンへ`);
    }

    appendLog(session, "RESULT: テスト結果・完了画面を検出 -> 解説周回をスキップ (0 tokens)");
    return handleLessonCompletionTransition(tabId, session, frameData, isAutoMode, "RESULT");
  }

  // Case C_RET: Completed lesson page still inside /lessons/... with explicit return/close button -> return to Course Dashboard in Auto mode
  if (isAutoMode && frameData.courseReturnBtn) {
    const courseUrl = deriveCourseUrl(frameData.url, session.courseHomeUrl);
    if (session.courseReturnAttempts >= 1 && courseUrl) {
      resetPerLessonState(session);
      session.lessonStepCount = 0;
      session.sameStateCount = 0;
      session.lastStateHash = null;
      session.phase = "🏠 コース一覧画面へ戻っています...";
      session.lastReason = "戻りボタンで遷移しなかったためコースURLへ直接移動します。";
      appendLog(session, `COURSE RETURN FALLBACK: ${courseUrl}`);
      await broadcastStatus(tabId);
      await chrome.tabs.update(tabId, { url: courseUrl });
      return { done: false, customNextDelayMs: 1600 };
    }

    session.courseReturnAttempts += 1;
    session.sameStateCount = 0;
    session.lastStateHash = null;
    session.lastReason = `レッスン完了を検知し、「${frameData.courseReturnBtn.text}」でコース一覧へ戻ります。`;
    session.lastAnswerSummary = `[戻る] ${frameData.courseReturnBtn.text}`;
    session.phase = "🏠 レッスン完了 → コース画面へ戻っています...";
    await broadcastStatus(tabId);

    const execRes = await chrome.tabs.sendMessage(
      tabId,
      {
        type: "ELK_EXECUTE_ACTION",
        payload: {
          status: "click_course_return",
          returnBtnId: frameData.courseReturnBtn.id,
          highlightAnswer: settings.highlightAnswer
        }
      },
      { frameId }
    );
    appendLog(session, `EXEC: ${(execRes?.actionsTaken || ["clicked course return"]).join(" | ")}`);
    session.stepCount += 1;

    const leftLesson = await waitForTabUrlTransition(
      tabId,
      (u) => !/\/lessons\//i.test(u) || u !== frameData.url,
      signal,
      2200
    );
    if (leftLesson) {
      resetPerLessonState(session);
      session.lessonStepCount = 0;
      appendLog(session, "NAV: コース一覧画面への帰還を確認");
    }
    return { done: false, customNextDelayMs: leftLesson ? 900 : 1200 };
  }

  // Case R: Voice recording / speaking task ("リッスン＆リピート" / "発話を録音") -> Auto-skip for user to complete later
  if (
    frameData.isRecordingTask &&
    qSummary.activeCount === 0 &&
    frameData.selects.length === 0 &&
    (frameData.textInputs || []).length === 0
  ) {
    const skipBtn =
      frameData.buttons.find((b) => b.kind === "skip") ||
      frameData.buttons.find((b) => b.kind === "next");
    if (skipBtn) {
      session.sameStateCount = 0;
      session.recordingWaitOnce = false;
      session.lastStateHash = frameData.stateHash;
      session.lastReason = `[録音課題スキップ] 発話・録音課題をスキップして「${skipBtn.text}」をクリック`;
      session.lastAnswerSummary = `[スキップ] ${skipBtn.text}`;
      session.phase = "🎙️ 録音課題をスキップ中...";
      await broadcastStatus(tabId);

      const execRes = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "ELK_EXECUTE_ACTION",
          payload: {
            status: "next_only",
            clickButtonId: skipBtn.id,
            allowGlobalSubmit: true,
            autoSubmit: true,
            clickDelayMs: settings.clickDelayMs,
            highlightAnswer: settings.highlightAnswer
          }
        },
        { frameId }
      );
      session.stepCount += 1;
      appendLog(session, `SKIP RECORDING: ${(execRes?.actionsTaken || [skipBtn.text]).join(" | ")}`);
      await broadcastStatus(tabId);
      return { done: !isAutoMode, customNextDelayMs: 900 };
    }

    if (!session.recordingWaitOnce) {
      session.recordingWaitOnce = true;
      session.lastStateHash = frameData.stateHash;
      session.phase = "🎙️ 録音課題のスキップ遷移を待機中...";
      await broadcastStatus(tabId);
      return { done: false, customNextDelayMs: 800 };
    }

    session.phase = "🎙️ 録音課題のため停止しました（後で自力で実施）";
    appendLog(session, "STOP: 音声録音課題（自力実施用）でスキップ/次へボタンが無いため停止");
    await broadcastStatus(tabId);
    return { done: true };
  }

  // Case A: Unlock animation wait
  if (
    frameData.options.length === 0 &&
    frameData.selects.length === 0 &&
    (frameData.textInputs || []).length === 0 &&
    (frameData.inlineInputPills || []).length === 0 &&
    qSummary.lockedCount > 0 &&
    frameData.buttons.filter((b) => b.kind === "next" || b.kind === "submit").length === 0
  ) {
    session.phase = "次の問題のロック解除を待機中...";
    appendLog(session, "WAIT: ロック解除アニメーション待機 (550ms)");
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 550 };
  }

  // Case B: Scroll down when all visible blocks/inputs are answered and page/pane can scroll further
  const preTextInputs = frameData.textInputs || [];
  const preSelects = frameData.selects || [];
  const preButtons = frameData.buttons || [];
  const preUnfilledText = preTextInputs.filter((t) => !t.currentValue);
  const preAlreadyAnsweredBase = Boolean(
    frameData.questionBaseKey && session.answeredBlockKeys.has(frameData.questionBaseKey)
  );
  const preNoRemainingInputs =
    (preTextInputs.length === 0 && preSelects.length === 0) ||
    (preUnfilledText.length === 0 && preAlreadyAnsweredBase);

  if (
    isAutoMode &&
    frameData.options.length === 0 &&
    qSummary.activeCount === 0 &&
    qSummary.lockedCount === 0 &&
    preNoRemainingInputs &&
    (frameData.inlineInputPills || []).length === 0 &&
    (qSummary.answeredCount > 0 || preTextInputs.length > 0 || preSelects.length > 0 || (frameData.pageText || "").length >= 30) &&
    preButtons.length === 0 &&
    !COMPLETION_TEXT_REGEX.test(frameData.pageText || "") &&
    frameData.canScrollMore
  ) {
    session.phase = "下の問題へスクロール中...";
    const scrollRes = await chrome.tabs.sendMessage(
      tabId,
      { type: "ELK_EXECUTE_ACTION", payload: { status: "scroll_down" } },
      { frameId }
    );
    appendLog(session, `SCROLL: ${(scrollRes?.actionsTaken || []).join("; ")}`);
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 500 };
  }

  // Case C: Wait once if same instant-choice question hasn't finished grading animation
  const isSameQuestionJustAnswered =
    Boolean(frameData.questionBaseKey) &&
    frameData.questionBaseKey === session.lastAnsweredBaseKey &&
    Date.now() - session.lastAnsweredAt < 15000;

  if (
    isAutoMode &&
    isSameQuestionJustAnswered &&
    !session.waitedForSameKey &&
    frameData.options.length > 0 &&
    frameData.options.every((o) => o.type === "button-choice") &&
    frameData.buttons.filter((b) => b.kind === "submit" || b.kind === "next").length === 0
  ) {
    session.waitedForSameKey = true;
    session.phase = "判定アニメーション待機中...";
    appendLog(session, "WAIT: 同一問題の判定反映を待機 (800ms)");
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 800 };
  }

  // Case D: Flashcards / Play-to-unlock Word Cards ("単語カード")
  if (
    mc &&
    mc.totalCount > 0 &&
    qSummary.totalBlocks === 0 &&
    frameData.selects.length === 0
  ) {
    if (mc.lockedCount > 0) {
      session.sawSequentialCardLock = true;
    }

    if ((mc.playingCount > 0 || mc.isAudioPlaying) && session.audioWaitConsecutive < 28) {
      session.audioWaitConsecutive += 1;
      session.phase = "🎧 単語カードの音声再生を待機中...";
      if (session.audioWaitConsecutive === 1) {
        appendLog(session, "CARD: 音声再生完了を待機中...");
      }
      await broadcastStatus(tabId);
      return { done: false, customNextDelayMs: 650 };
    }
    session.audioWaitConsecutive = 0;

    const activeCards = (mc.cards || []).filter((c) => !c.locked);
    const unplayedActive = activeCards.filter((c) => !c.played);

    if (unplayedActive.length > 0) {
      const targetCard =
        mc.lockedCount > 0
          ? unplayedActive[unplayedActive.length - 1]
          : unplayedActive[0];

      session.sameStateCount = 0;
      session.lastStateHash = frameData.stateHash;
      session.phase = `🎧 単語カードを再生中 (${targetCard.label})...`;
      session.lastReason = `[単語カード自動再生] ${targetCard.label}`;
      session.lastAnswerSummary = `▶ ${targetCard.label}`;
      await broadcastStatus(tabId);

      const execRes = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "ELK_EXECUTE_ACTION",
          payload: {
            status: "play_media_card",
            targetCardId: targetCard.id,
            highlightAnswer: settings.highlightAnswer
          }
        },
        { frameId }
      );

      session.playedMediaCardKeys.add(targetCard.key);
      session.lastPlayedMediaAt = Date.now();
      session.stepCount += 1;
      appendLog(session, `CARD: ${(execRes?.actionsTaken || [targetCard.label]).join(" | ")}`);
      await broadcastStatus(tabId);

      const nextDelay = execRes?.stillPlaying
        ? 650
        : Math.min(700, Math.max(350, Number(settings.stepDelayMs) || 600));
      return { done: !isAutoMode, customNextDelayMs: nextDelay };
    }

    const navBtn =
      frameData.buttons.find((b) => b.kind === "next") ||
      frameData.buttons.find((b) => b.kind === "submit");

    if (navBtn) {
      session.sameStateCount = 0;
      session.lastStateHash = frameData.stateHash;
      session.lastReason = `[単語カード完了] 全${mc.totalCount}枚再生済み → 「${navBtn.text}」で次へ`;
      session.lastAnswerSummary = `[移動] ${navBtn.text}`;
      session.phase = "次の画面へ移動中...";
      await broadcastStatus(tabId);

      const execRes = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "ELK_EXECUTE_ACTION",
          payload: {
            status: "next_only",
            clickButtonId: navBtn.id,
            allowGlobalSubmit: true,
            autoSubmit: true,
            clickDelayMs: settings.clickDelayMs,
            highlightAnswer: settings.highlightAnswer
          }
        },
        { frameId }
      );
      session.stepCount += 1;
      appendLog(session, `CARD DONE: ${(execRes?.actionsTaken || [navBtn.text]).join(" | ")}`);
      await broadcastStatus(tabId);
      return { done: !isAutoMode };
    }

    if (mc.lockedCount > 0 && Date.now() - session.lastPlayedMediaAt < 4000) {
      session.phase = "次の単語カードの解除を待機中...";
      appendLog(session, "CARD WAIT: 次のカード解除を待機 (650ms)");
      await broadcastStatus(tabId);
      return { done: false, customNextDelayMs: 650 };
    }

    if (mc.lockedCount === 0) {
      if (Date.now() - session.lastPlayedMediaAt < 4500) {
        session.phase = "次へボタン有効化を待機中...";
        await broadcastStatus(tabId);
        return { done: false, customNextDelayMs: 650 };
      }

      if (isAutoMode && frameData.canScrollMore) {
        session.phase = "下のボタン/カードへスクロール中...";
        const scrollRes = await chrome.tabs.sendMessage(
          tabId,
          { type: "ELK_EXECUTE_ACTION", payload: { status: "scroll_down" } },
          { frameId }
        );
        appendLog(session, `SCROLL: ${(scrollRes?.actionsTaken || []).join("; ")}`);
        await broadcastStatus(tabId);
        return { done: false, customNextDelayMs: 500 };
      }

      const inactBrief = (frameData.inactiveButtons || [])
        .map((ib) => `${ib.text}(${ib.reasons})`)
        .join(", ");
      session.sameStateCount += 1;
      if (!isAutoMode || session.sameStateCount >= 3) {
        session.phase = "単語カードの再生が完了しました";
        appendLog(
          session,
          `CARD: 全${mc.totalCount}枚再生済み（次へボタン未検出/無効: [${inactBrief}]）`
        );
        await broadcastStatus(tabId);
        return { done: true };
      }
      await broadcastStatus(tabId);
      return { done: false, customNextDelayMs: 650 };
    }

    if (
      mc.lockedCount > 0 &&
      activeCards.length > 0 &&
      session.playedMediaCardKeys.size > 0 &&
      session.sameStateCount < 2
    ) {
      session.playedMediaCardKeys.clear();
      session.sameStateCount += 1;
      appendLog(session, `CARD RETRY: 再生履歴をリセットして再試行 (${session.sameStateCount}/3)`);
      return { done: false, customNextDelayMs: 450 };
    }

    // Never fall through to LLM on flashcard screens if all cards still appear locked!
    const lockDetail = (mc.cards || [])
      .slice(0, 4)
      .map((c) => `${c.id}(${c.label}):${c.lockReason || "locked"}`)
      .join(" | ");
    const inactBrief = (frameData.inactiveButtons || [])
      .map((ib) => `${ib.text}(${ib.reasons})`)
      .join(", ");
    appendLog(session, `MC_LOCKED: ${lockDetail}${inactBrief ? ` | inactiveBtns=[${inactBrief}]` : ""}`);
    session.sameStateCount += 1;
    if (!isAutoMode || session.sameStateCount >= 3) {
      session.phase = "単語カードの再生可能ボタンが見つかりません";
      await broadcastStatus(tabId);
      return { done: true };
    }
    session.phase = "単語カードの解除待機中...";
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 550 };
  }

  // Stuck detection
  if (isAutoMode) {
    if (frameData.stateHash === session.lastStateHash) {
      session.sameStateCount += 1;
      appendLog(session, `WARN: 同一状態ハッシュ検出 (${session.sameStateCount}/3)`);
      if (session.sameStateCount >= 3) {
        session.phase = "画面に変化がないため自動停止しました";
        appendLog(session, "STOP: 3回連続で画面状態が変化しなかったため停止");
        return { done: true };
      }
    } else {
      session.lastStateHash = frameData.stateHash;
      session.sameStateCount = 0;
    }
  }

  const hasInteractiveElements =
    frameData.options.length > 0 ||
    frameData.selects.length > 0 ||
    (frameData.textInputs || []).length > 0 ||
    (frameData.inlineInputPills || []).length > 0 ||
    frameData.buttons.length > 0;

  const hasCompletionText = COMPLETION_TEXT_REGEX.test(frameData.pageText || "");

  if (!hasInteractiveElements && !hasCompletionText && (frameData.pageText || "").length < 30) {
    session.phase = "要素の読み込み待機中...";
    appendLog(session, "WAIT: 操作可能な要素が見つかりません");
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 700 };
  }

  // Way-B text-input pills ("入力..." button/pill that mounts an <input> on click)
  const unfilledTextInputs = (frameData.textInputs || []).filter((t) => !t.currentValue);
  if (
    frameData.options.length === 0 &&
    frameData.selects.length === 0 &&
    unfilledTextInputs.length === 0 &&
    (frameData.inlineInputPills || []).length > 0
  ) {
    const pill = frameData.inlineInputPills[0];
    session.phase = `入力欄を開いています (${pill.label})...`;
    await broadcastStatus(tabId);
    const pillRes = await chrome.tabs.sendMessage(
      tabId,
      {
        type: "ELK_EXECUTE_ACTION",
        payload: {
          status: "click_pill",
          pillId: pill.id,
          highlightAnswer: settings.highlightAnswer
        }
      },
      { frameId }
    );
    appendLog(session, `PILL: ${(pillRes?.actionsTaken || [pill.label]).join(" | ")}`);
    return { done: !isAutoMode, customNextDelayMs: 380 };
  }

  // Case F: Zero-Token Deterministic Fast-Path when NO active questions or unfilled inputs remain
  const alreadyAnsweredBaseKey = Boolean(
    frameData.questionBaseKey && session.answeredBlockKeys.has(frameData.questionBaseKey)
  );
  const fastButtons = frameData.buttons || [];
  const fastTextInputs = frameData.textInputs || [];
  const fastSelects = frameData.selects || [];
  const nextNavBtn = fastButtons.find((b) => b.kind === "next");
  const submitNavBtn = fastButtons.find((b) => b.kind === "submit");
  const allInputsCompleted =
    (fastTextInputs.length === 0 && fastSelects.length === 0) ||
    (unfilledTextInputs.length === 0 &&
      (alreadyAnsweredBaseKey || Boolean(nextNavBtn && !submitNavBtn)));

  const allQuestionsAndInputsDone =
    qSummary.activeCount === 0 &&
    (qSummary.lockedCount === 0 || Boolean(nextNavBtn && !submitNavBtn && qSummary.answeredCount > 0)) &&
    frameData.options.length === 0 &&
    (frameData.inlineInputPills || []).length === 0 &&
    (!mc || (mc.unplayedActiveCount === 0 && mc.lockedCount === 0)) &&
    !frameData.isRecordingTask &&
    allInputsCompleted;

  if (allQuestionsAndInputsDone) {
    const fastBtn = nextNavBtn || submitNavBtn;
    if (fastBtn) {
      session.lastReason =
        qSummary.answeredCount > 0 || fastTextInputs.length > 0 || fastSelects.length > 0
          ? `[自動進行] 全問解答済み → 「${fastBtn.text}」をクリック (AIスキップ)`
          : `[自動進行] 解答欄なし → 「${fastBtn.text}」をクリック (AIスキップ)`;
      session.lastAnswerSummary = `[移動] ${fastBtn.text}`;
      session.phase = "次の画面へ移動中...";
      await broadcastStatus(tabId);

      const fastExecRes = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "ELK_EXECUTE_ACTION",
          payload: {
            status: "next_only",
            clickButtonId: fastBtn.id,
            allowGlobalSubmit: true,
            autoSubmit: true,
            clickDelayMs: settings.clickDelayMs,
            highlightAnswer: settings.highlightAnswer
          }
        },
        { frameId }
      );
      appendLog(
        session,
        `FAST-NEXT(0 tokens): "${fastBtn.text}" | ${(fastExecRes?.actionsTaken || ["done"]).join(" | ")}`
      );
      session.stepCount += 1;
      session.lessonStepCount += 1;
      return { done: !isAutoMode, customNextDelayMs: 900 };
    }

    if (!frameData.canScrollMore) {
      if (hasCompletionText || !isAutoMode || session.sameStateCount >= 1) {
        return handleLessonCompletionTransition(tabId, session, frameData, isAutoMode, "FAST-DONE");
      }
      session.phase = "次へボタンの表示を待機中...";
      appendLog(session, "WAIT: 全問済み・ボタン出現待機 (650ms)");
      await broadcastStatus(tabId);
      return { done: false, customNextDelayMs: 650 };
    }
  }

  const allowGlobalSubmit = qSummary.activeCount <= 1 && qSummary.lockedCount === 0;

  // Reset partial/stale clicked letter tiles (e.g. "Never i _ _ _ _ _ _ _") via backspace before calling LLM
  if (
    frameData.isTileQuestion &&
    frameData.tilePartialUsedCount > 0 &&
    frameData.hasTileBackspace &&
    !submitNavBtn &&
    !nextNavBtn &&
    session.lastClearedTileHash !== frameData.stateHash
  ) {
    session.lastClearedTileHash = frameData.stateHash;
    session.phase = `🔄 途中入力タイル (${frameData.tilePartialUsedCount}枚) をリセット中...`;
    await broadcastStatus(tabId);
    const clearRes = await chrome.tabs.sendMessage(
      tabId,
      {
        type: "ELK_EXECUTE_ACTION",
        payload: {
          status: "clear_partial_tiles",
          clickCount: frameData.tilePartialUsedCount + 2
        }
      },
      { frameId }
    );
    appendLog(
      session,
      `TILE CLEAR: ${(clearRes?.actionsTaken || ["backspace reset"]).join(" | ")}`
    );
    if (isAutoMode) {
      return { done: false, customNextDelayMs: 280 };
    }
    await sleep(280, signal);
    const rescanned = await scanBestFrame(
      tabId,
      Array.from(session.answeredBlockKeys),
      false,
      Array.from(session.playedMediaCardKeys)
    );
    if (rescanned?.data) {
      frameData = rescanned.data;
    }
  }

  // --- Audio / Listening Task Handling ---
  let currentAudioTranscript = "";
  let audioWarningNote = "";

  if (frameData.hiddenTranscript) {
    appendLog(
      session,
      `AUDIO: ページ内部から音声スクリプト候補を抽出 (${frameData.hiddenTranscript.length}文字)`
    );
    frameData.sharedContext = [
      frameData.sharedContext,
      `【ページ内の音声スクリプト候補】\n${frameData.hiddenTranscript}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (
    frameData.hasAudioPlayer &&
    (frameData.options.length > 0 ||
      frameData.selects.length > 0 ||
      (frameData.textInputs || []).length > 0)
  ) {
    await ensureTranscriptCacheLoaded();
    const primaryAudioUrl = frameData.activeAudioUrl || "";
    const questionSpecificId = (
      frameData.questionBaseKey ||
      frameData.activeQuestionId ||
      "q0"
    ).slice(0, 140);
    const pageCacheKey = `page:${frameData.url}::${questionSpecificId}`;
    const cachedTranscript =
      (primaryAudioUrl && !/^webaudio:\/\//i.test(primaryAudioUrl)
        ? audioTranscriptCache.get(primaryAudioUrl)
        : null) || audioTranscriptCache.get(pageCacheKey);

    if (cachedTranscript) {
      currentAudioTranscript = cachedTranscript;
      if (session.usage) session.usage.audioCacheHits += 1;
      appendLog(session, `AUDIO: キャッシュ済み文字起こしを使用 (${cachedTranscript.length}文字)`);
      if (!(frameData.sharedContext || "").includes(cachedTranscript)) {
        frameData.sharedContext = [
          frameData.sharedContext,
          `【リスニング音声の文字起こしスクリプト（最優先根拠）】\n${cachedTranscript}`
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    } else {
      const sttCreds = await resolveSttCredentialsAsync(settings, signal);
      if (sttCreds) {
        session.phase = "🎧 音声データを抽出中...";
        await broadcastStatus(tabId);
        try {
          let audioRes = await sendMessageWithTimeout(
            tabId,
            { type: "ELK_FETCH_AUDIO_BASE64", url: primaryAudioUrl || null },
            { frameId },
            6500
          );
          // Fallback: if content script found the URL but hit CORS or cache lock, fetch directly in background Service Worker!
          if ((!audioRes?.ok || !audioRes?.base64) && (audioRes?.url || primaryAudioUrl)) {
            const bgFetched = await fetchAudioInBackground(
              audioRes?.url || primaryAudioUrl,
              signal
            ).catch(() => null);
            if (bgFetched?.ok) {
              audioRes = bgFetched;
            }
          }
          if (audioRes?.ok && audioRes.base64) {
            const isRealAudioUrl =
              Boolean(audioRes.url) && !/^webaudio:\/\//i.test(audioRes.url);
            const audioHash = computeAudioFingerprint(audioRes);
            const existingCached =
              (isRealAudioUrl ? audioTranscriptCache.get(audioRes.url) : null) ||
              (audioHash ? audioTranscriptCache.get(audioHash) : null);
            if (existingCached) {
              currentAudioTranscript = existingCached;
              if (session.usage) session.usage.audioCacheHits += 1;
              audioTranscriptCache.set(pageCacheKey, existingCached);
              appendLog(
                session,
                `AUDIO: 同一音声データのキャッシュを使用 -> Whisperスキップ (${existingCached.length}文字)`
              );
            } else {
              appendLog(
                session,
                `AUDIO: 音声取得成功 (${Math.round(audioRes.sizeBytes / 1024)}KB) -> ${
                  sttCreds.provider
                }で文字起こし中...`
              );
              const candidateOptionTexts = (frameData.options || []).map((o) => o.text);
              if (session.usage) session.usage.sttCalls += 1;
              const transcript = await transcribeAudioBase64(
                sttCreds,
                audioRes,
                candidateOptionTexts,
                signal,
                async (subStep) => {
                  session.phase = `🎧 音声文字起こし中 (${subStep})...`;
                  await broadcastStatus(tabId);
                }
              );
              if (transcript) {
                currentAudioTranscript = transcript;
                await persistTranscriptKeys(
                  [
                    isRealAudioUrl ? audioRes.url : "",
                    audioHash || "",
                    pageCacheKey
                  ],
                  transcript
                );
                appendLog(
                  session,
                  `AUDIO: 文字起こし完了 (${transcript.length}文字): "${transcript.slice(0, 80)}"`
                );
              }
            }

            if (currentAudioTranscript && !(frameData.sharedContext || "").includes(currentAudioTranscript)) {
              frameData.sharedContext = [
                frameData.sharedContext,
                `【リスニング音声の文字起こしスクリプト（最優先根拠）】\n${currentAudioTranscript}`
              ]
                .filter(Boolean)
                .join("\n\n");
            }
          } else {
            audioWarningNote = `⚠️ 音声データ未取得 (${audioRes?.error || "再生URL特定不可"})`;
            appendLog(session, `AUDIO WARN: ${audioRes?.error || "音声取得失敗"}`);
          }
        } catch (audioErr) {
          if (signal?.aborted) return { done: true };
          audioWarningNote = `⚠️ 音声文字起こしエラー (${audioErr?.message || String(audioErr)})`;
          appendLog(
            session,
            `AUDIO ERROR: ${audioErr?.message || String(audioErr)}`
          );
        }
      } else {
        audioWarningNote =
          "⚠️ 音声用APIキー未設定（拡張機能ポップアップ「API設定」一番下の「音声用API Key」にGeminiまたはGroqのキーを設定してください）";
        appendLog(
          session,
          `AUDIO WARN: 音声課題を検出しましたが文字起こし用APIキー(Groq/Gemini/OpenAI)が未設定です`
        );
      }
    }
  }

  let screenshotDataUrl = null;
  if (settings.includeScreenshot) {
    try {
      const tab = await chrome.tabs.get(tabId);
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 70
      });
    } catch (_) {
      screenshotDataUrl = null;
    }
  }

  const shortQPreview = (frameData.activeQuestionText || "")
    .replace(/\s+/g, " ")
    .slice(0, 28);
  session.phase = shortQPreview
    ? `AI解答中: ${shortQPreview}…`
    : `AI思考中 (${settings.model})...`;
  await broadcastStatus(tabId);

  const { systemPrompt, userPrompt, maxOutputTokens } = buildPrompts(
    frameData,
    settings,
    isSameQuestionJustAnswered,
    allowGlobalSubmit
  );

  const validateDecision = (dec) => {
    if (!dec || typeof dec !== "object" || Array.isArray(dec)) {
      return "AIのJSON出力がオブジェクトではありません";
    }
    if (!["answer", "next_only", "completed", "wait"].includes(dec.status)) {
      return `不正なstatus値です (${dec.status || "empty"})`;
    }
    if (dec.status === "answer") {
      const hasOpts = (frameData.options || []).length > 0;
      const hasSels = (frameData.selects || []).length > 0;
      const hasEmptyTxts = (frameData.textInputs || []).some((t) => !t.currentValue);
      const outOpts = Array.isArray(dec.selectedOptionIds) ? dec.selectedOptionIds.filter(Boolean) : [];
      const outSels = Array.isArray(dec.selectValues) ? dec.selectValues.filter((s) => s?.id) : [];
      const outTxts = Array.isArray(dec.textValues) ? dec.textValues.filter((t) => t?.id && String(t.value ?? "").trim() !== "") : [];

      const isTilePool =
        hasOpts &&
        frameData.options.length >= 3 &&
        frameData.options.every((o) => o.type === "tile-order" || (o.text || "").length <= 2);
      let tileMappedIds = null;
      if (isTilePool && typeof dec.spelledAnswer === "string" && dec.spelledAnswer.trim()) {
        const { mappedIds, unmatchedChars } = mapSpelledAnswerToOptionIds(
          dec.spelledAnswer,
          frameData.options
        );
        if (unmatchedChars.length > 0) {
          return `文字タイルと一致しない文字を含んでいます (${dec.spelledAnswer}: 不足=${unmatchedChars.join(",")})`;
        }
        const clearlyTilePuzzle =
          Boolean(frameData.isTileQuestion) &&
          (frameData.options.every((o) => (o.text || "").length === 1) ||
            /(並べ替|文字を|tile|_ _)/i.test(`${frameData.activeQuestionText || ""} ${frameData.sharedContext || ""}`));
        if (clearlyTilePuzzle && mappedIds.length < frameData.options.length) {
          return `文字タイル数が一致しません (${mappedIds.length}/${frameData.options.length}文字使用)`;
        }
        if (mappedIds.length > 0) {
          tileMappedIds = mappedIds;
        }
      }

      if (hasOpts && outOpts.length === 0 && !tileMappedIds) {
        return "AIの選択回答が空でした (selectedOptionIds=[])";
      }
      if (hasSels && outSels.length === 0) return "AIのselect回答が空でした (selectValues=[])";
      if (hasEmptyTxts && outTxts.length === 0) return "AIのテキスト入力回答が空でした (textValues=[])";
    }
    if (dec.status === "next_only" && (frameData.buttons || []).length > 0 && !dec.clickButtonId) {
      return "AIのボタン選択が空でした (clickButtonId=null)";
    }
    return null;
  };

  const t0 = Date.now();
  const decision = await callLLM(
    settings,
    systemPrompt,
    userPrompt,
    screenshotDataUrl,
    signal,
    maxOutputTokens,
    {
      maxAttempts: isAutoMode ? 4 : 2,
      validateDecision,
      onUsage: (u) => recordSessionUsage(session, u),
      onRetry: async ({ attempt, maxAttempts, waitMs, reason }) => {
        const sec = Math.max(1, Math.round(waitMs / 1000));
        session.phase = `⏳ AI応答エラーのため待機後リトライ (${attempt}/${maxAttempts - 1}, ${sec}秒後)...`;
        appendLog(session, `LLM RETRY (${attempt}/${maxAttempts - 1}) in ${sec}s: ${String(reason).slice(0, 90)}`);
        await broadcastStatus(tabId);
      }
    }
  );
  const elapsedMs = Date.now() - t0;

  if (signal?.aborted) return { done: true };

  const audioBadge = currentAudioTranscript
    ? `[🎧 "${currentAudioTranscript.replace(/\s+/g, " ").slice(0, 75)}"] `
    : audioWarningNote
    ? `[${audioWarningNote}] `
    : "";
  session.lastReason = audioBadge + (decision.reason || "");
  appendLog(
    session,
    `AI(${elapsedMs}ms): status=${decision.status} opts=${JSON.stringify(
      decision.selectedOptionIds || []
    )} btn=${decision.clickButtonId || "null"} reason="${(decision.reason || "").slice(0, 60)}"`
  );

  if (decision.status === "completed") {
    return handleLessonCompletionTransition(tabId, session, frameData, isAutoMode, "DONE");
  }

  if (decision.status === "wait") {
    session.phase = "待機中...";
    await broadcastStatus(tabId);
    return { done: false, customNextDelayMs: 1000 };
  }

  let selectedOptionIds = Array.isArray(decision.selectedOptionIds)
    ? decision.selectedOptionIds
    : [];

  // Deterministic letter-tile mapper: if this is a letter-tile anagram question and spelledAnswer is provided,
  // map each non-space character of spelledAnswer to the exact distinct option IDs in frameData.options!
  const isLetterTileQuestion =
    Array.isArray(frameData.options) &&
    frameData.options.length >= 3 &&
    frameData.options.every((o) => o.type === "tile-order" || (o.text || "").length <= 2);

  if (isLetterTileQuestion && typeof decision.spelledAnswer === "string" && decision.spelledAnswer.trim()) {
    const { mappedIds } = mapSpelledAnswerToOptionIds(decision.spelledAnswer, frameData.options);
    if (mappedIds.length >= selectedOptionIds.length && mappedIds.length > 0) {
      selectedOptionIds = mappedIds;
      appendLog(
        session,
        `TILE: spelledAnswer="${decision.spelledAnswer}" -> mapped ${mappedIds.length}/${frameData.options.length} tiles`
      );
    }
  }
  const selectValues = Array.isArray(decision.selectValues) ? decision.selectValues : [];
  const textValues = Array.isArray(decision.textValues) ? decision.textValues : [];
  const shouldAutoSubmit = isAutoMode ? true : Boolean(settings.autoSubmit);
  const clickButtonId = shouldAutoSubmit ? decision.clickButtonId || null : null;

  const chosenLabels = selectedOptionIds
    .map((id) => frameData.options.find((o) => o.id === id)?.text)
    .filter(Boolean)
    .map((t) => (t.length > 32 ? t.slice(0, 32) + "…" : t));
  const typedLabels = textValues
    .map((tv) => (tv?.value ? String(tv.value).trim() : ""))
    .filter(Boolean)
    .map((t) => (t.length > 24 ? t.slice(0, 24) + "…" : t));

  if (chosenLabels.length > 0) {
    session.lastAnswerSummary = chosenLabels.join(" / ");
  } else if (typedLabels.length > 0) {
    session.lastAnswerSummary = typedLabels.join(" / ");
  } else if (decision.status === "next_only" && clickButtonId) {
    const btnText = frameData.buttons.find((b) => b.id === clickButtonId)?.text || "次へ";
    session.lastAnswerSummary = `[移動] ${btnText}`;
  }

  session.phase =
    decision.status === "next_only" ? "次の画面へ移動中..." : "解答を入力・クリック中...";
  await broadcastStatus(tabId);

  const execRes = await chrome.tabs.sendMessage(
    tabId,
    {
      type: "ELK_EXECUTE_ACTION",
      payload: {
        status: decision.status,
        selectedOptionIds,
        selectValues,
        textValues,
        clickButtonId,
        allowGlobalSubmit,
        autoSubmit: shouldAutoSubmit,
        clickDelayMs: settings.clickDelayMs,
        highlightAnswer: settings.highlightAnswer
      }
    },
    { frameId }
  );

  appendLog(session, `EXEC: ${(execRes?.actionsTaken || ["done"]).join(" | ")}`);

  if (
    decision.status === "answer" &&
    (selectedOptionIds.length > 0 || selectValues.length > 0 || textValues.length > 0)
  ) {
    session.solvedCount += 1;
    if (frameData.questionBaseKey) {
      session.answeredBlockKeys.add(frameData.questionBaseKey);
      session.lastAnsweredBaseKey = frameData.questionBaseKey;
      session.lastAnsweredAt = Date.now();
      session.waitedForSameKey = false;
    }
  }

  session.stepCount += 1;
  session.lessonStepCount += 1;
  session.phase = isAutoMode ? "次の問題へ進行中..." : "1問の解答が完了しました";
  await broadcastStatus(tabId);

  const customNextDelayMs =
    qSummary.activeCount > 1 && !clickButtonId
      ? Math.min(700, Number(settings.stepDelayMs) || 1400)
      : undefined;

  return { done: !isAutoMode, customNextDelayMs };
}

async function buildDebugReport(tabId) {
  const settings = await getSettings();
  const session = getOrCreateSession(tabId);

  const bestFrame = await scanBestFrame(
    tabId,
    Array.from(session.answeredBlockKeys),
    true,
    Array.from(session.playedMediaCardKeys)
  );

  const reportObj = {
    generatedAt: new Date().toISOString(),
    config: {
      providerPreset: settings.providerPreset,
      apiFormat: settings.apiFormat,
      baseUrl: settings.baseUrl,
      model: settings.model,
      autoSubmit: settings.autoSubmit,
      stepDelayMs: settings.stepDelayMs,
      clickDelayMs: settings.clickDelayMs,
      includeScreenshot: settings.includeScreenshot
    },
    session: {
      running: session.running,
      phase: session.phase,
      solvedCount: session.solvedCount,
      stepCount: session.stepCount,
      answeredKeysInMemoryCount: session.answeredBlockKeys.size,
      usage: session.usage ? { ...session.usage } : createEmptyUsage(),
      error: session.error
    },
    frameScan: bestFrame
      ? {
          chosenFrameId: bestFrame.frameId,
          totalFramesScanned: bestFrame.totalFramesScanned,
          questionSummary: bestFrame.data.questionSummary,
          activeQuestionId: bestFrame.data.activeQuestionId,
          canScrollMore: bestFrame.data.canScrollMore,
          snapshot: bestFrame.data.debugSnapshot
        }
      : { error: "フレームのスキャンに失敗しました" },
    recentLogs: session.logs.slice(-50)
  };

  return "=== e-learning Killer Diagnostic Report ===\n" + JSON.stringify(reportObj, null, 2);
}

async function startAutoLoop(tabId) {
  const session = getOrCreateSession(tabId);
  if (session.running) return session;

  session.running = true;
  session.mode = "auto";
  session.error = null;
  session.stepCount = 0;
  session.lessonStepCount = 0;
  session.lastStartedCourseLessonKey = "";
  session.attemptedCourseLessonKeys.clear();
  session.courseLessonRetryCounts.clear();
  session.courseWaitCount = 0;
  session.courseScrolledOnce = false;
  session.courseReturnAttempts = 0;
  session.consecutiveStepErrors = 0;
  session.sameStateCount = 0;
  session.lastStateHash = null;
  session.waitedForSameKey = false;
  session.abortController = new AbortController();
  const signal = session.abortController.signal;

  appendLog(session, "=== 全自動モード開始 ===");
  await ensureContentScripts(tabId);
  await broadcastStatus(tabId);

  const outerRetryScheduleMs = [10000, 20000, 35000, 60000];

  (async () => {
    try {
      while (session.running && !signal.aborted) {
        const currentSettings = await getSettings();
        if (session.lessonStepCount >= (currentSettings.maxSteps || 200)) {
          session.phase = `1レッスン内の最大ステップ数 (${currentSettings.maxSteps}) に到達したため停止しました`;
          appendLog(session, "STOP: 最大ステップ数到達");
          break;
        }

        let result;
        try {
          result = await executeSingleStep(tabId, true);
          session.consecutiveStepErrors = 0;
        } catch (stepErr) {
          if (signal.aborted || stepErr?.name === "AbortError") {
            throw stepErr;
          }
          const msg = String(stepErr?.message || stepErr);
          if (/message port closed|Receiving end does not exist|frame was removed/i.test(msg)) {
            session.consecutiveStepErrors += 1;
            if (session.consecutiveStepErrors > 8) throw stepErr;
            appendLog(session, `RETRY: 画面遷移中の通信リセット (${msg.slice(0, 50)})`);
            await sleep(1100, signal);
            continue;
          }
          const isPermanentErr =
            stepErr?.retryable === false ||
            /APIキーが未設定|Base URLが設定されていません|モデル名が設定されていません|認証エラー|APIエラー \(40[13]\)|無効です/i.test(
              msg
            );
          if (!isPermanentErr && session.consecutiveStepErrors < outerRetryScheduleMs.length) {
            const waitMs = outerRetryScheduleMs[session.consecutiveStepErrors];
            session.consecutiveStepErrors += 1;
            const sec = Math.round(waitMs / 1000);
            session.phase = `⏳ エラー発生・待機後に自動リトライ (${session.consecutiveStepErrors}/${outerRetryScheduleMs.length}, ${sec}秒後)...`;
            appendLog(
              session,
              `AUTO RETRY (${session.consecutiveStepErrors}/${outerRetryScheduleMs.length}) after ${sec}s: ${msg.slice(0, 100)}`
            );
            await broadcastStatus(tabId);
            await sleep(waitMs, signal);
            if (signal.aborted) break;
            continue;
          }
          throw stepErr;
        }

        if (result.done || signal.aborted) {
          break;
        }

        const delay =
          result.customNextDelayMs ??
          Math.max(400, Number(currentSettings.stepDelayMs) || 1400);
        await sleep(delay, signal);
      }
    } catch (err) {
      const errMsg = String(err?.message || err);
      const isAbort =
        signal.aborted ||
        err?.name === "AbortError" ||
        /aborted|AbortError/i.test(errMsg);
      if (isAbort) {
        session.error = null;
        session.phase = "停止中";
      } else {
        session.error = errMsg;
        session.phase = "エラーにより停止";
        appendLog(session, `ERROR: ${session.error}`);
      }
    } finally {
      session.running = false;
      session.mode = "idle";
      if (
        session.phase.includes("待機中") ||
        session.phase.includes("思考中") ||
        session.phase.includes("解答中") ||
        session.phase.includes("検出中") ||
        session.phase.includes("進行中") ||
        session.phase.includes("聞き取り中") ||
        session.phase.includes("再生中") ||
        session.phase.includes("移動中") ||
        session.phase.includes("スクロール中") ||
        session.phase.includes("クリック中") ||
        session.phase.includes("開いています") ||
        session.phase.includes("戻っています") ||
        session.phase.includes("スキップ中") ||
        session.phase.includes("リトライ")
      ) {
        session.phase = "停止中";
      }
      appendLog(session, `=== 停止 (phase=${session.phase}) ===`);
      await broadcastStatus(tabId);
    }
  })();

  return session;
}

async function runSolveOnce(tabId) {
  const session = getOrCreateSession(tabId);
  if (session.running) return session;

  session.running = true;
  session.mode = "once";
  session.error = null;
  session.abortController = new AbortController();
  const signal = session.abortController.signal;

  appendLog(session, "--- 1問実行開始 ---");
  await ensureContentScripts(tabId);
  await broadcastStatus(tabId);

  (async () => {
    try {
      await executeSingleStep(tabId, false);
    } catch (err) {
      const errMsg = String(err?.message || err);
      const isAbort =
        signal.aborted ||
        err?.name === "AbortError" ||
        /aborted|AbortError/i.test(errMsg);
      if (isAbort) {
        session.error = null;
        session.phase = "停止中";
      } else if (!/message port closed|frame was removed/i.test(errMsg)) {
        session.error = errMsg;
        session.phase = "エラー";
        appendLog(session, `ERROR: ${session.error}`);
      } else {
        session.phase = "解答・画面遷移完了";
      }
    } finally {
      session.running = false;
      session.mode = "idle";
      await broadcastStatus(tabId);
    }
  })();

  return session;
}

async function stopSession(tabId) {
  const session = getOrCreateSession(tabId);
  session.running = false;
  session.mode = "idle";
  session.phase = "停止中";
  appendLog(session, "USER: 手動停止");
  if (session.abortController) {
    session.abortController.abort();
    session.abortController = null;
  }
  await broadcastStatus(tabId);
  return session;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = tabSessions.get(tabId);
  if (session?.abortController) {
    session.abortController.abort();
  }
  tabSessions.delete(tabId);
});

async function reinjectAllOpenTabs(onlyIfDead = false) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !t.url || !/^(https?|file):/i.test(t.url)) continue;

      if (onlyIfDead) {
        try {
          const pong = await chrome.tabs.sendMessage(
            t.id,
            { type: "ELK_PING" },
            { frameId: 0 }
          );
          if (pong?.ok) continue;
        } catch (_) {
          // Ping failed -> tab has orphaned/missing content script, re-inject!
        }
      }

      // Inject top frame first so restricted cross-origin iframes never block main-frame HUD replacement
      chrome.scripting
        .executeScript({
          target: { tabId: t.id, frameIds: [0] },
          files: ["content.js"]
        })
        .catch(() => {});

      chrome.scripting
        .executeScript({
          target: { tabId: t.id, allFrames: true },
          files: ["content.js"]
        })
        .catch(() => {});
    }
  } catch (_) {}
}

reinjectAllOpenTabs(true);
chrome.runtime.onInstalled.addListener(() => {
  reinjectAllOpenTabs(false);
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const session = getOrCreateSession(tab.id);
  if (command === "toggle-auto") {
    if (session.running) {
      await stopSession(tab.id);
    } else {
      await startAutoLoop(tab.id);
    }
  } else if (command === "solve-once") {
    if (!session.running) {
      await runSolveOnce(tab.id);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }
  if (message?.type === "ELK_LOCAL_STT_PROGRESS") {
    for (const cb of activeProgressListeners) {
      try {
        cb(message);
      } catch (_) {}
    }
    return false;
  }

  (async () => {
    const senderTabId = message.tabId ?? sender?.tab?.id;

    switch (message.type) {
      case "ELK_GET_INIT": {
        const settings = await getSettings();
        const session = senderTabId ? getOrCreateSession(senderTabId) : null;
        sendResponse({
          ok: true,
          presets: PRESETS,
          settings,
          state: session ? serializeSessionState(session) : null
        });
        break;
      }

      case "ELK_SAVE_SETTINGS": {
        const updated = await saveSettings(message.settings || {});
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (t.id) {
            chrome.tabs
              .sendMessage(
                t.id,
                { type: "ELK_SETTINGS_UPDATED", settings: updated },
                { frameId: 0 }
              )
              .catch(() => {});
          }
        }
        sendResponse({ ok: true, settings: updated });
        break;
      }

      case "ELK_TEST_API": {
        const testSettings = { ...(await getSettings()), ...(message.settings || {}) };
        const result = await callLLM(
          testSettings,
          'You are a connection tester. Output strictly JSON: {"ok": true, "message": "接続成功！"}',
          "テスト接続です。JSON形式で応答してください。",
          null,
          null
        );
        sendResponse({ ok: true, result });
        break;
      }

      case "ELK_TEST_STT": {
        const testSettings = { ...(await getSettings()), ...(message.settings || {}) };
        const sttCreds = await resolveSttCredentialsAsync(testSettings, null, {
          allowLocalServerFallback: false
        });
        const lines = [];
        const session = senderTabId ? getOrCreateSession(senderTabId) : null;

        if (!sttCreds) {
          const msg =
            "✗ 選択したクラウド音声プロバイダのAPIキーが未設定です。\nローカルを使う場合は「自動」または「ブラウザ内ローカルAI」/「PCローカルサーバー」を選択してください。";
          if (session) appendLog(session, `STT_TEST: ${msg.replace(/\n/g, " ")}`);
          sendResponse({ ok: false, report: msg, error: msg });
          break;
        }

        if (sttCreds.provider === "local_browser") {
          lines.push(`プロバイダ: ブラウザ内ローカルWhisper (${sttCreds.modelId})`);
        } else if (sttCreds.provider === "local_server") {
          lines.push(`プロバイダ: PCローカルサーバー (${sttCreds.url})`);
        } else {
          const k = sttCreds.apiKey || "";
          const maskedKey = k ? `${k.slice(0, 5)}...${k.slice(-3)} (${k.length}文字)` : "なし";
          lines.push(`プロバイダ: ${sttCreds.provider} / キー: ${maskedKey}`);
        }

        // 1. Try to extract real audio from the current tab first
        let audioRes = null;
        let candidateOptions = [];
        if (senderTabId) {
          try {
            const bestFrame = await scanBestFrame(senderTabId, [], false);
            if (bestFrame?.data) {
              const fd = bestFrame.data;
              candidateOptions = (fd.options || []).map((o) => o.text);
              const primaryUrl = fd.activeAudioUrl || fd.audioUrls?.[0] || null;
              if (fd.hasAudioPlayer || primaryUrl) {
                audioRes = await sendMessageWithTimeout(
                  senderTabId,
                  { type: "ELK_FETCH_AUDIO_BASE64", url: primaryUrl },
                  { frameId: bestFrame.frameId },
                  6500
                );
                if ((!audioRes?.ok || !audioRes?.base64) && (audioRes?.url || primaryUrl)) {
                  const bgAudio = await fetchAudioInBackground(
                    audioRes?.url || primaryUrl,
                    null
                  ).catch(() => null);
                  if (bgAudio?.ok) audioRes = bgAudio;
                }
              }
            }
          } catch (_) {}
        }

        let isSyntheticAudio = false;
        if (audioRes?.ok && audioRes?.base64) {
          const shortUrl = (audioRes.url || "captured").split("/").pop();
          lines.push(
            `音源: 現在のタブから取得成功 (${Math.round(audioRes.sizeBytes / 1024)}KB, ${
              audioRes.mimeType
            }, ${shortUrl})`
          );
          if (candidateOptions.length > 0) {
            lines.push(`選択肢ヒント: [${candidateOptions.join(", ")}]`);
          }
        } else {
          isSyntheticAudio = true;
          const sampleRate = 16000;
          const numSamples = 16000;
          const buf = new ArrayBuffer(44 + numSamples * 2);
          const view = new DataView(buf);
          const wStr = (off, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
          };
          wStr(0, "RIFF");
          view.setUint32(4, 36 + numSamples * 2, true);
          wStr(8, "WAVE");
          wStr(12, "fmt ");
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          wStr(36, "data");
          view.setUint32(40, numSamples * 2, true);
          for (let i = 0; i < numSamples; i++) {
            const val = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.08;
            view.setInt16(44 + i * 2, val * 0x7fff, true);
          }
          audioRes = {
            ok: true,
            url: "synthetic://test.wav",
            mimeType: "audio/wav",
            sizeBytes: buf.byteLength,
            base64: arrayBufferToBase64Bg(buf)
          };
          lines.push("音源: タブ上に音声問題がないためテスト用WAV(32KB)で疎通・モデル確認");
        }

        // 2. If Gemini, clear cache and show discovered models from ListModels
        if (sttCreds.provider === "gemini" && sttCreds.apiKey) {
          geminiModelListCache.clear();
          deadGeminiModels.clear();
          try {
            const disc = await discoverGeminiModels(sttCreds.apiKey, null);
            lines.push(
              `Gemini検出モデル(${disc.apiVersion}): ${disc.models.slice(0, 5).join(", ")}`
            );
          } catch (discErr) {
            lines.push(`Geminiモデル一覧取得エラー: ${discErr?.message || String(discErr)}`);
          }
        }

        // 3. Run transcription
        const t0 = Date.now();
        try {
          const transcript = await transcribeAudioBase64(
            sttCreds,
            audioRes,
            candidateOptions,
            null,
            async (step) => {
              chrome.runtime.sendMessage({ type: "ELK_STT_TEST_PROGRESS", step }).catch(() => {});
            }
          );
          const elapsedMs = Date.now() - t0;
          const displayTranscript =
            isSyntheticAudio && (!transcript || /^\[.*\]$/.test(transcript))
              ? `(推論エンジン正常完了 / 無音声テスト波形: "${transcript || ""}")`
              : `"${transcript}"`;
          lines.push(`✓ 文字起こし結果 (${elapsedMs}ms):\n${displayTranscript}`);
          const report = lines.join("\n");
          if (session) {
            for (const l of lines) appendLog(session, `STT_TEST: ${l.replace(/\n/g, " ")}`);
          }
          sendResponse({
            ok: true,
            elapsedMs,
            transcript: transcript || displayTranscript,
            report
          });
        } catch (sttErr) {
          const elapsedMs = Date.now() - t0;
          const errMsg = sttErr?.message || String(sttErr);
          lines.push(`✗ エラー (${elapsedMs}ms):\n${errMsg}`);
          const report = lines.join("\n");
          if (session) {
            for (const l of lines) appendLog(session, `STT_TEST: ${l.replace(/\n/g, " ")}`);
          }
          sendResponse({ ok: false, elapsedMs, error: errMsg, report });
        }
        break;
      }

      case "ELK_START_AUTO": {
        if (!senderTabId) throw new Error("対象のタブが見つかりません");
        await startAutoLoop(senderTabId);
        sendResponse({ ok: true });
        break;
      }

      case "ELK_SOLVE_ONCE": {
        if (!senderTabId) throw new Error("対象のタブが見つかりません");
        await runSolveOnce(senderTabId);
        sendResponse({ ok: true });
        break;
      }

      case "ELK_STOP": {
        if (!senderTabId) throw new Error("対象のタブが見つかりません");
        await stopSession(senderTabId);
        sendResponse({ ok: true });
        break;
      }

      case "ELK_RESET_COUNT": {
        if (senderTabId) {
          const s = getOrCreateSession(senderTabId);
          s.solvedCount = 0;
          s.stepCount = 0;
          s.lessonStepCount = 0;
          s.lastStartedCourseLessonKey = "";
          s.attemptedCourseLessonKeys.clear();
          s.courseLessonRetryCounts.clear();
          s.courseWaitCount = 0;
          s.courseScrolledOnce = false;
          s.courseReturnAttempts = 0;
          s.consecutiveStepErrors = 0;
          resetPerLessonState(s);
          s.lastReason = "";
          s.lastAnswerSummary = "";
          s.usage = createEmptyUsage();
          s.error = null;
          s.logs = [];
          await broadcastStatus(senderTabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case "ELK_BUILD_DEBUG_REPORT": {
        if (!senderTabId) throw new Error("対象のタブが見つかりません");
        const report = await buildDebugReport(senderTabId);
        sendResponse({ ok: true, report });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });

  return true;
});
