// offscreen.js - In-Browser Audio Decoder (16kHz Mono PCM) & Local Whisper WASM Worker
import { env, pipeline } from "./vendor/transformers/transformers.min.js";

const wasmBase = chrome.runtime.getURL("vendor/transformers/");
env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${wasmBase}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${wasmBase}ort-wasm-simd-threaded.asyncify.wasm`
  };
}

let cachedModelId = null;
let cachedPipeline = null;
let loadingPromise = null;

function base64ToUint8Array(base64) {
  const bin = atob(base64);
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
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
      const ch0 = decoded.getChannelData(0);
      const ch1 = decoded.getChannelData(1);
      for (let i = 0; i < decoded.length; i++) {
        outCh[i] = (ch0[i] + ch1[i]) * 0.5;
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
    await audioCtx.close().catch(() => {});
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

  loadingPromise = pipeline("automatic-speech-recognition", modelId, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (prog) => {
      if (prog?.status === "progress" && typeof prog.progress === "number") {
        const pct = Math.round(prog.progress);
        if (pct !== lastPctSent && (pct === 100 || pct - lastPctSent >= 8)) {
          lastPctSent = pct;
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
    }
  })
    .then((pipe) => {
      cachedPipeline = pipe;
      loadingPromise = null;
      return pipe;
    })
    .catch((err) => {
      loadingPromise = null;
      cachedPipeline = null;
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
        sendResponse({ ok: true, modelLoaded: Boolean(cachedPipeline), modelId: cachedModelId });
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
