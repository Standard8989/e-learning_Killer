// hud.js - Shared Floating HUD & Audio Fetch Helpers for e-learning Killer adapters

(() => {
  /**
   * Convert an ArrayBuffer into base64 in fixed chunks to prevent call-stack overflow.
   * @param {ArrayBuffer} buf
   * @returns {string}
   */
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Fetch an audio URL inside the page context (sharing session cookies) and encode as base64.
   * Uses cache: "no-store" + 4s timeout to avoid Chromium cache lock stalls on active <audio> elements.
   * @param {string} url
   */
  async function fetchAudioFromUrl(url) {
    if (!url) {
      return { ok: false, error: "音声ファイルのURLを特定できませんでした" };
    }

    let res = null;
    for (const credMode of ["include", "omit"]) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        res = await fetch(url, {
          credentials: credMode,
          cache: "no-store",
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.ok) break;
      } catch (_) {
        clearTimeout(timer);
        res = null;
      }
    }

    if (!res || !res.ok) {
      return {
        ok: false,
        url,
        error: `ページ内音声取得タイムアウトまたは失敗 (${res?.status || "CORS/Lock"})`
      };
    }

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
    if (buf.byteLength > 20 * 1024 * 1024) {
      return { ok: false, url, error: "音声ファイルが大きすぎます (>20MB)" };
    }

    return {
      ok: true,
      url,
      mimeType,
      sizeBytes: buf.byteLength,
      base64: arrayBufferToBase64(buf)
    };
  }

  /**
   * Mount the shared Shadow DOM floating HUD for the active adapter instance.
   */
  function createHud(opts) {
    const {
      hostId = "__elk_hud_host__",
      isAlive,
      isContextValid,
      cleanupCallbacks,
      getVisible,
      setVisible,
      onDestroy,
      brandBadge = ""
    } = opts || {};

    if (typeof isAlive === "function" && !isAlive()) return null;
    if (window !== window.top) return null;

    const existing = document.getElementById(hostId);
    if (existing) existing.remove();

    const host = document.createElement("div");
    host.id = hostId;
    host.style.cssText =
      "all: initial; position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;";

    const badgeHtml = brandBadge
      ? `<span class="site-badge">${String(brandBadge).replace(/[<>&]/g, "")}</span>`
      : "";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Meiryo, sans-serif; }
        .hud {
          width: 316px;
          background: rgba(15, 23, 42, 0.94);
          backdrop-filter: blur(10px);
          color: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.28);
          border-radius: 14px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
          overflow: hidden;
          font-size: 12.5px;
          user-select: none;
        }
        .hud.hidden { display: none; }
        .hud.minimized .body { display: none; }
        .hud.minimized { width: auto; min-width: 195px; }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          background: rgba(30, 41, 59, 0.88);
          border-bottom: 1px solid rgba(148, 163, 184, 0.16);
          cursor: grab;
        }
        .header:active { cursor: grabbing; }
        .brand {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 700;
          font-size: 12px;
        }
        .site-badge {
          background: rgba(56, 189, 248, 0.18);
          color: #7dd3fc;
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 5px;
          padding: 0 5px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.03em;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #64748b;
          flex-shrink: 0;
        }
        .dot.running {
          background: #10b981;
          box-shadow: 0 0 8px #10b981;
          animation: pulse 1.3s infinite;
        }
        .dot.error {
          background: #ef4444;
          box-shadow: 0 0 8px #ef4444;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.86); }
        }
        .header-btns {
          display: flex;
          align-items: center;
          gap: 3px;
        }
        .badge {
          background: rgba(16, 185, 129, 0.18);
          color: #34d399;
          border: 1px solid rgba(16, 185, 129, 0.35);
          border-radius: 999px;
          padding: 1px 7px;
          font-size: 11px;
          font-weight: 600;
          margin-right: 2px;
        }
        .icon-btn {
          background: transparent;
          border: 1px solid transparent;
          color: #94a3b8;
          cursor: pointer;
          padding: 2px 5px;
          border-radius: 5px;
          font-size: 12px;
          line-height: 1.1;
        }
        .icon-btn:hover, .icon-btn.active {
          background: rgba(255,255,255,0.12);
          color: #fff;
        }
        .body { padding: 10px 11px 11px; display: flex; flex-direction: column; gap: 8px; }
        .phase {
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .usage-line {
          color: #94a3b8;
          font-size: 10.5px;
          display: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .usage-line.visible { display: block; }
        .answer-box {
          background: rgba(30, 41, 59, 0.7);
          border: 1px solid rgba(148, 163, 184, 0.15);
          border-radius: 8px;
          padding: 6px 8px;
          font-size: 11.5px;
          line-height: 1.4;
          color: #e2e8f0;
          display: none;
        }
        .answer-box.visible { display: block; }
        .answer-main { color: #34d399; font-weight: 600; margin-bottom: 2px; word-break: break-word; }
        .answer-reason { color: #94a3b8; font-size: 11px; word-break: break-word; }
        .error-box {
          background: rgba(127, 29, 29, 0.45);
          border: 1px solid rgba(248, 113, 113, 0.4);
          color: #fecaca;
          border-radius: 8px;
          padding: 6px 8px;
          font-size: 11px;
          line-height: 1.35;
          display: none;
          word-break: break-word;
        }
        .error-box.visible { display: block; }
        .controls {
          display: grid;
          grid-template-columns: 1.35fr 1fr;
          gap: 6px;
        }
        .btn {
          border: none;
          border-radius: 8px;
          padding: 7px 9px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: filter 0.15s ease, transform 0.05s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        .btn:active { transform: translateY(1px); }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-primary {
          background: linear-gradient(135deg, #10b981, #059669);
          color: #ffffff;
        }
        .btn-stop {
          background: linear-gradient(135deg, #ef4444, #dc2626);
          color: #ffffff;
        }
        .btn-secondary {
          background: rgba(51, 65, 85, 0.9);
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.25);
        }
        .btn:hover:not(:disabled) { filter: brightness(1.08); }
        .debug-drawer {
          display: none;
          flex-direction: column;
          gap: 5px;
          border-top: 1px solid rgba(148, 163, 184, 0.18);
          padding-top: 7px;
        }
        .debug-drawer.open { display: flex; }
        .debug-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
        }
        .mini-btn {
          background: rgba(51, 65, 85, 0.85);
          border: 1px solid rgba(148, 163, 184, 0.28);
          color: #e2e8f0;
          border-radius: 6px;
          padding: 3px 7px;
          font-size: 10.5px;
          font-weight: 600;
          cursor: pointer;
        }
        .mini-btn:hover { background: rgba(71, 85, 105, 0.95); }
        .log-box {
          background: rgba(2, 6, 23, 0.85);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 7px;
          padding: 6px 7px;
          max-height: 155px;
          overflow-y: auto;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 10px;
          line-height: 1.42;
          color: #cbd5e1;
          white-space: pre-wrap;
          word-break: break-all;
          user-select: text;
        }
      </style>
      <div class="hud" id="hudRoot">
        <div class="header" id="dragHandle">
          <div class="brand">
            <span class="dot" id="statusDot"></span>
            <span>e-learning Killer</span>
            ${badgeHtml}
          </div>
          <div class="header-btns">
            <span class="badge" id="countBadge">0問</span>
            <button class="icon-btn" id="testAudioHudBtn" title="音声文字起こしテスト">🎧</button>
            <button class="icon-btn" id="debugToggleBtn" title="デバッグログ表示">🐞</button>
            <button class="icon-btn" id="copyDebugBtn" title="デバッグ診断レポートをコピー">📋</button>
            <button class="icon-btn" id="minBtn" title="最小化 / 展開">_</button>
          </div>
        </div>
        <div class="body">
          <div class="phase" id="phaseText">待機中</div>
          <div class="usage-line" id="usageLine"></div>
          <div class="answer-box" id="answerBox">
            <div class="answer-main" id="answerMain"></div>
            <div class="answer-reason" id="answerReason"></div>
          </div>
          <div class="error-box" id="errorBox"></div>
          <div class="controls">
            <button class="btn btn-primary" id="toggleAutoBtn">▶ 全自動開始</button>
            <button class="btn btn-secondary" id="solveOnceBtn">⚡ 1問解く</button>
          </div>
          <div class="debug-drawer" id="debugDrawer">
            <div class="debug-toolbar">
              <button class="mini-btn" id="testAudioDrawerBtn">🎧 音声テスト</button>
              <button class="mini-btn" id="inspectDomBtn">🔍 DOM診断</button>
              <button class="mini-btn" id="copyFullReportBtn">📋 コピー</button>
            </div>
            <div class="log-box" id="logBox">ログ待機中... (🐞で開閉 / 📋で詳細コピー)</div>
          </div>
        </div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(host);

    const hudRoot = shadow.getElementById("hudRoot");
    const dragHandle = shadow.getElementById("dragHandle");
    const statusDot = shadow.getElementById("statusDot");
    const countBadge = shadow.getElementById("countBadge");
    const testAudioHudBtn = shadow.getElementById("testAudioHudBtn");
    const debugToggleBtn = shadow.getElementById("debugToggleBtn");
    const copyDebugBtn = shadow.getElementById("copyDebugBtn");
    const minBtn = shadow.getElementById("minBtn");
    const phaseText = shadow.getElementById("phaseText");
    const usageLine = shadow.getElementById("usageLine");
    const answerBox = shadow.getElementById("answerBox");
    const answerMain = shadow.getElementById("answerMain");
    const answerReason = shadow.getElementById("answerReason");
    const errorBox = shadow.getElementById("errorBox");
    const toggleAutoBtn = shadow.getElementById("toggleAutoBtn");
    const solveOnceBtn = shadow.getElementById("solveOnceBtn");
    const debugDrawer = shadow.getElementById("debugDrawer");
    const testAudioDrawerBtn = shadow.getElementById("testAudioDrawerBtn");
    const inspectDomBtn = shadow.getElementById("inspectDomBtn");
    const copyFullReportBtn = shadow.getElementById("copyFullReportBtn");
    const logBox = shadow.getElementById("logBox");

    let isRunning = false;

    function clampHudToViewport() {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const margin = 8;
      const maxRight = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxBottom = Math.max(margin, window.innerHeight - rect.height - margin);
      const curRight = parseFloat(host.style.right) || 18;
      const curBottom = parseFloat(host.style.bottom) || 18;
      host.style.right = `${Math.min(maxRight, Math.max(margin, curRight))}px`;
      host.style.bottom = `${Math.min(maxBottom, Math.max(margin, curBottom))}px`;
    }

    function toggleWithHeaderAnchor(mutateFn) {
      const beforeRect = host.getBoundingClientRect();
      const inUpperHalf = beforeRect.top < window.innerHeight * 0.55;
      mutateFn();
      if (inUpperHalf) {
        const afterRect = host.getBoundingClientRect();
        const targetBottom = window.innerHeight - beforeRect.top - afterRect.height;
        host.style.bottom = `${targetBottom}px`;
      }
      clampHudToViewport();
    }

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWithHeaderAnchor(() => {
        hudRoot.classList.toggle("minimized");
      });
    });

    debugToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWithHeaderAnchor(() => {
        hudRoot.classList.remove("minimized");
        debugDrawer.classList.toggle("open");
        debugToggleBtn.classList.toggle("active", debugDrawer.classList.contains("open"));
      });
    });

    function showInvalidatedNotice() {
      errorBox.classList.add("visible");
      errorBox.textContent =
        "拡張機能が更新されました。ページを再読み込み(F5)してください。";
      phaseText.textContent = "要リロード (F5)";
    }

    async function safeSendMessage(msg) {
      if (typeof isContextValid === "function" && !isContextValid()) {
        showInvalidatedNotice();
        return { ok: false, invalidated: true, error: "Extension context invalidated" };
      }
      try {
        return await chrome.runtime.sendMessage(msg);
      } catch (err) {
        const m = String(err?.message || err);
        if (/context invalidated/i.test(m) || (typeof isContextValid === "function" && !isContextValid())) {
          showInvalidatedNotice();
          return { ok: false, invalidated: true, error: m };
        }
        return { ok: false, error: m };
      }
    }

    async function handleCopyReport(triggerEl) {
      const orig = triggerEl.textContent;
      triggerEl.textContent = "⏳";
      try {
        const res = await safeSendMessage({ type: "ELK_BUILD_DEBUG_REPORT" });
        if (res?.ok && res.report) {
          await navigator.clipboard.writeText(res.report);
          triggerEl.textContent = "✓";
          toggleWithHeaderAnchor(() => {
            hudRoot.classList.remove("minimized");
            debugDrawer.classList.add("open");
            debugToggleBtn.classList.add("active");
            logBox.textContent =
              "✓ 診断レポートをクリップボードにコピーしました！そのままチャットに貼り付けられます。\n\n" +
              res.report.slice(0, 1200) +
              "\n...";
          });
        } else {
          triggerEl.textContent = "✗";
        }
      } catch (_) {
        triggerEl.textContent = "✗";
      }
      setTimeout(() => {
        triggerEl.textContent = orig;
      }, 1500);
    }

    copyDebugBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleCopyReport(copyDebugBtn);
    });

    copyFullReportBtn.addEventListener("click", () => {
      handleCopyReport(copyFullReportBtn);
    });

    inspectDomBtn.addEventListener("click", async () => {
      logBox.textContent = "画面DOMをスキャン中...";
      const res = await safeSendMessage({ type: "ELK_BUILD_DEBUG_REPORT" });
      if (res?.ok && res.report) {
        logBox.textContent = res.report;
      } else {
        logBox.textContent = "診断エラー: " + (res?.error || "不明");
      }
    });

    async function handleAudioTestOnHud() {
      toggleWithHeaderAnchor(() => {
        hudRoot.classList.remove("minimized");
        debugDrawer.classList.add("open");
        debugToggleBtn.classList.add("active");
      });
      phaseText.textContent = "🎧 音声文字起こしテスト中...";
      logBox.textContent = "現在の問題の音声を抽出して文字起こしテストを実行しています (最大15秒)...";
      const res = await safeSendMessage({ type: "ELK_TEST_STT" });
      if (res?.ok) {
        phaseText.textContent = `✓ 音声テスト成功 (${res.elapsedMs}ms)`;
        answerBox.classList.add("visible");
        answerMain.textContent = "🎧 文字起こしテスト成功";
        answerReason.textContent = res.transcript || "";
        errorBox.classList.remove("visible");
        logBox.textContent = res.report || res.transcript || "成功";
      } else {
        phaseText.textContent = "✗ 音声テスト失敗";
        errorBox.classList.add("visible");
        errorBox.textContent = res?.error || "音声文字起こしテストに失敗しました";
        logBox.textContent = res?.report || res?.error || "失敗";
      }
      clampHudToViewport();
    }

    if (testAudioHudBtn) {
      testAudioHudBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAudioTestOnHud();
      });
    }
    if (testAudioDrawerBtn) {
      testAudioDrawerBtn.addEventListener("click", () => {
        handleAudioTestOnHud();
      });
    }

    toggleAutoBtn.addEventListener("click", () => {
      if (isRunning) {
        safeSendMessage({ type: "ELK_STOP" });
      } else {
        safeSendMessage({ type: "ELK_START_AUTO" });
      }
    });

    solveOnceBtn.addEventListener("click", () => {
      if (!isRunning) {
        safeSendMessage({ type: "ELK_SOLVE_ONCE" });
      }
    });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origRight = 18;
    let origBottom = 18;

    dragHandle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origRight = parseFloat(host.style.right) || 18;
      origBottom = parseFloat(host.style.bottom) || 18;
    });

    const onMouseMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      host.style.right = `${origRight - dx}px`;
      host.style.bottom = `${origBottom - dy}px`;
      clampHudToViewport();
    };

    const onMouseUp = () => {
      dragging = false;
    };

    const onWindowResize = () => {
      clampHudToViewport();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("resize", onWindowResize);

    if (Array.isArray(cleanupCallbacks)) {
      cleanupCallbacks.push(() => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("resize", onWindowResize);
        host.remove();
        if (typeof onDestroy === "function") onDestroy();
      });
    }

    const refs = {
      host,
      hudRoot,
      update(state) {
        if (!state) return;
        const beforeRect = host.getBoundingClientRect();
        const inUpperHalf = beforeRect.top < window.innerHeight * 0.55;

        isRunning = Boolean(state.running);
        statusDot.className = "dot" + (state.error ? " error" : isRunning ? " running" : "");
        countBadge.textContent = `${state.solvedCount || 0}問`;
        phaseText.textContent = state.phase || (isRunning ? "実行中..." : "待機中");

        const u = state.usage;
        if (u && (u.llmCalls > 0 || u.sttCalls > 0 || u.audioCacheHits > 0)) {
          const totalTok = (u.promptTokens || 0) + (u.completionTokens || 0);
          const tokStr = totalTok >= 1000 ? `${(totalTok / 1000).toFixed(1)}k` : `${totalTok}`;
          const cachePct =
            u.promptTokens > 0 ? Math.round(((u.cachedTokens || 0) / u.promptTokens) * 100) : 0;
          const parts = [];
          if (u.llmCalls > 0) {
            parts.push(
              `AI ${u.llmCalls}回 · ${tokStr} tok${cachePct > 0 ? ` (キャッシュ${cachePct}%)` : ""}`
            );
          }
          if (u.sttCalls > 0 || u.audioCacheHits > 0) {
            parts.push(`STT ${u.sttCalls || 0} (Hit ${u.audioCacheHits || 0})`);
          }
          usageLine.textContent = parts.join(" · ");
          usageLine.classList.add("visible");
        } else {
          usageLine.textContent = "";
          usageLine.classList.remove("visible");
        }

        if (state.lastAnswerSummary || state.lastReason) {
          answerBox.classList.add("visible");
          answerMain.textContent = state.lastAnswerSummary ? `✓ ${state.lastAnswerSummary}` : "";
          answerReason.textContent = state.lastReason || "";
        } else {
          answerBox.classList.remove("visible");
        }

        if (state.error) {
          errorBox.classList.add("visible");
          errorBox.textContent = state.error;
        } else {
          errorBox.classList.remove("visible");
        }

        if (Array.isArray(state.logs) && state.logs.length > 0) {
          logBox.textContent = state.logs.slice(-25).join("\n");
          logBox.scrollTop = logBox.scrollHeight;
        }

        if (isRunning) {
          toggleAutoBtn.className = "btn btn-stop";
          toggleAutoBtn.textContent = "⏹ 停止する";
          solveOnceBtn.disabled = true;
        } else {
          toggleAutoBtn.className = "btn btn-primary";
          toggleAutoBtn.textContent = "▶ 全自動開始";
          solveOnceBtn.disabled = false;
        }

        if (inUpperHalf && beforeRect.height > 0) {
          const afterRect = host.getBoundingClientRect();
          host.style.bottom = `${window.innerHeight - beforeRect.top - afterRect.height}px`;
        }
        clampHudToViewport();
      },
      setVisible(visible) {
        if (typeof setVisible === "function") setVisible(Boolean(visible));
        hudRoot.classList.toggle("hidden", !visible);
      }
    };

    const initialVisible = typeof getVisible === "function" ? getVisible() : true;
    refs.setVisible(initialVisible);
    return refs;
  }

  globalThis.__elkArrayBufferToBase64 = arrayBufferToBase64;
  globalThis.__elkFetchAudioFromUrl = fetchAudioFromUrl;
  globalThis.__elkCreateHud = createHud;
})();
