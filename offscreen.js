// offscreen.js - In-Browser Audio Decoder (16kHz Mono PCM) & Local Whisper WASM Worker
import { env, pipeline } from "./vendor/transformers/transformers.min.js";

// Suppress Chromium's Windows WebGPU powerPreference deprecation warning when ORT WASM probes adapter
if (
  typeof navigator !== "undefined" &&
  /Windows/i.test(navigator.userAgent || "") &&
  typeof navigator.gpu?.requestAdapter === "function"
) {
  const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = (options) => {
    if (options && typeof options === "object" && "powerPreference" in options) {
      const sanitized = { ...options };
      delete sanitized.powerPreference;
      return origRequestAdapter(sanitized);
    }
    return origRequestAdapter(options);
  };
}

function configureTransformersEnv() {
  const wasmBase = chrome.runtime.getURL("vendor/transformers/");
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // Disable ORT WASM pre-cache in extension pages (chrome-extension:// cannot be stored in Cache API).
  // Keep enabled under Deno test runtime because transformers.js blocks useWasmCache=false in Deno.
  if (typeof globalThis.Deno === "undefined") {
    env.useWasmCache = false;
  }
  env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === "string" ? request : request?.url || "";
      if (!/^https?:/i.test(url) || typeof caches === "undefined") {
        return undefined;
      }
      try {
        const cache = await caches.open(env.cacheKey || "transformers-cache");
        return await cache.match(request);
      } catch (_) {
        return undefined;
      }
    },
    async put(request, response) {
      const url = typeof request === "string" ? request : request?.url || "";
      if (!/^https?:/i.test(url) || typeof caches === "undefined") {
        return;
      }
      try {
        const cache = await caches.open(env.cacheKey || "transformers-cache");
        await cache.put(request, response);
      } catch (_) {
        // Ignore cache storage errors (e.g. quota limits) without failing inference
      }
    }
  };
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = {
      mjs: `${wasmBase}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${wasmBase}ort-wasm-simd-threaded.asyncify.wasm`
    };
  }
}

configureTransformersEnv();

let cachedModelId = null;
let cachedPipeline = null;
let loadingPromise = null;

function base64ToUint8Array(base64) {
  const cleaned = String(base64 || "")
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Decode any browser-playable audio (mp3, m4a, ogg, wav) into 16kHz mono Float32Array
async function decodeAudioTo16kFloat32(base64) {
  const bytes = base64ToUint8Array(base64);
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioCtx ? new AudioCtx() : new OfflineAudioContext(1, 1, 16000);
  try {
    const decoded = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
    const targetRate = 16000;
    const outLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, outLength, targetRate);
    const source = offline.createBufferSource();

    // Downmix multi-channel to mono cleanly before rendering
    if (decoded.numberOfChannels > 1) {
      const monoBuf = offline.createBuffer(1, decoded.length, decoded.sampleRate);
      const outCh = monoBuf.getChannelData(0);
      const channels = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(decoded.getChannelData(c));
      }
      const scale = 1 / channels.length;
      for (let i = 0; i < decoded.length; i++) {
        let sum = 0;
        for (let c = 0; c < channels.length; c++) {
          sum += channels[c][i];
        }
        outCh[i] = sum * scale;
      }
      source.buffer = monoBuf;
    } else {
      source.buffer = decoded;
    }

    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return {
      samples: rendered.getChannelData(0),
      sampleRate: targetRate,
      durationSec: rendered.duration
    };
  } finally {
    if (typeof audioCtx.close === "function") {
      await audioCtx.close().catch(() => {});
    }
  }
}

function encodeFloat32ToWavBytes(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

async function loadWhisperPipelineWithFallback(modelId, emitProgress) {
  const dtypeCandidates = ["q8", "int8", null];
  let lastError = null;
  for (const dtype of dtypeCandidates) {
    try {
      const opts = {
        device: "wasm",
        progress_callback: emitProgress
      };
      if (dtype) {
        opts.dtype = dtype;
      }
      return await pipeline("automatic-speech-recognition", modelId, opts);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Whisper WASMモデルの読み込みに失敗しました (${modelId})`);
}

async function getWhisperPipeline(modelId) {
  if (cachedPipeline && cachedModelId === modelId) {
    return cachedPipeline;
  }
  if (loadingPromise && cachedModelId === modelId) {
    return loadingPromise;
  }

  cachedModelId = modelId;
  cachedPipeline = null;
  let lastPctSent = -1;
  let lastProgressSentAt = 0;

  const emitProgress = (prog) => {
    if (prog?.status === "progress" && typeof prog.progress === "number") {
      const pct = Math.round(prog.progress);
      const now = Date.now();
      if (
        pct !== lastPctSent &&
        (pct === 100 || pct - lastPctSent >= 8 || now - lastProgressSentAt >= 12000)
      ) {
        lastPctSent = pct;
        lastProgressSentAt = now;
        chrome.runtime
          .sendMessage({
            type: "ELK_LOCAL_STT_PROGRESS",
            modelId,
            file: prog.file || "",
            progress: pct
          })
          .catch(() => {});
      }
    }
  };

  loadingPromise = loadWhisperPipelineWithFallback(modelId, emitProgress)
    .then((pipe) => {
      cachedPipeline = pipe;
      loadingPromise = null;
      return pipe;
    })
    .catch((err) => {
      loadingPromise = null;
      cachedPipeline = null;
      cachedModelId = null;
      throw err;
    });

  return loadingPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  (async () => {
    switch (message.type) {
      case "ELK_OFFSCREEN_PING": {
        sendResponse({
          ok: true,
          modelLoaded: Boolean(cachedPipeline),
          modelId: cachedModelId,
          useWasmCache: env.useWasmCache,
          useCustomCache: env.useCustomCache
        });
        break;
      }

      case "ELK_OFFSCREEN_DECODE_WAV": {
        const { samples, sampleRate, durationSec } = await decodeAudioTo16kFloat32(message.base64);
        const wavBytes = encodeFloat32ToWavBytes(samples, sampleRate);
        sendResponse({
          ok: true,
          mimeType: "audio/wav",
          durationSec,
          sizeBytes: wavBytes.byteLength,
          base64: uint8ArrayToBase64(wavBytes)
        });
        break;
      }

      case "ELK_OFFSCREEN_TRANSCRIBE_LOCAL": {
        const t0 = Date.now();
        const modelId = message.modelId || "onnx-community/whisper-base.en";
        const { samples, durationSec } = await decodeAudioTo16kFloat32(message.base64);
        const transcriber = await getWhisperPipeline(modelId);

        const inferOpts = {};
        if (durationSec > 28) {
          inferOpts.chunk_length_s = 28;
          inferOpts.stride_length_s = 5;
        }
        if (!modelId.endsWith(".en")) {
          const hint = String(message.candidateHint || "");
          const hasJa = /[\u3040-\u30ff\u4e00-\u9faf]/.test(hint);
          const hasEn = /[a-zA-Z]{2,}/.test(hint);
          if (hasEn && !hasJa) {
            inferOpts.language = "english";
          }
          inferOpts.task = "transcribe";
        }

        const output = await transcriber(samples, inferOpts);
        const rawText = Array.isArray(output)
          ? output.map((o) => o?.text || "").join(" ")
          : output?.text || "";
        const text = rawText.replace(/\s+/g, " ").trim();
        const elapsedMs = Date.now() - t0;

        sendResponse({
          ok: true,
          text,
          modelId,
          durationSec: Number(durationSec.toFixed(2)),
          elapsedMs
        });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown offscreen message type" });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });

  return true;
});
