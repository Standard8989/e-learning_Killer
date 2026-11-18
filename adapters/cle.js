// adapters/cle.js - Osaka University CLE (Blackboard Learn Ultra) Adapter for e-learning Killer

(() => {
  const HUD_HOST_ID = "__elk_hud_host__";
  const HIGHLIGHT_CLASS = "__elk_highlighted_choice__";
  const SHUTDOWN_EVENT = "__elk_shutdown__";
  const INSTANCE_ATTR = "data-elk-instance";
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  let alive = true;
  const cleanupCallbacks = [];

  function shutdown() {
    if (!alive) return;
    alive = false;
    while (cleanupCallbacks.length > 0) {
      const fn = cleanupCallbacks.pop();
      try {
        fn();
      } catch (_) {}
    }
  }

  function isContextValid() {
    if (!alive) return false;
    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  try {
    if (typeof window.__ELK_CLEANUP__ === "function") window.__ELK_CLEANUP__();
  } catch (_) {}

  try {
    document.documentElement.setAttribute(INSTANCE_ATTR, instanceId);
    document.dispatchEvent(new CustomEvent(SHUTDOWN_EVENT));
  } catch (_) {}

  try {
    document.querySelectorAll(`#${HUD_HOST_ID}`).forEach((el) => el.remove());
  } catch (_) {}

  const onShutdownSignal = () => {
    let current = null;
    try {
      current = document.documentElement.getAttribute(INSTANCE_ATTR);
    } catch (_) {}
    if (current !== instanceId) shutdown();
  };
  document.addEventListener(SHUTDOWN_EVENT, onShutdownSignal);
  cleanupCallbacks.push(() => document.removeEventListener(SHUTDOWN_EVENT, onShutdownSignal));

  window.__ELK_CLEANUP__ = undefined;
  window.__ELK_IS_ALIVE__ = undefined;

  const elementRegistry = new Map();

  function ensurePageHighlightStyle() {
    if (document.getElementById("__elk_page_style__")) return;
    const style = document.createElement("style");
    style.id = "__elk_page_style__";
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid #10b981 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.22) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
      el.classList.remove(HIGHLIGHT_CLASS);
    });
  }

  function highlightElement(el) {
    if (!el || typeof el.classList === "undefined") return;
    ensurePageHighlightStyle();
    el.classList.add(HIGHLIGHT_CLASS);
  }

  function normalizeText(str) {
    return (str || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.getAttribute?.("aria-hidden") === "true") return false;
    if (el.classList?.contains("ng-hide") || el.classList?.contains("sr-only")) return false;
    const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (st) {
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) {
        return false;
      }
    }
    if (typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    }
    return true;
  }

  function simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (h * 33) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  function parseCleAttemptKey(href) {
    try {
      const u = new URL(href || location.href);
      const m = u.pathname.match(/\/assessment\/([^/]+)\/attempt\/([^/]+)/i);
      if (m) return `cle:${m[1]}:${m[2]}`;
      const a = u.pathname.match(/\/assessment\/([^/]+)/i);
      if (a) return `cle:${a[1]}`;
    } catch (_) {}
    return "";
  }

  function findContinueButton() {
    const byAnalytics = Array.from(
      document.querySelectorAll(
        'button[analytics-id="components.directives.attempt-canvas.continue-to-next-page"], button[data-analytics-id="components.directives.attempt-canvas.continue-to-next-page"]'
      )
    );
    const visAnalytics = byAnalytics.find((b) => !b.disabled && isVisible(b));
    if (visAnalytics) return visAnalytics;

    const candidates = Array.from(document.querySelectorAll("button")).filter((b) => {
      if (b.disabled || !isVisible(b)) return false;
      const t = normalizeText(b.innerText || b.textContent);
      return t === "続行" || /^Continue$/i.test(t);
    });
    return candidates[0] || null;
  }

  function findFooterSubmitButton() {
    const candidates = Array.from(
      document.querySelectorAll(
        '.js-send-draft-button, button[analytics-id="course.content.assessment.footer.buttons.submit"]'
      )
    );
    return candidates.find(isVisible) || candidates[0] || null;
  }

  function detectOpenDialogPause() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .bb-modal')).filter(isVisible);
    for (const dlg of dialogs) {
      const txt = normalizeText(dlg.innerText || dlg.textContent);
      if (!txt) continue;
      if (/終了です！|提出が正常に完了しました/.test(txt)) {
        return {
          reason: "submitted",
          message: "✅ CLE: テストの提出が完了しています",
          detail: txt.slice(0, 180)
        };
      }
      if (/次のページに進みますか？|未解答です/.test(txt)) {
        return {
          reason: "unanswered_modal",
          message: "⏸️ 未解答警告モーダルが開いています（確認してください）",
          detail: txt.slice(0, 180)
        };
      }
      if (/テストを提出しますか？|このテストを編集できなくなります/.test(txt)) {
        return {
          reason: "confirm_submit_modal",
          message: "⏸️ 提出確認ダイアログが開いています（内容を確認して手動で「提出」を押してください）",
          detail: txt.slice(0, 180)
        };
      }
      return {
        reason: "dialog_open",
        message: "⏸️ ダイアログが開いているため一時停止しました",
        detail: txt.slice(0, 180)
      };
    }
    return null;
  }

  function isReadOnlySubmissionView() {
    if (document.querySelector('select[aria-label="答案"], .submission-feedback')) return true;
    const h2 = Array.from(document.querySelectorAll("h2")).find((el) =>
      /主な提出物コンテンツ/.test(el.textContent || "")
    );
    return Boolean(h2 && isVisible(h2));
  }

  function parseBbFileMeta(el) {
    const raw = el?.getAttribute?.("data-bbfile");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function extractCardAudioUrl(cardEl) {
    if (!cardEl) return "";
    const audioEl = cardEl.querySelector("audio");
    if (audioEl) {
      const direct =
        audioEl.currentSrc ||
        audioEl.getAttribute("src") ||
        audioEl.src ||
        audioEl.querySelector("source")?.getAttribute("src") ||
        audioEl.querySelector("source")?.src ||
        "";
      if (direct) return direct;
    }
    const attachments = Array.from(cardEl.querySelectorAll('[data-bbtype="editAttachment"][href]'));
    for (const att of attachments) {
      const href = att.getAttribute("href") || "";
      if (!href) continue;
      const meta = parseBbFileMeta(att);
      if (
        (meta?.mimeType && /^audio\//i.test(meta.mimeType)) ||
        /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$)/i.test(meta?.linkName || href)
      ) {
        return href;
      }
    }
    return "";
  }

  function isChoiceOptionContainer(el) {
    if (!el || !el.classList) return false;
    return (
      el.classList.contains("MuiRadioGroup-root") ||
      el.classList.contains("MuiList-root") ||
      el.classList.contains("js-multiple-answer-option") ||
      el.getAttribute("role") === "radiogroup"
    );
  }

  function isAudioUiChrome(el) {
    if (!el) return false;
    if (el.tagName === "AUDIO" || el.tagName === "VIDEO" || el.tagName === "BUTTON") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    return (
      cls.includes("js-file-viewer-root-controls") ||
      cls.includes("js-file-viewer-inline-preview") ||
      cls.includes("ql-clipboard") ||
      el.classList?.contains("sr-only") ||
      el.getAttribute?.("aria-hidden") === "true"
    );
  }

  /**
   * Collect clean visible option text from a Blackboard MUI FormControlLabel / option row.
   */
  function extractOptionText(labelEl, inputEl) {
    const richText = labelEl.querySelector(
      '[class*="answerOptionText"] .ql-editor, [class*="answerOptionText"], .ql-editor.bb-editor'
    );
    if (richText) {
      const txt = normalizeText(richText.innerText || richText.textContent);
      if (txt) return txt;
    }

    if (typeof labelEl.cloneNode === "function") {
      try {
        const clone = labelEl.cloneNode(true);
        clone
          .querySelectorAll?.('input, button, .sr-only, [aria-hidden="true"], svg')
          .forEach((n) => n.remove());
        const clonedTxt = normalizeText(clone.innerText || clone.textContent)
          .replace(/^(?:[A-Z]\s*\.\s*)?オプション\s*[A-Z]\s*/i, "")
          .replace(/\s*選択しました\s*$/i, "")
          .trim();
        if (clonedTxt) return clonedTxt;
      } catch (_) {}
    }

    return normalizeText(
      labelEl.innerText || labelEl.textContent || inputEl?.getAttribute?.("aria-label") || ""
    )
      .replace(/^(?:[A-Z]\s*\.\s*)?オプション\s*[A-Z]\s*/i, "")
      .replace(/\s*選択しました\s*$/i, "")
      .trim();
  }

  /**
   * Walk question content DOM in visual reading order, substituting inline blank inputs with [空欄:id].
   */
  function serializeCardQuestionText(qCard, inputIdMap) {
    const labelHeading = normalizeText(
      qCard.querySelector(".question-label")?.innerText ||
        qCard.querySelector(".question-label")?.textContent ||
        ""
    );
    const contentRoot = qCard.querySelector(".question-content") || qCard;
    const chunks = [];
    const blockTags = new Set(["P", "DIV", "BR", "LI", "H1", "H2", "H3", "H4", "TR"]);

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const v = (node.nodeValue || "").replace(/\u00a0/g, " ");
        if (v) chunks.push(v);
        return;
      }
      if (node.nodeType !== 1) return;
      if (isChoiceOptionContainer(node) || isAudioUiChrome(node)) return;

      const matchedInput = inputIdMap.has(node)
        ? node
        : node.hasAttribute?.("data-blankid")
          ? node.querySelector("input, textarea, select")
          : null;

      if (matchedInput && inputIdMap.has(matchedInput)) {
        chunks.push(`[空欄:${inputIdMap.get(matchedInput)}]`);
        return;
      }

      if (node.hasAttribute?.("data-bbtype") && node.getAttribute("data-bbtype") === "editAttachment") {
        const meta = parseBbFileMeta(node);
        if (meta?.linkName) chunks.push(`\n[音声ファイル: ${meta.linkName}]\n`);
        return;
      }

      if (node.tagName === "BR") {
        chunks.push("\n");
        return;
      }

      for (const child of Array.from(node.childNodes || [])) {
        walk(child);
      }
      if (blockTags.has(node.tagName)) {
        chunks.push("\n");
      }
    }

    walk(contentRoot);

    let bodyText = chunks
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    if (labelHeading && bodyText.startsWith(labelHeading)) {
      bodyText = bodyText.slice(labelHeading.length).trim();
    }
    return labelHeading ? `${labelHeading}\n${bodyText}` : bodyText;
  }

  function extractSnippetAroundBlank(serializedText, idTag) {
    const marker = `[空欄:${idTag}]`;
    const idx = serializedText.indexOf(marker);
    if (idx < 0) return "";
    const start = Math.max(0, idx - 85);
    const end = Math.min(serializedText.length, idx + marker.length + 85);
    return normalizeText(serializedText.slice(start, end));
  }

  function analyzeQuestionCard(qCard, qIdx) {
    const label = normalizeText(
      qCard.querySelector(".question-label")?.innerText ||
        qCard.querySelector(".question-label")?.textContent ||
        `Q${qIdx + 1}`
    );

    const choiceInputs = Array.from(
      qCard.querySelectorAll('input[type="radio"]:not(:disabled), input[type="checkbox"]:not(:disabled)')
    );
    const options = choiceInputs.map((inp, i) => {
      const containerLabel =
        inp.closest("label.MuiFormControlLabel-root, .js-multiple-answer-option, label") ||
        inp.parentElement;
      const text = extractOptionText(containerLabel || inp, inp);
      const checked = Boolean(inp.checked || inp.getAttribute("aria-checked") === "true");
      const clickTarget = containerLabel || inp;
      return {
        localIdx: i,
        el: inp,
        clickTarget,
        type: inp.type === "checkbox" ? "checkbox" : "radio",
        text,
        checked
      };
    });

    const rawTextInputs = Array.from(
      qCard.querySelectorAll(
        'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not(:disabled), textarea:not(:disabled)'
      )
    ).filter((el) => !el.closest(".ql-clipboard") && !el.classList?.contains("panel-header-title"));

    const rawEditables =
      rawTextInputs.length === 0
        ? Array.from(
            qCard.querySelectorAll(
              '[contenteditable="true"]:not(.ql-clipboard):not([aria-hidden="true"])'
            )
          ).filter((el) => !el.closest(".is-read-only, .ql-disabled"))
        : [];

    const allTextEls = [...rawTextInputs, ...rawEditables];
    const selects = Array.from(qCard.querySelectorAll("select:not(:disabled)"));

    const inputIdMap = new Map();
    allTextEls.forEach((el, i) => inputIdMap.set(el, `txt-${i}`));
    selects.forEach((el, i) => inputIdMap.set(el, `sel-${i}`));

    const questionText = serializeCardQuestionText(qCard, inputIdMap);

    const textInputs = allTextEls.map((el, i) => {
      const isEditable = el.isContentEditable || el.getAttribute?.("contenteditable") === "true";
      const val = isEditable ? (el.innerText || el.textContent || "").trim() : el.value || "";
      const blankWrapper = el.closest?.("[data-blankid]");
      const blankId = blankWrapper?.getAttribute("data-blankid") || el.id || "";
      const ariaLbl = el.getAttribute?.("aria-label") || "";
      return {
        localId: `txt-${i}`,
        el,
        isEditable,
        qLabel: normalizeText(ariaLbl || blankId),
        currentValue: val,
        contextSnippet: extractSnippetAroundBlank(questionText, `txt-${i}`)
      };
    });

    const selectInfos = selects.map((el, i) => {
      const opts = Array.from(el.options || []).map((o) => ({
        value: o.value,
        text: normalizeText(o.textContent)
      }));
      return {
        localId: `sel-${i}`,
        el,
        currentValue: el.value || "",
        contextSnippet: extractSnippetAroundBlank(questionText, `sel-${i}`),
        choices: opts
      };
    });

    const choicesAnswered =
      options.length === 0 || options.some((o) => o.checked);
    const textsAnswered =
      textInputs.length === 0 || textInputs.every((t) => String(t.currentValue || "").trim() !== "");
    const selectsAnswered =
      selectInfos.length === 0 || selectInfos.every((s) => String(s.currentValue || "").trim() !== "");

    const hasControls = options.length > 0 || textInputs.length > 0 || selectInfos.length > 0;
    const isAnswered = hasControls && choicesAnswered && textsAnswered && selectsAnswered;

    const audioUrl = extractCardAudioUrl(qCard);
    const rangeMatch = questionText.match(/(?:Questions|Blanks)\s*(\d+)\s*[-–]\s*(\d+)/i);
    const subMatch = questionText.match(/(?:^|\n)\s*(Question|Blank)\s*\[?(\d+)\]?(?=\s|\n|$)/i);
    const hasPassageBlock =
      /[＝=]{3,}/.test(questionText) ||
      /Read the passage/i.test(questionText) ||
      (/Listen to the audio/i.test(questionText) && Boolean(audioUrl || rangeMatch));

    const classMatch = (qCard.className || "").match(/js-question-type-([a-zA-Z0-9_-]+)/);

    return {
      qId: `q-${qIdx}`,
      el: qCard,
      label,
      questionType: classMatch ? classMatch[1] : "unknown",
      status: !hasControls ? "locked" : isAnswered ? "answered" : "active",
      statusReason: !hasControls
        ? "no_controls"
        : isAnswered
          ? "cle_input_filled"
          : "cle_unanswered",
      questionText,
      options,
      textInputs,
      selects: selectInfos,
      audioUrl,
      hasPassageBlock,
      groupSpan: rangeMatch ? Math.max(1, Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1) : 0,
      subQuestionHint: subMatch
        ? { kind: subMatch[1].toLowerCase(), num: Number(subMatch[2]) }
        : null,
      referencesContext:
        /(?:^|\n)\s*(?:Question|Blank)\s*\[?[2-9]\d*\]?/i.test(questionText) ||
        /\baccording to the (?:text|passage|article|audio)\b|\bin the (?:passage|article|audio)\b|\bthe (?:author|speaker|man|woman)\b/i.test(
          questionText
        )
    };
  }

  function extractContextHeaderFromCardText(text) {
    if (!text) return "";
    const lines = text.split("\n");
    const cutIdx = lines.findIndex(
      (l, i) => i > 0 && /^\s*(?:Question|Blank)\s*\[?1\]?(?:\s|$)/i.test(l)
    );
    const header = (cutIdx > 0 ? lines.slice(0, cutIdx) : lines)
      .filter((l) => !/^\[空欄:/.test(l))
      .join("\n")
      .trim();
    return header.slice(0, 4500);
  }

  function extractPageState(_answeredBlockKeys = [], includeFullDebug = false) {
    elementRegistry.clear();
    clearHighlights();

    const url = location.href;
    const title = document.title || "";
    const cleAttemptKey = parseCleAttemptKey(url);
    const rawPageText = normalizeText(document.body?.innerText || "");

    const baseEmpty = {
      url,
      title,
      siteType: "cle",
      cleAttemptKey,
      isCourseDashboard: false,
      courseGoalDone: false,
      courseLessons: [],
      courseReturnBtn: null,
      isRecordingTask: false,
      isResultReview: false,
      pageText: rawPageText.slice(0, 3500),
      sharedContext: "",
      activeQuestionId: null,
      activeQuestionText: "",
      questionBaseKey: "",
      questionSummary: { totalBlocks: 0, activeCount: 0, answeredCount: 0, lockedCount: 0 },
      blocksSummary: [],
      hasQuizKeywords: false,
      options: [],
      selects: [],
      textInputs: [],
      inlineInputPills: [],
      mediaCards: { totalCount: 0, activeCount: 0, lockedCount: 0, playingCount: 0, unplayedActiveCount: 0, cards: [] },
      buttons: [],
      inactiveButtons: [],
      hasAudioPlayer: false,
      activeAudioUrl: null,
      audioUrls: [],
      hiddenTranscript: "",
      canScrollMore: false,
      stateHash: simpleHash(url + "::" + rawPageText.slice(0, 300))
    };

    const inAttempt = /\/attempt\//i.test(location.pathname || "");
    if (!inAttempt || isReadOnlySubmissionView()) {
      return {
        ...baseEmpty,
        clePauseReason: "not_in_attempt",
        clePauseMessage: "CLE コース・概要画面です（安全のためテスト自動開始は無効）",
        clePauseDetail:
          "受験したいテストを開き、「答案を開始」→「タイマーを開始」で解答画面に入ってから実行してください。"
      };
    }

    const dialogPause = detectOpenDialogPause();
    if (dialogPause) {
      return {
        ...baseEmpty,
        clePauseReason: dialogPause.reason,
        clePauseMessage: dialogPause.message,
        clePauseDetail: dialogPause.detail
      };
    }

    const qCardEls = Array.from(document.querySelectorAll(".assessment-question")).filter(isVisible);
    const continueBtn = findContinueButton();
    const submitBtn = findFooterSubmitButton();
    const allAnalyzed = qCardEls.map((el, i) => analyzeQuestionCard(el, i));
    const presentationCards = allAnalyzed.filter((q) => q.status === "locked" && q.statusReason === "no_controls");
    const analyzed = allAnalyzed.filter((q) => !(q.status === "locked" && q.statusReason === "no_controls"));

    const courseHeadingEl = Array.from(document.querySelectorAll("h1")).find((h) => isVisible(h));
    const cleCourseHeading = normalizeText(courseHeadingEl?.innerText || courseHeadingEl?.textContent || "").slice(0, 140);

    // Intro screen ("問題 0" before "問題 1", or no interactive questions rendered yet)
    if (analyzed.length === 0) {
      const btns = [];
      if (continueBtn) {
        elementRegistry.set("btn-0", continueBtn);
        btns.push({
          id: "btn-0",
          text: normalizeText(continueBtn.innerText || continueBtn.textContent || "続行"),
          kind: "next",
          belongsToActiveQuestion: false
        });
      }
      return {
        ...baseEmpty,
        cleCourseHeading,
        hasQuizKeywords: btns.length > 0,
        buttons: btns,
        stateHash: simpleHash(url + "::intro::" + btns.length)
      };
    }

    const activeCards = analyzed.filter((q) => q.status === "active");
    const answeredCards = analyzed.filter((q) => q.status === "answered");
    const lockedCards = analyzed.filter((q) => q.status === "locked");

    const questionSummary = {
      totalBlocks: analyzed.length,
      activeCount: activeCards.length,
      answeredCount: answeredCards.length,
      lockedCount: lockedCards.length
    };

    const blocksSummary = analyzed.map((q) => ({
      qId: q.qId,
      status: q.status,
      reason: q.statusReason,
      checkedTexts: q.options.filter((o) => o.checked).map((o) => o.text)
    }));

    const submitDisabled = Boolean(submitBtn && submitBtn.disabled);
    const hasAutosaveDirty = Boolean(
      document.querySelector('form[name="questionForm"].ng-dirty')
    );
    const autosaveBusy = Boolean(answeredCards.length > 0 && (submitDisabled || hasAutosaveDirty));

    // All interactive questions on this page are already answered
    if (activeCards.length === 0) {
      if (autosaveBusy) {
        return {
          ...baseEmpty,
          cleCourseHeading,
          questionSummary,
          blocksSummary,
          hasQuizKeywords: true,
          cleWaitingAutosave: true,
          buttons: [],
          stateHash: simpleHash(url + "::autosave-wait::" + answeredCards.length)
        };
      }

      if (continueBtn) {
        elementRegistry.set("btn-0", continueBtn);
        return {
          ...baseEmpty,
          cleCourseHeading,
          questionSummary,
          blocksSummary,
          hasQuizKeywords: true,
          cleWaitingAutosave: false,
          buttons: [
            {
              id: "btn-0",
              text: normalizeText(continueBtn.innerText || continueBtn.textContent || "続行"),
              kind: "next",
              belongsToActiveQuestion: false
            }
          ],
          stateHash: simpleHash(url + "::done-page::" + answeredCards.length)
        };
      }

      return {
        ...baseEmpty,
        cleCourseHeading,
        questionSummary,
        blocksSummary,
        hasQuizKeywords: true,
        clePauseReason: "ready_to_submit",
        clePauseMessage: "✅ CLE: 全問の解答入力が完了しました（確認して「提出」を押してください）",
        clePauseDetail:
          "誤提出防止のため自動提出しません。入力内容を確認し、問題なければ画面右下の「提出」を押してください。"
      };
    }

    const target = activeCards[0];
    const targetIdx = allAnalyzed.indexOf(target);

    // Register interactive controls ONLY for the single target question
    const mappedOptions = target.options.map((o, idx) => {
      const id = `opt-${idx}`;
      elementRegistry.set(id, { kind: "choice", el: o.el, clickTarget: o.clickTarget });
      return {
        id,
        text: o.text,
        type: o.type,
        checked: o.checked,
        disabled: false,
        belongsToActiveQuestion: true
      };
    });

    const mappedTextInputs = target.textInputs.map((t, idx) => {
      const id = `txt-${idx}`;
      elementRegistry.set(id, { kind: "text", el: t.el, isEditable: t.isEditable });
      return {
        id,
        qLabel: t.qLabel,
        currentValue: t.currentValue,
        contextSnippet: t.contextSnippet
      };
    });

    const mappedSelects = target.selects.map((s, idx) => {
      const id = `sel-${idx}`;
      elementRegistry.set(id, { kind: "select", el: s.el });
      return {
        id,
        currentValue: s.currentValue,
        contextSnippet: s.contextSnippet,
        choices: s.choices
      };
    });

    // Resolve own or same-page preceding shared audio / reading passage
    let resolvedAudioUrl = target.audioUrl || "";
    let sharedContext = "";
    const shouldInheritFromPreceding =
      !resolvedAudioUrl || !target.hasPassageBlock || target.referencesContext;

    if (targetIdx > 0 && shouldInheritFromPreceding) {
      for (let j = targetIdx - 1; j >= Math.max(0, targetIdx - 8); j--) {
        const prev = allAnalyzed[j];
        if (!prev) continue;
        const dist = targetIdx - j + 1;
        const withinExplicitSpan = prev.groupSpan > 0 && dist <= prev.groupSpan;
        const isPresentationPassage =
          prev.status === "locked" &&
          prev.statusReason === "no_controls" &&
          !/画面下部の「続行」|問題は全部で/.test(prev.questionText);
        const looksGrouped =
          withinExplicitSpan ||
          isPresentationPassage ||
          Boolean(
            target.subQuestionHint &&
              target.subQuestionHint.num >= 2 &&
              prev.hasPassageBlock
          ) ||
          Boolean(target.referencesContext && prev.hasPassageBlock);

        if (!looksGrouped) continue;
        if (!resolvedAudioUrl && prev.audioUrl) resolvedAudioUrl = prev.audioUrl;
        if (prev.hasPassageBlock || isPresentationPassage) {
          const header = extractContextHeaderFromCardText(prev.questionText);
          if (header) sharedContext = header;
        }
        if (resolvedAudioUrl || sharedContext) break;
      }
    }

    const allPageAudioUrls = Array.from(
      new Set(allAnalyzed.map((q) => q.audioUrl).filter(Boolean))
    );

    const cleOwnPassage = target.hasPassageBlock
      ? extractContextHeaderFromCardText(target.questionText)
      : "";

    // Never expose footer submit / save buttons in CLE `buttons`
    const stateSig = [
      url,
      target.qId,
      target.questionText.slice(0, 140),
      mappedOptions.map((o) => `${o.checked ? 1 : 0}:${o.text}`).join("|"),
      mappedTextInputs.map((t) => `${t.id}=${t.currentValue}`).join("|"),
      mappedSelects.map((s) => `${s.id}=${s.currentValue}`).join("|"),
      resolvedAudioUrl
    ].join("::");

    const result = {
      ...baseEmpty,
      cleCourseHeading,
      sharedContext,
      activeQuestionId: target.qId,
      activeQuestionText: target.questionText,
      questionBaseKey: `${cleAttemptKey || url}::${target.label}`,
      questionSummary,
      blocksSummary,
      hasQuizKeywords: true,
      options: mappedOptions,
      selects: mappedSelects,
      textInputs: mappedTextInputs,
      hasAudioPlayer: Boolean(resolvedAudioUrl),
      activeAudioUrl: resolvedAudioUrl || null,
      audioUrls: allPageAudioUrls,
      cleOwnPassage,
      cleGroupSpan: target.groupSpan || 0,
      cleSubQuestionHint: target.subQuestionHint,
      cleReferencesContext: Boolean(target.referencesContext),
      canScrollMore:
        (document.documentElement?.scrollHeight || 0) > (window.innerHeight || 0) + 40,
      stateHash: simpleHash(stateSig)
    };

    if (includeFullDebug) {
      result.cleDebugCards = analyzed.map((q) => ({
        qId: q.qId,
        type: q.questionType,
        status: q.status,
        hasAudio: Boolean(q.audioUrl),
        optCount: q.options.length,
        txtCount: q.textInputs.length
      }));
    }

    return result;
  }

  function setNativeInputValue(el, value, isEditable) {
    if (isEditable) {
      el.focus?.();
      el.textContent = String(value ?? "");
      el.dispatchEvent?.(new Event("input", { bubbles: true }));
      el.dispatchEvent?.(new Event("change", { bubbles: true }));
      el.dispatchEvent?.(new Event("blur", { bubbles: true }));
      return;
    }

    const proto =
      el.tagName === "TEXTAREA"
        ? typeof HTMLTextAreaElement !== "undefined"
          ? HTMLTextAreaElement.prototype
          : null
        : typeof HTMLInputElement !== "undefined"
          ? HTMLInputElement.prototype
          : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    el.focus?.();
    if (setter) {
      setter.call(el, String(value ?? ""));
    } else {
      el.value = String(value ?? "");
    }
    el.dispatchEvent?.(new Event("input", { bubbles: true }));
    el.dispatchEvent?.(new Event("change", { bubbles: true }));
    el.dispatchEvent?.(new Event("blur", { bubbles: true }));
  }

  async function waitForAutosaveSettle(maxMs = 2200) {
    if (!findContinueButton()) return;
    await new Promise((r) => setTimeout(r, 180));
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const sendBtn = findFooterSubmitButton();
      const formPending = document.querySelector('form[name="questionForm"].ng-pending');
      const busy = Boolean((sendBtn && sendBtn.disabled) || formPending);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function executeAction(payload) {
    const actionsTaken = [];
    const highlight = payload?.highlightAnswer !== false;
    const clickDelayMs = Math.max(120, Math.min(2000, Number(payload?.clickDelayMs) || 350));

    if (payload?.status === "scroll_down") {
      try {
        window.scrollBy?.({ top: Math.round((window.innerHeight || 700) * 0.65), behavior: "smooth" });
      } catch (_) {}
      actionsTaken.push("scrolled down");
      return { ok: true, actionsTaken };
    }

    if (payload?.status === "next_only" && payload.clickButtonId) {
      const target = elementRegistry.get(payload.clickButtonId);
      const txt = normalizeText(target?.innerText || target?.textContent || "");
      // Safety guard: NEVER click Submit / Save & Close / modal confirmation buttons
      if (!target || /提出|保存|閉じる|終了|クリア/.test(txt)) {
        return { ok: false, error: "CLE安全ガードにより対象ボタンのクリックを拒否しました", actionsTaken };
      }
      target.scrollIntoView?.({ block: "center", behavior: "instant" });
      if (highlight) highlightElement(target);
      await new Promise((r) => setTimeout(r, Math.min(clickDelayMs, 350)));
      target.click();
      actionsTaken.push(`clicked CLE continue ("${txt}")`);
      return { ok: true, actionsTaken };
    }

    if (payload?.status === "answer") {
      const selectedIds = new Set(
        Array.isArray(payload.selectedOptionIds) ? payload.selectedOptionIds : []
      );
      const choiceEntries = [];
      for (const [id, entry] of elementRegistry.entries()) {
        if (entry?.kind === "choice") choiceEntries.push({ id, ...entry });
      }

      const targetQuestion =
        choiceEntries[0]?.el?.closest?.(".assessment-question") ||
        Array.from(elementRegistry.values()).find((e) => e?.el)?.el?.closest?.(".assessment-question");
      targetQuestion?.scrollIntoView?.({ block: "center", behavior: "instant" });

      if (selectedIds.size > 0) {
        const isCheckboxGroup = choiceEntries.some((c) => c.el.type === "checkbox");
        for (const c of choiceEntries) {
          const want = selectedIds.has(c.id);
          const cur = Boolean(c.el.checked);
          if (want && !cur) {
            (c.clickTarget || c.el).click();
            if (highlight) highlightElement(c.clickTarget || c.el);
            actionsTaken.push(`clicked ${c.id}`);
          } else if (isCheckboxGroup && !want && cur) {
            (c.clickTarget || c.el).click();
            actionsTaken.push(`unchecked ${c.id}`);
          }
        }
      }

      for (const tv of Array.isArray(payload.textValues) ? payload.textValues : []) {
        const entry = elementRegistry.get(tv?.id);
        if (!entry || entry.kind !== "text") continue;
        setNativeInputValue(entry.el, tv.value ?? "", entry.isEditable);
        if (highlight) highlightElement(entry.el);
        actionsTaken.push(`typed ${tv.id}="${String(tv.value ?? "")}"`);
      }

      for (const sv of Array.isArray(payload.selectValues) ? payload.selectValues : []) {
        const entry = elementRegistry.get(sv?.id);
        if (!entry || entry.kind !== "select") continue;
        entry.el.value = String(sv.value ?? "");
        entry.el.dispatchEvent?.(new Event("change", { bubbles: true }));
        if (highlight) highlightElement(entry.el);
        actionsTaken.push(`selected ${sv.id}="${String(sv.value ?? "")}"`);
      }

      if (actionsTaken.length > 0) {
        await waitForAutosaveSettle();
      }
      return { ok: true, actionsTaken };
    }

    return { ok: true, actionsTaken };
  }

  async function fetchAudioAsBase64(targetUrl) {
    let url = targetUrl || "";
    if (!url) {
      const activeQ = Array.from(document.querySelectorAll(".assessment-question")).find(
        (q) => isVisible(q) && extractCardAudioUrl(q)
      );
      url = extractCardAudioUrl(activeQ || document);
    }
    if (!url) {
      return { ok: false, error: "CLEページ内に音声ファイルが見つかりませんでした" };
    }
    if (typeof globalThis.__elkFetchAudioFromUrl === "function") {
      return await globalThis.__elkFetchAudioFromUrl(url);
    }
    return { ok: false, url, error: "hud.js音声ヘルパーが未ロードです" };
  }

  let hudRefs = null;
  let hudVisibleSetting = true;

  function createHud() {
    if (!alive || window !== window.top) return null;
    if (hudRefs) return hudRefs;
    if (typeof globalThis.__elkCreateHud !== "function") return null;
    hudRefs = globalThis.__elkCreateHud({
      hostId: HUD_HOST_ID,
      brandBadge: "CLE",
      isAlive: () => alive,
      isContextValid,
      cleanupCallbacks,
      getVisible: () => hudVisibleSetting,
      setVisible: (v) => {
        hudVisibleSetting = Boolean(v);
      },
      onDestroy: () => {
        hudRefs = null;
      }
    });
    return hudRefs;
  }

  if (window === window.top && isContextValid()) {
    try {
      if (document.body) createHud();
      chrome.runtime
        .sendMessage({ type: "ELK_GET_INIT" })
        .then((res) => {
          if (res?.ok) {
            hudVisibleSetting = res.settings?.showHud !== false;
            const hud = createHud();
            if (hud) {
              hud.setVisible(hudVisibleSetting);
              if (res.state) hud.update(res.state);
            }
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  if (isContextValid()) {
    const onRuntimeMessage = (message, _sender, sendResponse) => {
      if (!isContextValid()) return false;
      (async () => {
        switch (message.type) {
          case "ELK_PING":
            sendResponse({ ok: true, instanceId, siteType: "cle" });
            break;

          case "ELK_EXTRACT_STATE": {
            const data = extractPageState(
              message.answeredBlockKeys || [],
              Boolean(message.includeFullDebug)
            );
            sendResponse({ ok: true, data });
            break;
          }

          case "ELK_EXECUTE_ACTION": {
            const res = await executeAction(message.payload);
            sendResponse(res);
            break;
          }

          case "ELK_FETCH_AUDIO_BASE64": {
            const audioRes = await fetchAudioAsBase64(message.url);
            sendResponse(audioRes);
            break;
          }

          case "ELK_STATUS_UPDATE": {
            if (window === window.top) {
              const hud = createHud();
              if (hud) hud.update(message.state);
            }
            sendResponse({ ok: true });
            break;
          }

          case "ELK_SETTINGS_UPDATED": {
            if (window === window.top && message.settings) {
              const hud = createHud();
              if (hud) hud.setVisible(message.settings.showHud !== false);
            }
            sendResponse({ ok: true });
            break;
          }

          default:
            sendResponse({ ok: false });
        }
      })().catch((err) => {
        try {
          sendResponse({ ok: false, error: err?.message || String(err) });
        } catch (_) {}
      });
      return true;
    };

    try {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      cleanupCallbacks.push(() => {
        try {
          chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        } catch (_) {}
      });
    } catch (_) {}
  }
})();
