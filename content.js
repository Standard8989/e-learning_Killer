// content.js - e-learning Killer DOM Analyzer, Action Executor, HUD & Live Debugger

(() => {
  // ==========================================================================
  // Instance lifecycle (newest instance always takes over, old ones self-destruct)
  // - window globals may persist across extension reloads, so detection uses the DOM (shared across all worlds)
  // ==========================================================================
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
      } catch (_) { }
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

  // 1. Compatibility with the old version (22:03) cleanup hook
  try {
    if (typeof window.__ELK_CLEANUP__ === "function") window.__ELK_CLEANUP__();
  } catch (_) { }

  // 2. Register this instance as the newest one, and notify older instances (any isolated world) to shut down
  try {
    document.documentElement.setAttribute(INSTANCE_ATTR, instanceId);
    document.dispatchEvent(new CustomEvent(SHUTDOWN_EVENT));
  } catch (_) { }

  // 3. Physically remove any old HUD (including old-version HUDs that cannot receive the shutdown event)
  try {
    document.querySelectorAll(`#${HUD_HOST_ID}`).forEach((el) => el.remove());
  } catch (_) { }

  // 4. Shut this instance down when a newer instance appears
  const onShutdownSignal = () => {
    let current = null;
    try {
      current = document.documentElement.getAttribute(INSTANCE_ATTR);
    } catch (_) { }
    if (current !== instanceId) shutdown();
  };
  document.addEventListener(SHUTDOWN_EVENT, onShutdownSignal);
  cleanupCallbacks.push(() => document.removeEventListener(SHUTDOWN_EVENT, onShutdownSignal));

  window.__ELK_CLEANUP__ = undefined;
  window.__ELK_IS_ALIVE__ = undefined;

  const elementRegistry = new Map();
  const clickedMediaPlayBtns = new WeakSet();

  let lastScanContext = {
    claimedElements: new Set(),
    targetBlock: null,
    nextBlockBelow: null,
    scrollPane: null
  };

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

  function isInsideHud(el) {
    if (!el || typeof el.closest !== "function") return false;
    return Boolean(el.closest(`#${HUD_HOST_ID}`));
  }

  function normalizeText(str) {
    return (str || "").replace(/\s+/g, " ").trim();
  }

  function describeEl(el) {
    if (!el || !(el instanceof Element)) return "null";
    const tag = el.tagName;
    const id = el.id ? `#${el.id.slice(0, 48)}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." +
        el.className
          .trim()
          .split(/\s+/)
          .slice(0, 3)
          .join(".")
          .slice(0, 48)
        : "";
    return `${tag}${id}${cls}`;
  }

  function sanitizeHtmlSkeleton(el) {
    if (!el || !(el instanceof Element)) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("svg, path, script, style").forEach((n) => n.remove());
    const raw = clone.outerHTML || "";
    return raw.replace(/\s+/g, " ").slice(0, 280);
  }

  // ============================================================================
  // Color, Opacity, Contrast & Interactivity Inspection (Child-Text Aware!)
  // ============================================================================
  function parseColor(colorStr) {
    if (!colorStr) return null;
    const m = colorStr.match(
      /rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i
    );
    if (!m) return null;
    return {
      r: Math.round(Number(m[1])),
      g: Math.round(Number(m[2])),
      b: Math.round(Number(m[3])),
      a: m[4] !== undefined ? Number(m[4]) : 1
    };
  }

  function rgbStr(c) {
    if (!c) return "";
    return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
  }

  function relativeLuminance({ r, g, b }) {
    const toLinear = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function contrastRatio(rgb1, rgb2) {
    const l1 = relativeLuminance(rgb1);
    const l2 = relativeLuminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // Find the actual element directly holding visible text (e.g., <div class="bg-blue"><span class="text-white">...</span></div>)
  function findTextBearingElement(root) {
    if (!root) return root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.trim().length > 0 && node.parentElement) {
        const p = node.parentElement;
        const cs = window.getComputedStyle(p);
        if (cs.display !== "none" && cs.visibility !== "hidden") {
          return p;
        }
      }
      node = walker.nextNode();
    }
    return root;
  }

  // If root is a transparent wrapper (<label> or outer <div>), find large painted inner surface box
  function findPaintedSurfaceChild(root, rootRect) {
    if (!root || !root.children || root.children.length === 0) return null;
    for (const child of root.children) {
      if (!(child instanceof Element)) continue;
      if (child.tagName === "INPUT") continue;
      const cr = child.getBoundingClientRect();
      if (cr.width >= rootRect.width * 0.6 && cr.height >= rootRect.height * 0.6) {
        const cs = window.getComputedStyle(child);
        const bg = parseColor(cs.backgroundColor);
        if (bg && bg.a > 0.1) return child;
      }
    }
    return null;
  }

  function inspectElementVisualState(el) {
    if (!el || !(el instanceof Element) || isInsideHud(el)) {
      return { visible: false };
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) {
      return { visible: false };
    }

    const textEl = findTextBearingElement(el);

    let effectiveOpacity = 1;
    let pointerNone = false;
    let attrDisabled = false;
    let classDisabled = false;
    let hasBgImage = false;
    const bgLayers = [];

    // Walk from textEl up through el to document.body so backgrounds on inner wrappers are always captured!
    let node = textEl || el;
    let depth = 0;
    while (node && node instanceof Element && depth < 22) {
      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") {
        return { visible: false };
      }

      const op = parseFloat(cs.opacity);
      if (!Number.isNaN(op)) {
        effectiveOpacity *= op;
      }
      if (effectiveOpacity < 0.03) {
        return { visible: false };
      }

      if (cs.pointerEvents === "none") {
        pointerNone = true;
      }

      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        hasBgImage = true;
      }

      if (
        node.disabled === true ||
        node.getAttribute("aria-disabled") === "true" ||
        node.hasAttribute("inert") ||
        (node.tagName === "FIELDSET" && node.disabled)
      ) {
        attrDisabled = true;
      }

      const cls = typeof node.className === "string" ? node.className : "";
      if (/\b(disabled|is-disabled|locked|is-locked|inactive|is-inactive)\b/i.test(cls)) {
        classDisabled = true;
      }

      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.01) {
        bgLayers.push(bg);
      }

      if (node === document.body || node === document.documentElement) break;
      node = node.parentElement;
      depth++;
    }

    const selfCs = window.getComputedStyle(el);
    let selfBgParsed = parseColor(selfCs.backgroundColor);
    let selfBgAlpha = selfBgParsed ? selfBgParsed.a : 0;

    if (selfBgAlpha < 0.05) {
      const paintedChild = findPaintedSurfaceChild(el, rect);
      if (paintedChild) {
        const childBg = parseColor(window.getComputedStyle(paintedChild).backgroundColor);
        if (childBg && childBg.a > 0.05) {
          if (bgLayers.length === 0) bgLayers.unshift(childBg);
          selfBgAlpha = childBg.a;
        }
      }
    }

    let compBg = { r: 255, g: 255, b: 255 };
    for (let i = bgLayers.length - 1; i >= 0; i--) {
      const layer = bgLayers[i];
      const a = Math.min(1, Math.max(0, layer.a));
      compBg = {
        r: layer.r * a + compBg.r * (1 - a),
        g: layer.g * a + compBg.g * (1 - a),
        b: layer.b * a + compBg.b * (1 - a)
      };
    }

    const textCs = window.getComputedStyle(textEl);
    const fgRaw = parseColor(textCs.color) || parseColor(selfCs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const fgAlpha = Math.min(1, Math.max(0, fgRaw.a * effectiveOpacity));
    const compFg = {
      r: fgRaw.r * fgAlpha + compBg.r * (1 - fgAlpha),
      g: fgRaw.g * fgAlpha + compBg.g * (1 - fgAlpha),
      b: fgRaw.b * fgAlpha + compBg.b * (1 - fgAlpha)
    };

    const textContrast = contrastRatio(compFg, compBg);
    const cursor = selfCs.cursor !== "auto" ? selfCs.cursor : textCs.cursor || "auto";

    const isGradedGreen =
      compBg.g > 150 && compBg.g - compBg.r >= 25 && compBg.g - compBg.b >= 20;
    const isGradedRed =
      compBg.r > 185 && compBg.r - compBg.g >= 35 && compBg.r - compBg.b >= 35;

    const borderColor = parseColor(selfCs.borderTopColor || selfCs.borderColor);
    const hasGradedBorder = Boolean(
      borderColor &&
      borderColor.a > 0.4 &&
      parseFloat(selfCs.borderTopWidth || "0") >= 1.5 &&
      ((borderColor.g > 135 && borderColor.g - borderColor.r > 40) ||
        (borderColor.r > 185 && borderColor.r - borderColor.g > 70))
    );

    // Only flag lowContrastGray when the background & text are achromatic (gray-on-gray / white-on-gray),
    // NEVER when the element has a saturated color like sky-blue RGB(99,187,237) or blue RGB(13,143,237)!
    const bgSpread =
      Math.max(compBg.r, compBg.g, compBg.b) - Math.min(compBg.r, compBg.g, compBg.b);
    const fgSpread =
      Math.max(compFg.r, compFg.g, compFg.b) - Math.min(compFg.r, compFg.g, compFg.b);
    const isAchromatic = bgSpread < 28 && fgSpread < 28;

    const lowContrastGray =
      !hasBgImage && (textContrast < 1.35 || (isAchromatic && textContrast < 2.35));
    const dimmed = effectiveOpacity < 0.82;

    const inactive =
      attrDisabled ||
      classDisabled ||
      pointerNone ||
      dimmed ||
      cursor === "not-allowed" ||
      lowContrastGray;

    return {
      visible: true,
      rect,
      effectiveOpacity: Number(effectiveOpacity.toFixed(2)),
      pointerNone,
      attrDisabled,
      classDisabled,
      dimmed,
      lowContrastGray,
      hasBgImage,
      textContrast: Number(textContrast.toFixed(2)),
      cursor,
      compBg,
      compFg,
      lumBg: Number(relativeLuminance(compBg).toFixed(2)),
      lumFg: Number(relativeLuminance(compFg).toFixed(2)),
      selfBgAlpha: Number(selfBgAlpha.toFixed(2)),
      isGradedGreen,
      isGradedRed,
      hasGradedBorder,
      inactive
    };
  }

  // ============================================================================
  // Button Classification
  // ============================================================================
  const SUBMIT_BTN_REGEX =
    /^(解答|回答|解答する|回答する|解答を送信|回答を送信|送信|送信する|採点|採点する|判定|判定する|決定|確認|確認する|答え合わせ|提出|提出する|テストを提出|テストを終了|解答終了|回答終了|チェック|submit|answer|check|confirm|verify)$/i;
  const SUBMIT_PARTIAL_REGEX =
    /(解答する|回答する|解答を送信|回答を送信|採点する|答え合わせ|提出する|テストを提出|テストを終了|終了して採点|完了して採点|確認する|チェックする|判定する)/i;

  const NEXT_BTN_REGEX =
    /^(次へ|次の問題|次の問題へ|次へ進む|次に進む|進む|次問|次問へ|次ページ|次のページ|開始|開始する|スタート|テスト開始|受講開始|テストを受ける|テストを受け直す|受け直す|再挑戦|再テスト|続ける|続行|再開|再開する|解説を閉じる|完了|完了する|終了する|結果を見る|結果表示|採点結果|ok|yes|はい|next|continue|start|resume|finish)$/i;
  const NEXT_PARTIAL_REGEX =
    /(次の問題|次へ進む|次に進む|次のパート|次のセクション|次のアクティビティ|次のステージ|次のレッスン|パートへ進む|ステージへ進む|レッスンへ進む|完了して次へ|次の設問|次のページ|テストを開始|解説を閉じる|結果を見る|次のステップ|next\s*(?:question|part|section|step|lesson|activity))/i;

  const AVOID_BTN_REGEX =
    /^(戻る|前へ|前の問題|前のページ|一覧へ戻る|コース一覧|マイページ|ホーム|ログアウト|サインアウト|退室|中断|中断する|トレーニングを終了|学習を終了|レッスンを終了|やめる|キャンセル|閉じる|リセット|やり直す|もう一回|復習|復習する|印刷|logout|sign\s*out|cancel|back|previous|review)$/i;

  const SKIP_BTN_REGEX =
    /^(スキップ|スキップする|後で|あとで|後で取り組む|あとで取り組む|今はしない|後で行う|skip|skipfornow|dolater|later)$/i;

  const RECORDING_TASK_REGEX =
    /(自分の発音を録音|あなたの発話を録音|発話を録音|発音を録音|音声をセルフチェック|声を出しづらい場所|リッスン\s*[&＆]\s*リピート|listen\s*(?:&|＆|and)\s*repeat|shadowing|シャドーイング)/i;

  const MEDIA_CONTROL_REGEX =
    /^(x?\d+(\.\d+)?x?|[+-]?\d+\s*s(ec)?|再生|一時停止|音量|ミュート|倍速|再生速度|speed|replay|mute|volume|play|pause)$/i;

  function classifyButtonText(text) {
    const clean = normalizeText(text).replace(/[＞>→»▶▷◀◁«←<＜!！\s]/g, "");
    if (!clean || clean.length > 42) return null;

    if (AVOID_BTN_REGEX.test(clean) || MEDIA_CONTROL_REGEX.test(clean)) return "avoid";
    if (SKIP_BTN_REGEX.test(clean)) return "skip";
    if (SUBMIT_BTN_REGEX.test(clean) || SUBMIT_PARTIAL_REGEX.test(text)) return "submit";
    if (NEXT_BTN_REGEX.test(clean) || NEXT_PARTIAL_REGEX.test(text)) return "next";
    return "other";
  }

  // ============================================================================
  // Native Input Option Resolution
  // ============================================================================
  function resolveInputOptionInfo(input) {
    let labelEl = null;
    let text = "";

    if (input.labels && input.labels.length > 0) {
      const visibleLabel =
        Array.from(input.labels).find((l) => inspectElementVisualState(l).visible) ||
        input.labels[0];
      labelEl = visibleLabel;
      text = Array.from(input.labels)
        .map((l) => normalizeText(l.innerText || l.textContent))
        .filter(Boolean)
        .join(" ");
    }

    if (!text && input.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (byFor) {
          labelEl = byFor;
          text = normalizeText(byFor.innerText || byFor.textContent);
        }
      } catch (_) { }
    }

    if (!labelEl) {
      const closestLabel = input.closest("label");
      if (closestLabel) {
        labelEl = closestLabel;
        if (!text) text = normalizeText(closestLabel.innerText || closestLabel.textContent);
      }
    }

    if (!text) {
      const labelledBy = input.getAttribute("aria-labelledby");
      if (labelledBy) {
        text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((el) => normalizeText(el.innerText || el.textContent))
          .join(" ");
      }
      if (!text && input.getAttribute("aria-label")) {
        text = normalizeText(input.getAttribute("aria-label"));
      }
    }

    let containerEl = labelEl;
    let parent = input.parentElement;
    for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++) {
      const inputsInParent = parent.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );
      if (inputsInParent.length === 1) {
        if (!containerEl && inspectElementVisualState(parent).visible) {
          containerEl = parent;
        }
        if (!text) {
          text = normalizeText(parent.innerText || parent.textContent);
        }
      } else {
        break;
      }
      parent = parent.parentElement;
    }

    if (!text && input.nextElementSibling) {
      text = normalizeText(
        input.nextElementSibling.innerText || input.nextElementSibling.textContent
      );
      if (!containerEl && inspectElementVisualState(input.nextElementSibling).visible) {
        containerEl = input.nextElementSibling;
      }
    }

    const surfaceEl = containerEl || labelEl || input;
    const visual = inspectElementVisualState(surfaceEl);
    const inputVisual = inspectElementVisualState(input);

    const visible = visual.visible || inputVisual.visible;
    const inactive =
      input.disabled === true ||
      input.getAttribute("aria-disabled") === "true" ||
      Boolean(input.closest("fieldset[disabled], [inert]")) ||
      (visual.visible
        ? visual.dimmed || visual.pointerNone || visual.classDisabled || visual.lowContrastGray
        : false);

    const clickTarget =
      labelEl && inspectElementVisualState(labelEl).visible
        ? labelEl
        : inputVisual.visible
          ? input
          : surfaceEl;

    return {
      visible,
      inactive,
      visual: visual.visible ? visual : inputVisual,
      text: text || normalizeText(input.value) || "(選択肢)",
      clickTarget,
      highlightTarget: surfaceEl
    };
  }

  // ============================================================================
  // Question Block Grouping & Status Classification (with Explicit Debug Reasons!)
  // ============================================================================
  function findLowestCommonAncestor(els) {
    if (!els || els.length === 0) return document.body;
    if (els.length === 1) return els[0].parentElement || document.body;

    const ancestors = [];
    let cur = els[0];
    while (cur) {
      ancestors.push(cur);
      cur = cur.parentElement;
    }

    for (let i = 1; i < els.length; i++) {
      const set = new Set();
      let node = els[i];
      while (node) {
        set.add(node);
        node = node.parentElement;
      }
      while (ancestors.length > 0 && !set.has(ancestors[0])) {
        ancestors.shift();
      }
    }
    return ancestors[0] || document.body;
  }

  function extractCleanTextExcluding(rootEl, excludedSet, inlineBlankIdMap = null) {
    if (!rootEl) return "";
    const pieces = [];

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue.replace(/\s+/g, " ").trim();
        if (val) pieces.push(val);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (excludedSet.has(node) || isInsideHud(node)) return;
      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") return;

      if (inlineBlankIdMap && inlineBlankIdMap.has(node)) {
        pieces.push(`[空欄:${inlineBlankIdMap.get(node)}]`);
        return;
      }

      if (tag === "SELECT" || tag === "TEXTAREA") {
        return;
      }

      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) {
        return;
      }

      const isBlock = /^(DIV|P|H[1-6]|LI|TR|SECTION|ARTICLE|HEADER|BLOCKQUOTE|PRE|DT|DD|FIGCAPTION|LABEL|BR)$/i.test(
        tag
      );
      if (tag === "BR") {
        pieces.push("\n");
        return;
      }

      // Preserve empty blank boxes/underlines (e.g. "He _____ ____ won the lottery")
      if (node.childNodes.length === 0 && (tag === "SPAN" || tag === "DIV" || tag === "B" || tag === "I")) {
        const bBottom = parseFloat(cs.borderBottomWidth) || 0;
        const bgA = parseColor(cs.backgroundColor)?.a ?? 0;
        const rect = node.getBoundingClientRect();
        if ((bBottom >= 1 || bgA > 0.08) && rect.width >= 6 && rect.width <= 180 && rect.height >= 8) {
          pieces.push("_");
          return;
        }
      }

      for (const child of node.childNodes) {
        walk(child);
      }
      if (isBlock) pieces.push("\n");
    }

    walk(rootEl);
    return pieces
      .join(" ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function countQuestionHeadings(text) {
    if (!text) return 0;
    const matches = text.match(
      /(?:^|\n)\s*(?:Q\s*\d+|問\s*\d+|第\s*\d+\s*問|設問\s*\d+)(?:\s|$|[.:：])/gi
    );
    return matches ? matches.length : 0;
  }

  function resolveQuestionCardAndText(groupContainer, allGroupContainers, optionNodes) {
    const otherContainers = allGroupContainers.filter((c) => c !== groupContainer);
    const excluded = new Set([groupContainer, ...optionNodes]);

    let cardEl = groupContainer;
    let anc = groupContainer.parentElement;
    while (anc && anc !== document.body && anc !== document.documentElement) {
      const containsOtherGroup = otherContainers.some((other) => anc.contains(other));
      if (containsOtherGroup) {
        break;
      }
      const ancHeadings = countQuestionHeadings(anc.innerText || "");
      if (ancHeadings >= 2) {
        const curText =
          cardEl !== groupContainer ? extractCleanTextExcluding(cardEl, excluded) : "";
        if (curText.length > 0 || countQuestionHeadings(curText) >= 1) {
          break;
        }
      }
      cardEl = anc;
      anc = anc.parentElement;
    }

    let questionText = "";
    const labelEls = [];
    if (cardEl !== groupContainer) {
      questionText = extractCleanTextExcluding(cardEl, excluded);
    }

    if (!questionText) {
      const prevTexts = [];
      let prev = groupContainer.previousElementSibling;
      let steps = 0;
      while (prev && steps < 6) {
        if (otherContainers.some((other) => prev === other || prev.contains(other))) {
          break;
        }
        const t = normalizeText(prev.innerText || prev.textContent);
        if (t) {
          prevTexts.unshift(t);
          if (t.length <= 24 && /^(?:Q|問|第|設問)\s*\d+\b/i.test(t)) {
            labelEls.push(prev);
          }
        }
        if (/^(Q\s*\d+|問\s*\d+|第\s*\d+\s*問|設問\s*\d+)/i.test(t)) {
          break;
        }
        prev = prev.previousElementSibling;
        steps++;
      }
      questionText = prevTexts.join("\n").trim();
    }

    return {
      cardEl,
      labelEls,
      questionText: questionText.slice(0, 1800)
    };
  }

  // Detect visual selection outlier within a group (e.g. blue bg + white text OR distinct bg shift!)
  function markVisuallySelectedItems(rawItems) {
    if (!rawItems || rawItems.length < 2) return;

    const active = rawItems.filter((it) => !it.inactive && it.visual?.compBg && it.visual?.compFg);
    if (active.length < 2) return;

    // 1. Light bg + dark text siblings vs Colored/darker bg + white/light text item
    const lightBgDarkFgItems = active.filter(
      (it) => it.visual.lumBg > 0.55 && it.visual.lumFg < 0.38
    );

    if (lightBgDarkFgItems.length >= 1 && lightBgDarkFgItems.length < active.length) {
      for (const it of active) {
        if (it.visual.isGradedGreen || it.visual.isGradedRed) continue;
        if (it.visual.lumFg > 0.68 && it.visual.lumBg < 0.65) {
          it.checked = true;
          it.checkedReason = `visual_white_on_color(lumFg=${it.visual.lumFg},lumBg=${it.visual.lumBg})`;
        }
      }
    }

    // 2. Background color outlier check (e.g., 3 items share RGB(234,239,245) while 1 item is blue RGB(99,187,237) even if text stayed dark!)
    if (!active.some((it) => it.checked) && active.length >= 3) {
      const colorDist = (a, b) =>
        Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

      for (let i = 0; i < active.length; i++) {
        const candidate = active[i];
        if (candidate.visual.isGradedGreen || candidate.visual.isGradedRed) continue;
        const others = active.filter((_, idx) => idx !== i);
        // Check if all `others` share virtually identical background color (dist < 18)
        let othersUniform = true;
        for (let j = 1; j < others.length; j++) {
          if (colorDist(others[0].visual.compBg, others[j].visual.compBg) > 18) {
            othersUniform = false;
            break;
          }
        }
        if (
          othersUniform &&
          colorDist(candidate.visual.compBg, others[0].visual.compBg) > 45
        ) {
          candidate.checked = true;
          candidate.checkedReason = `visual_bg_outlier(${rgbStr(candidate.visual.compBg)} vs ${rgbStr(others[0].visual.compBg)})`;
          break;
        }
      }
    }
  }

  function blockHasPerQuestionSubmitButton(
    groupContainer,
    cardEl,
    nextGroupContainer,
    totalGroupsCount,
    optionNodesSet
  ) {
    const optsRect = groupContainer ? groupContainer.getBoundingClientRect() : null;
    const nextTop = nextGroupContainer
      ? nextGroupContainer.getBoundingClientRect().top
      : Infinity;

    const searchRoot =
      cardEl && cardEl !== document.body && nextGroupContainer
        ? cardEl.parentElement || document.body
        : document.body;
    const candidates = searchRoot.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"], a, div, span'
    );

    for (const el of candidates) {
      if (optionNodesSet.has(el) || isInsideHud(el)) continue;
      const rawLen = (el.textContent || "").length;
      if (rawLen === 0 || rawLen > 50) continue;

      const tag = el.tagName;
      if (
        (tag === "DIV" || tag === "SPAN") &&
        el.querySelector('button, input[type="submit"], input[type="button"], a, [role="button"]')
      ) {
        continue;
      }

      const t =
        tag === "INPUT"
          ? normalizeText(el.value)
          : normalizeText(el.innerText || el.textContent);
      if (classifyButtonText(t) !== "submit") continue;

      const vis = inspectElementVisualState(el);
      if (!vis.visible || vis.inactive || vis.rect.width < 36 || vis.rect.height < 20) continue;
      if ((tag === "DIV" || tag === "SPAN") && vis.cursor !== "pointer" && vis.selfBgAlpha < 0.15) {
        continue;
      }

      const insideCard = Boolean(cardEl && cardEl !== document.body && cardEl.contains(el));
      if (insideCard) return true;

      if (
        optsRect &&
        vis.rect.top >= optsRect.top - 20 &&
        vis.rect.top <= optsRect.bottom + 240 &&
        (nextGroupContainer ? vis.rect.top < nextTop + 10 : totalGroupsCount <= 1)
      ) {
        return true;
      }
    }
    return false;
  }

  // Check if cardEl contains a submit button ("確認", "解答する", etc.), even if currently disabled waiting for choices/tiles!
  function blockHasAnySubmitButtonInCard(cardEl, optionNodesSet) {
    if (!cardEl || cardEl === document.body) return false;
    const candidates = cardEl.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"]'
    );
    for (const el of candidates) {
      if (optionNodesSet.has(el) || isInsideHud(el)) continue;
      const t =
        el.tagName === "INPUT"
          ? normalizeText(el.value)
          : normalizeText(el.innerText || el.textContent);
      if (classifyButtonText(t) === "submit") {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 36 && rect.height >= 20) return true;
      }
    }
    return false;
  }

  function hasGradedElementVisual(node) {
    let cur = node;
    for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 3; depth++) {
      const vis = inspectElementVisualState(cur);
      if (vis.visible && (vis.isGradedGreen || vis.isGradedRed || vis.hasGradedBorder)) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function hasVisibleResultBadge(cardEl, optionNodesSet) {
    if (!cardEl || cardEl === document.body) return false;
    const nodes = cardEl.querySelectorAll("div, span, p, strong, b, label");
    for (const el of nodes) {
      if (optionNodesSet.has(el) || isInsideHud(el)) continue;
      if (el.children.length > 0 && (el.textContent || "").length > 260) continue;
      const t = normalizeText(el.innerText || el.textContent || "");
      if (!t || t.length > 240) continue;
      const isShortBadge =
        t.length <= 18 && /^(正解|不正解|解説|Correct|Incorrect|[✓✔✕✖❌⭕])$/i.test(t);
      const isLabeledResult =
        /^(?:[✓✔✕✖❌⭕]\s*)?(?:正解|不正解|解説|解答と解説|Correct\s*Answer|Your\s*Answer)\s*[:：]/i.test(
          t
        );
      if (isShortBadge || isLabeledResult) {
        const vis = inspectElementVisualState(el);
        if (vis.visible) return true;
      }
    }
    return false;
  }

  // Returns { status: "active" | "answered" | "locked", reason: string }
  function classifyQuestionGroup(
    rawItems,
    groupContainer,
    cardEl,
    nextGroupContainer,
    totalGroupsCount,
    anyPointerGroupExists,
    sessionAnsweredSet,
    blockKey,
    pageHasNextOnlyNav = false
  ) {
    const total = rawItems.length;
    if (total === 0) return { status: "locked", reason: "empty_group" };

    const isTileGroup = total >= 3 && rawItems.every((it) => (it.text || "").length <= 2);
    if (!isTileGroup) {
      markVisuallySelectedItems(rawItems);
    }

    const isNative = Boolean(rawItems[0].isNativeInput);
    const anyChecked = rawItems.some((it) => it.checked);
    const hasGradedColor = rawItems.some(
      (it) => it.visual?.isGradedGreen || it.visual?.isGradedRed
    );
    const hasExplicitMark = rawItems.some((it) => /[✓✔✕✖❌⭕]/.test(it.rawTextWithMarks || ""));

    let cardHasResultTint = false;
    if (cardEl && cardEl !== document.body) {
      const cardVis = inspectElementVisualState(cardEl);
      if (cardVis.visible && cardVis.compBg) {
        const { r, g, b } = cardVis.compBg;
        const greenTint = g > 220 && g - r >= 10 && g - b >= 10;
        const redTint = r > 235 && r - g >= 12 && r - b >= 12;
        cardHasResultTint = greenTint || redTint;
      }
    }

    const inactiveCount = rawItems.filter((it) => it.inactive).length;
    const activeCount = total - inactiveCount;
    const optSet = new Set(rawItems.map((it) => it.highlightTarget || it.clickTarget));
    const hasPerQSubmit = blockHasPerQuestionSubmitButton(
      groupContainer,
      cardEl,
      nextGroupContainer,
      totalGroupsCount,
      optSet
    );
    const hasAnySubmitInCard = hasPerQSubmit || blockHasAnySubmitButtonInCard(cardEl, optSet);

    if (hasGradedColor && (inactiveCount >= 1 || cardHasResultTint || hasExplicitMark || !hasAnySubmitInCard)) {
      return { status: "answered", reason: "graded_color_and_tint_or_inactive" };
    }
    if (cardHasResultTint && (inactiveCount >= 1 || hasExplicitMark || !hasAnySubmitInCard)) {
      return { status: "answered", reason: "card_result_tint" };
    }
    if (!hasAnySubmitInCard && hasVisibleResultBadge(cardEl, optSet)) {
      return { status: "answered", reason: "visible_result_badge" };
    }

    // If an active per-question submit button ("確認", "解答する", etc.) is sitting inside/right below this question,
    // this question is 100% still active and awaiting confirmation!
    if (hasPerQSubmit && activeCount >= 1) {
      return { status: "active", reason: "awaiting_per_q_submit_button" };
    }

    // If this card still has a "確認" button inside it (even if disabled until all tiles/choices are filled)
    // and its options have cursor:pointer, it has NOT been submitted yet -> keep it "active"!
    const pointerCount = rawItems.filter((it) => it.visual?.cursor === "pointer").length;
    if (hasAnySubmitInCard && activeCount >= 1 && (!anyPointerGroupExists || pointerCount >= 1)) {
      return { status: "active", reason: "active_card_with_submit_btn" };
    }

    // Session memory: if we ALREADY answered this exact question block in this run
    // and there is no "確認" button inside its card, advance instead of re-solving it!
    if (
      (totalGroupsCount >= 2 || pageHasNextOnlyNav) &&
      blockKey &&
      sessionAnsweredSet?.has(blockKey) &&
      !hasAnySubmitInCard
    ) {
      return { status: "answered", reason: "session_memory_already_clicked" };
    }

    if (isNative) {
      if (activeCount === 0) {
        return {
          status: anyChecked || hasGradedColor ? "answered" : "locked",
          reason: "native_all_inactive"
        };
      }
      if (anyChecked) {
        return hasPerQSubmit
          ? { status: "active", reason: "native_checked_awaiting_per_q_submit" }
          : { status: "answered", reason: "native_checked_worksheet" };
      }
      if (activeCount < Math.min(2, total) && total >= 2) {
        return { status: "answered", reason: "native_fewer_than_2_active" };
      }
      return { status: "active", reason: "native_unanswered" };
    }

    if (anyPointerGroupExists) {
      const pointerCount = rawItems.filter((it) => it.visual?.cursor === "pointer").length;
      if (pointerCount === 0) {
        return {
          status: hasGradedColor || anyChecked || cardHasResultTint ? "answered" : "locked",
          reason: "no_cursor_pointer_vs_active_group"
        };
      }
    }

    if (activeCount < Math.min(2, total)) {
      return {
        status:
          hasGradedColor || anyChecked || cardHasResultTint || inactiveCount < total
            ? "answered"
            : "locked",
        reason: `fewer_than_2_active(${activeCount}/${total})`
      };
    }

    if (rawItems.some((it) => it.visual?.hasGradedBorder) && (inactiveCount > 0 || !hasAnySubmitInCard)) {
      return { status: "answered", reason: "graded_border_with_inactive_siblings" };
    }

    if (anyChecked && rawItems[0].choiceType !== "checkbox") {
      return hasPerQSubmit
        ? { status: "active", reason: "choice_selected_awaiting_per_q_submit" }
        : { status: "answered", reason: "choice_selected_worksheet" };
    }

    return { status: "active", reason: "active_unanswered" };
  }

  // Scan visible action buttons, including React/Tailwind <div>/<span> buttons (e.g., "確認", "次へ")
  function scanActionButtons(
    claimedElements,
    targetBlock,
    nextBlockBelow,
    includeSkipButtons = false,
    inactiveOut = null
  ) {
    const results = [];
    const rawCandidates = document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a, [role="button"], [onclick], [class*="btn" i], [class*="button" i], div, span'
    );

    const optsRect = targetBlock?.container
      ? targetBlock.container.getBoundingClientRect()
      : null;
    const nextBlockTop = nextBlockBelow?.container
      ? nextBlockBelow.container.getBoundingClientRect().top
      : Infinity;

    const seenButtonEls = new Set();

    for (const el of rawCandidates) {
      if (claimedElements?.has(el) || isInsideHud(el)) continue;

      const tag = el.tagName;
      const isGenericBox =
        (tag === "DIV" || tag === "SPAN") &&
        el.getAttribute("role") !== "button" &&
        !el.hasAttribute("onclick");

      if (isGenericBox) {
        const rawLen = (el.textContent || "").length;
        if (rawLen === 0 || rawLen > 55) continue;
        if (
          el.querySelector(
            'button, input[type="submit"], input[type="button"], a, [role="button"]'
          )
        ) {
          continue;
        }
      }

      const text =
        tag === "INPUT"
          ? normalizeText(el.value || el.getAttribute("aria-label") || "送信")
          : normalizeText(
            el.innerText ||
            el.textContent ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title")
          );

      if (!text || text.length > 45) continue;

      const kind = classifyButtonText(text);
      // Only include explicit submit, next, and (on recording tasks) skip buttons!
      // Never include "other" buttons (such as audio speed "x1.00", "5s", bookmark, etc.)
      if (kind !== "submit" && kind !== "next" && !(includeSkipButtons && kind === "skip")) {
        continue;
      }

      if (isGenericBox) {
        if (el.children.length === 1) {
          const child = el.firstElementChild;
          const childText = normalizeText(child.innerText || child.textContent);
          if (childText === text) {
            const selfCs = window.getComputedStyle(el);
            const selfBgA = parseColor(selfCs.backgroundColor)?.a ?? 0;
            const selfHasBgImg = Boolean(selfCs.backgroundImage && selfCs.backgroundImage !== "none");
            if (selfBgA < 0.05 && !selfHasBgImg && selfCs.cursor !== "pointer") {
              continue;
            }
          }
        }
      }

      let duplicateAncestor = false;
      for (const seen of seenButtonEls) {
        if (seen.contains(el) || el.contains(seen)) {
          duplicateAncestor = true;
          break;
        }
      }
      if (duplicateAncestor) continue;

      const vis = inspectElementVisualState(el);
      if (!vis.visible) continue;
      if (vis.inactive) {
        if (Array.isArray(inactiveOut) && inactiveOut.length < 6) {
          const reasons = [];
          if (vis.attrDisabled) reasons.push("disabled");
          if (vis.classDisabled) reasons.push("class");
          if (vis.pointerNone) reasons.push("pointerNone");
          if (vis.dimmed) reasons.push(`op=${vis.effectiveOpacity}`);
          if (vis.lowContrastGray) reasons.push(`lowContrast(${vis.textContrast})`);
          if (vis.cursor === "not-allowed") reasons.push("not-allowed");
          inactiveOut.push({ text, kind, tag: describeEl(el), reasons: reasons.join(",") });
        }
        continue;
      }

      if (isGenericBox) {
        if (vis.rect.width < 36 || vis.rect.height < 20 || vis.rect.height > 140) continue;
        if (vis.cursor !== "pointer" && vis.selfBgAlpha < 0.15 && !vis.hasBgImage) continue;
      }

      const insideActiveCard = Boolean(
        targetBlock?.cardEl &&
        targetBlock.cardEl !== document.body &&
        targetBlock.cardEl.contains(el)
      );

      const geometricallyBelowActiveOptions = Boolean(
        optsRect &&
        vis.rect.top >= optsRect.top - 24 &&
        vis.rect.top <= optsRect.bottom + 260 &&
        vis.rect.top < nextBlockTop + 16
      );

      const belongsToActiveQuestion = insideActiveCard || geometricallyBelowActiveOptions;

      seenButtonEls.add(el);
      results.push({
        el,
        tagDesc: describeEl(el),
        text,
        kind,
        insideActiveCard,
        belongsToActiveQuestion,
        vis
      });
    }

    return results;
  }

  // ============================================================================
  // Audio & Hidden Transcript Extraction (for Listening Tasks)
  // ============================================================================
  function resolveFullUrl(raw) {
    if (!raw || typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) return null;
    try {
      return new URL(trimmed, location.href).href;
    } catch (_) {
      return null;
    }
  }

  function isUiSoundEffectUrl(url) {
    if (!url || typeof url !== "string") return true;
    return /\/app\/audio\/|\/(question_correct|question_incorrect|question_answered|activity_done|item_done|key_tap|got_green_check_mark|got_gold_check_mark|beep|click|ding|sfx)\.(mp3|m4a|wav|ogg|aac)(\?|$|#)/i.test(
      url
    );
  }

  function getPerformanceAudioUrls() {
    const urls = [];
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (const entry of entries) {
        const name = entry.name || "";
        if (isUiSoundEffectUrl(name)) continue;
        if (
          /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$|#)/i.test(name) ||
          entry.initiatorType === "audio"
        ) {
          if (!urls.includes(name)) urls.push(name);
        }
      }
    } catch (_) { }
    return urls;
  }

  function scanFiberWithinScope(rootEl, stopBoundaryEl) {
    const scopedAudioUrls = [];
    const scopedHints = [];
    if (!rootEl) return { scopedAudioUrls, scopedHints };

    try {
      const seenObjs = new WeakSet();
      const inspectObj = (obj, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 5 || seenObjs.has(obj)) return;
        seenObjs.add(obj);
        if (obj instanceof Node || obj instanceof Window) return;

        const keys = Object.keys(obj);
        for (let i = 0; i < Math.min(keys.length, 50); i++) {
          const k = keys[i];
          if (k === "children" || k === "_owner" || k === "stateNode") continue;
          let val;
          try {
            val = obj[k];
          } catch (_) {
            continue;
          }

          if (typeof val === "string") {
            const s = val.trim();
            if (
              /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?[^\s"'<>]*)?$/i.test(s) &&
              s.length < 500
            ) {
              const full = resolveFullUrl(s);
              if (full && !scopedAudioUrls.includes(full)) scopedAudioUrls.push(full);
            } else if (
              /^(transcript|script|audioScript|dialogue|narration|subtitles|captions|listeningText|explanation|feedback|commentary|rationale|sentence|example|answer|correctAnswer|solution)$/i.test(
                k
              ) &&
              s.length >= 2 &&
              s.length <= 12000
            ) {
              const clean = normalizeText(s.replace(/<[^>]+>/g, " "));
              if (clean.length >= 2 && !scopedHints.includes(`${k}: ${clean}`)) {
                scopedHints.push(`${k}: ${clean}`);
              }
            }
          } else if (val && typeof val === "object") {
            inspectObj(val, depth + 1);
          }
        }
      };

      const nodes = [rootEl, ...Array.from(rootEl.querySelectorAll("*")).slice(0, 120)];
      for (const el of nodes) {
        const ownKeys = Object.keys(el);
        for (const rk of ownKeys) {
          if (
            rk.startsWith("__reactFiber$") ||
            rk.startsWith("__reactProps$") ||
            rk.startsWith("__reactContainer$")
          ) {
            let fiber = el[rk];
            let up = 0;
            while (fiber && up < 8) {
              if (
                stopBoundaryEl &&
                fiber.stateNode instanceof Element &&
                !stopBoundaryEl.contains(fiber.stateNode)
              ) {
                break;
              }
              if (fiber.memoizedProps) inspectObj(fiber.memoizedProps, 0);
              if (fiber.memoizedState) inspectObj(fiber.memoizedState, 0);
              fiber = fiber.return;
              up++;
            }
          }
        }
      }
    } catch (_) { }

    return { scopedAudioUrls, scopedHints };
  }

  function extractAudioAndTranscriptContext(
    targetBlock = null,
    targetBlockIdx = -1,
    totalBlocks = 0,
    sharedContext = ""
  ) {
    const audioUrls = new Set();
    const transcriptChunks = [];

    // 1. Scan <audio>, <video>, <source> elements (even if hidden!)
    const domAudioUrls = [];
    document.querySelectorAll("audio, video, source").forEach((el) => {
      const candidates = [
        el.currentSrc,
        el.src,
        el.getAttribute("src"),
        el.getAttribute("data-src"),
        el.getAttribute("data-audio"),
        el.getAttribute("data-url")
      ];
      for (const c of candidates) {
        const full = resolveFullUrl(c);
        if (full) {
          audioUrls.add(full);
          if (!domAudioUrls.includes(full)) domAudioUrls.push(full);
        }
      }
    });

    // 2. Scan PerformanceResourceTiming for loaded/cached audio media URLs
    for (const u of getPerformanceAudioUrls()) {
      audioUrls.add(u);
    }

    // 3. Scan explicit hidden DOM transcript containers (do NOT match "script"/"subtitle" which false-match "description"/headers!)
    try {
      const hiddenCandidates = document.querySelectorAll(
        '[class*="transcript" i], [id*="transcript" i], [data-transcript]'
      );
      for (const el of hiddenCandidates) {
        if (isInsideHud(el)) continue;
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
        const txt = normalizeText(el.textContent || "");
        if (txt.length >= 30 && txt.length <= 12000 && !transcriptChunks.includes(txt)) {
          transcriptChunks.push(txt);
        }
      }
    } catch (_) { }

    // 4. Scoped React Fiber scan on the active question block first (prevents mixing Q1..Q4!)
    const cardScopeEl = targetBlock?.cardEl && targetBlock.cardEl !== document.body
      ? targetBlock.cardEl
      : targetBlock?.container || null;
    const { scopedAudioUrls, scopedHints } = cardScopeEl
      ? scanFiberWithinScope(cardScopeEl, cardScopeEl)
      : { scopedAudioUrls: [], scopedHints: [] };

    for (const u of scopedAudioUrls) {
      if (!isUiSoundEffectUrl(u)) audioUrls.add(u);
    }
    for (const h of scopedHints) {
      if (!transcriptChunks.includes(h)) transcriptChunks.push(h);
    }

    // Also scan page-level Fiber if single-question / shared audio player
    if (totalBlocks <= 1 || scopedAudioUrls.length === 0) {
      const pageFiber = scanFiberWithinScope(document.body, null);
      for (const u of pageFiber.scopedAudioUrls) {
        if (!isUiSoundEffectUrl(u)) audioUrls.add(u);
      }
      if (totalBlocks <= 1) {
        for (const h of pageFiber.scopedHints) {
          if (!transcriptChunks.includes(h)) transcriptChunks.push(h);
        }
      }
    }

    const allAudioList = Array.from(audioUrls).filter((u) => !isUiSoundEffectUrl(u));

    // Resolve whether THIS active question card vs a page-wide shared player owns the audio
    const activeQText = targetBlock?.questionText || "";
    const sharedText = sharedContext || "";

    const activeCardHasAudio =
      Boolean(cardScopeEl && cardScopeEl.querySelector("audio")) ||
      Boolean(cardScopeEl && collectCircularPlayButtons().some((b) => cardScopeEl.contains(b.el))) ||
      /\b00:\d{2}\b[\s\S]{0,120}\b0\d:\d{2}\b/.test(activeQText) ||
      /(do you hear|listen to|音声を聞いて|聞いて.*答え)/i.test(activeQText);

    const sharedFiberHrefNow = document.documentElement?.getAttribute("data-elk-shared-fiber-href");
    const hasVisibleAudioWidget =
      Boolean(document.querySelector("audio, video")) ||
      collectCircularPlayButtons().length > 0 ||
      /\b00:\d{2}\b[\s\S]{0,120}\b0\d:\d{2}\b/.test(sharedText) ||
      (sharedFiberHrefNow === location.href &&
        Boolean(document.documentElement?.getAttribute("data-elk-shared-fiber-audio")));

    const sharedAreaHasAudio =
      hasVisibleAudioWidget ||
      /(音声を聞いて|聞いて.*答え|do you hear|listen to the audio)/i.test(sharedText);

    // Resolve the exact audio URL for the active question block
    let activeAudioUrl = null;

    // A) Check MAIN-world Fiber-stamped attribute on cardScopeEl or its children
    if (cardScopeEl) {
      const stampedAudio =
        cardScopeEl.getAttribute("data-elk-fiber-audio") ||
        cardScopeEl.querySelector("[data-elk-fiber-audio]")?.getAttribute("data-elk-fiber-audio") ||
        cardScopeEl.closest("[data-elk-fiber-audio]")?.getAttribute("data-elk-fiber-audio");
      if (stampedAudio && !isUiSoundEffectUrl(stampedAudio)) {
        activeAudioUrl = resolveFullUrl(stampedAudio);
      }

      const stampedHint =
        cardScopeEl.getAttribute("data-elk-fiber-hint") ||
        cardScopeEl.querySelector("[data-elk-fiber-hint]")?.getAttribute("data-elk-fiber-hint") ||
        cardScopeEl.closest("[data-elk-fiber-hint]")?.getAttribute("data-elk-fiber-hint");
      if (stampedHint && !transcriptChunks.includes(stampedHint)) {
        transcriptChunks.push(stampedHint);
      }
    }

    // B) Check scopedAudioUrls or <audio>/<source> inside cardScopeEl or single DOM <audio>
    if (!activeAudioUrl && scopedAudioUrls.length === 1) {
      activeAudioUrl = scopedAudioUrls.find((u) => !isUiSoundEffectUrl(u)) || null;
    }
    if (!activeAudioUrl && cardScopeEl) {
      const cardAudioEl = cardScopeEl.querySelector("audio, source");
      if (cardAudioEl) {
        const cand = resolveFullUrl(
          cardAudioEl.currentSrc || cardAudioEl.src || cardAudioEl.getAttribute("src")
        );
        if (cand && !isUiSoundEffectUrl(cand)) activeAudioUrl = cand;
      }
    }
    if (!activeAudioUrl && domAudioUrls.length === 1 && !isUiSoundEffectUrl(domAudioUrls[0])) {
      activeAudioUrl = domAudioUrls[0];
    }

    // C) Shared audio player outside question cards (e.g., fixed bottom bar shared by Q1..Q3!)
    const sharedFiberHref = document.documentElement?.getAttribute("data-elk-shared-fiber-href");
    if (!activeAudioUrl && !activeCardHasAudio && sharedAreaHasAudio) {
      const sharedFiberAudio =
        sharedFiberHref === location.href
          ? document.documentElement?.getAttribute("data-elk-shared-fiber-audio")
          : null;
      if (sharedFiberAudio && !isUiSoundEffectUrl(sharedFiberAudio)) {
        activeAudioUrl = resolveFullUrl(sharedFiberAudio);
      }
    }
    if (!activeCardHasAudio && sharedAreaHasAudio && sharedFiberHref === location.href) {
      const sharedHint = document.documentElement?.getAttribute("data-elk-shared-fiber-hint");
      if (sharedHint && !transcriptChunks.includes(sharedHint)) {
        transcriptChunks.push(sharedHint);
      }
    }

    // D) Lesson-scoped latest shared audio URL (ignores old lessons cached in Performance API!)
    if (!activeAudioUrl && allAudioList.length === 1) {
      activeAudioUrl = allAudioList[0];
    } else if (
      !activeAudioUrl &&
      allAudioList.length > 0 &&
      (totalBlocks <= 1 || (!activeCardHasAudio && sharedAreaHasAudio))
    ) {
      const lessonMatch = (location.pathname || "").match(/\/lessons\/(\d+)/);
      const lessonPool = lessonMatch
        ? allAudioList.filter((u) => new RegExp(`/contents/[^/]+/${lessonMatch[1]}/`).test(u))
        : [];
      const pool = lessonPool.length > 0 ? lessonPool : allAudioList;
      activeAudioUrl = pool[pool.length - 1] || pool[0];
    }

    const hasAudioPlayer = activeCardHasAudio || sharedAreaHasAudio;

    return {
      activeAudioUrl: hasAudioPlayer ? activeAudioUrl : null,
      audioUrls: allAudioList,
      hiddenTranscript: hasAudioPlayer ? transcriptChunks.join("\n").slice(0, 8000) : "",
      hasAudioPlayer
    };
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // Find the play button (▶) for the active question (excluding 5s rewind and x1.00 speed buttons!)
  function isOrangeColor(c) {
    return Boolean(c) && c.r > 180 && c.g > 85 && c.b < 80 && c.r - c.b > 95;
  }

  function isVividBlueColor(c) {
    return Boolean(c) && c.b > 170 && c.b - c.r > 80;
  }

  function isPaleBlueColor(c) {
    return Boolean(c) && c.b > 190 && c.r > 145 && c.g > 175 && c.b - c.r < 85;
  }

  function isAnyHtmlAudioPlaying() {
    try {
      return Array.from(document.querySelectorAll("audio, video")).some(
        (m) => !m.paused && !m.ended && m.currentTime > 0
      );
    } catch (_) {
      return false;
    }
  }

  function isPlayIconSymbolText(t) {
    return !t || /^[▶►▷⏸❚|│┃\s]+$/.test(t) || /^(?:II|\|\|)$/.test(t);
  }

  function hasGraphicOrCssPlayIndicator(el) {
    if (!el) return false;
    if (el.querySelector('svg, i, img, polygon, path, [class*="icon" i], [class*="play" i]')) {
      return true;
    }
    const hasPseudoIcon = (target) => {
      for (const pseudo of ["::before", "::after"]) {
        try {
          const pcs = window.getComputedStyle(target, pseudo);
          if (!pcs) continue;
          if (pcs.backgroundImage && pcs.backgroundImage !== "none") return true;
          if (parseFloat(pcs.borderLeftWidth || "0") >= 5) return true;
          const c = pcs.content;
          if (c && c !== "none" && c !== "normal" && c !== '""' && c !== "''") return true;
        } catch (_) { }
      }
      return false;
    };
    if (hasPseudoIcon(el)) return true;
    try {
      const descendants = el.querySelectorAll("*");
      for (const child of descendants) {
        if (!(child instanceof Element)) continue;
        const cs = window.getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
        if (hasPseudoIcon(child)) return true;
        // Pure CSS border triangle (e.g. width:0; height:0; border-left: 12px solid ...)
        const bLeft = parseFloat(cs.borderLeftWidth || "0");
        const cr = child.getBoundingClientRect();
        if (bLeft >= 5 && cr.width <= 28 && cr.height <= 28) return true;
        // Centered square/circle badge child inside a wider bar
        if (
          cr.width >= 16 &&
          cr.width <= 72 &&
          cr.height >= 16 &&
          cr.height <= 72 &&
          Math.abs(cr.width - cr.height) <= 14
        ) {
          const bg = parseColor(cs.backgroundColor);
          if (bg && bg.a > 0.25) return true;
        }
      }
    } catch (_) { }
    return false;
  }

  function isElementOrAncestorLocked(el) {
    let node = el;
    let effectiveOpacity = 1;
    let depth = 0;
    while (node && node instanceof Element && depth < 20) {
      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return "hidden";
      const op = parseFloat(cs.opacity);
      if (!Number.isNaN(op)) {
        effectiveOpacity *= op;
        if (effectiveOpacity < 0.82) return `dimmed(${effectiveOpacity.toFixed(2)})`;
      }
      if (cs.pointerEvents === "none") return "pointerNone";
      if (
        node.disabled === true ||
        node.getAttribute("aria-disabled") === "true" ||
        node.hasAttribute("inert")
      ) {
        return "attrDisabled";
      }
      const cls = typeof node.className === "string" ? node.className : "";
      if (/\b(disabled|is-disabled|locked|is-locked|inactive|is-inactive)\b/i.test(cls)) {
        return "classDisabled";
      }
      if (node === el && cs.cursor === "not-allowed") return "cursorNotAllowed";
      if (node === document.body || node === document.documentElement) break;
      node = node.parentElement;
      depth++;
    }
    return "";
  }

  function collectCircularPlayButtons() {
    const candidates = document.querySelectorAll('button, [role="button"], [onclick], div, span');
    const rawMatches = [];

    for (const el of candidates) {
      if (isInsideHud(el)) continue;
      if (el.closest("nav, header")) continue;
      if (el.querySelector("input, select, textarea")) continue;

      const t = normalizeText(el.innerText || el.textContent || "");
      if (t.length > 0 && MEDIA_CONTROL_REGEX.test(t)) continue;
      if (t.length > 4 || !isPlayIconSymbolText(t)) continue;
      if (t.length === 1 && /^[a-z0-9]$/i.test(t)) continue;

      // Never treat buttons inside a letter-tile grid (>=3 short 1-2 char sibling buttons) as play buttons
      const parentEl = el.parentElement;
      if (parentEl && parentEl.tagName !== "BODY") {
        const siblingShortBtns = Array.from(parentEl.children).filter((ch) => {
          if (ch.tagName !== "BUTTON" && ch.getAttribute("role") !== "button") return false;
          const ct = normalizeText(ch.innerText || ch.textContent || "");
          return ct.length >= 1 && ct.length <= 2;
        });
        if (siblingShortBtns.length >= 3) continue;
      }

      const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
      if (/(5s|10s|rewind|replay|speed|倍速|bookmark|favorite|hint|close|閉じる|backspace|delete|erase|clear|消去|削除)/i.test(aria)) continue;

      const vis = inspectElementVisualState(el);
      if (!vis.visible) continue;

      // Exclude top-bar corner navigation icons (X close, bookmark, menu ...) outside interaction cards
      if (
        vis.rect.top < 80 &&
        !el.closest('[id^="interaction-"]') &&
        (vis.rect.left < 110 || vis.rect.right > window.innerWidth - 220)
      ) {
        continue;
      }

      const isCircleShape =
        vis.rect.width >= 18 &&
        vis.rect.width <= 96 &&
        vis.rect.height >= 18 &&
        vis.rect.height <= 96 &&
        Math.abs(vis.rect.width - vis.rect.height) <= 22;

      const isWideBarShape =
        vis.rect.width > 84 &&
        vis.rect.width <= 780 &&
        vis.rect.height >= 26 &&
        vis.rect.height <= 110 &&
        el.querySelectorAll("button").length === 0;

      if (!isCircleShape && !isWideBarShape) {
        continue;
      }

      const parentVis = el.parentElement ? inspectElementVisualState(el.parentElement) : null;
      const hasGraphicIcon = hasGraphicOrCssPlayIndicator(el);
      const isBlueSurface = isVividBlueColor(vis.compBg);
      const isOrangeSurface = isOrangeColor(vis.compBg) || isOrangeColor(parentVis?.compBg);
      const hasVividParentBar = isVividBlueColor(parentVis?.compBg) || isOrangeColor(parentVis?.compBg);
      const hasPaleParentBar = Boolean(parentVis && isPaleBlueColor(parentVis.compBg));
      const isPaleSurface = isPaleBlueColor(vis.compBg);

      if (isCircleShape) {
        if (
          !hasGraphicIcon &&
          !/(play|pause|再生|一時停止)/i.test(aria) &&
          !isBlueSurface &&
          !isOrangeSurface &&
          !hasVividParentBar &&
          !hasPaleParentBar
        ) {
          continue;
        }
        // Reject backspace [⌫] SVG icon buttons sitting inside letter-tile puzzle cards
        const interactionAncestor = el.closest ? el.closest('[id^="interaction-"]') : null;
        if (interactionAncestor && !/(play|pause|再生|一時停止)/i.test(aria)) {
          const shortTileBtns = Array.from(interactionAncestor.querySelectorAll("button")).filter((b) => {
            const bt = normalizeText(b.innerText || b.textContent || "");
            return bt.length >= 1 && bt.length <= 2;
          });
          if (shortTileBtns.length >= 3) {
            const cardText = interactionAncestor.innerText || interactionAncestor.textContent || "";
            const cardHasTimeOrAudio =
              Boolean(interactionAncestor.querySelector("audio")) || /\b0\d:\d{2}\b/.test(cardText);
            if (!cardHasTimeOrAudio && !isBlueSurface && !isOrangeSurface) {
              continue;
            }
          }
        }
      } else {
        // Wide bar play button (e.g., full-width blue footer strip on flashcards)
        if (!hasGraphicIcon && !/(play|pause|再生|一時停止|audio)/i.test(aria)) {
          continue;
        }
        if (
          el.tagName !== "BUTTON" &&
          el.getAttribute("role") !== "button" &&
          !el.hasAttribute("onclick") &&
          vis.cursor !== "pointer" &&
          !isBlueSurface &&
          !isOrangeSurface &&
          !isPaleSurface
        ) {
          continue;
        }
      }

      const closestBtn = el.closest('button, [role="button"]');
      const closestBtnVis =
        closestBtn && closestBtn !== el ? inspectElementVisualState(closestBtn) : null;
      const effectiveCursor =
        closestBtnVis?.cursor && closestBtnVis.cursor !== "auto"
          ? closestBtnVis.cursor
          : vis.cursor;

      const looksClickableControl =
        el.tagName === "BUTTON" ||
        el.getAttribute("role") === "button" ||
        el.hasAttribute("onclick") ||
        Boolean(closestBtn) ||
        effectiveCursor === "pointer" ||
        isBlueSurface ||
        isOrangeSurface ||
        isPaleSurface ||
        hasVividParentBar ||
        hasPaleParentBar ||
        Boolean(el.closest('[id^="interaction-"]'));

      if (!looksClickableControl) continue;

      const lockReasonSelf = isElementOrAncestorLocked(el);
      const selfOrAncDisabled = Boolean(lockReasonSelf);

      rawMatches.push({
        el,
        closestBtn,
        isCircleShape,
        rect: vis.rect,
        vis,
        parentVis,
        effectiveCursor,
        selfOrAncDisabled,
        lockReasonSelf,
        isOrangeCircle: isOrangeSurface,
        hasVividBar: isBlueSurface || isOrangeSurface || hasVividParentBar,
        hasPaleBar: !isBlueSurface && !isOrangeSurface && (hasPaleParentBar || isPaleSurface)
      });
    }

    // Card-level fallback for Reallyenglish [id^="interaction-"] flashcards if no icon control matched above
    const pageHasFlashcardCue = /(単語カード|重要表現|flashcard|vocabulary)/i.test(
      normalizeText(document.body?.innerText || "").slice(0, 600)
    );
    if (pageHasFlashcardCue) {
      document.querySelectorAll('[id^="interaction-"]').forEach((card) => {
        if (isInsideHud(card)) return;
        if (rawMatches.some((m) => card.contains(m.el))) return;
        if (card.querySelector("input, select, textarea")) return;
        const innerCandidates = Array.from(card.querySelectorAll('button, [role="button"], div')).filter((sub) => {
          if (sub.querySelector("button")) return false;
          const t = normalizeText(sub.innerText || sub.textContent || "");
          if (t.length > 0 && !isPlayIconSymbolText(t)) return false;
          const v = inspectElementVisualState(sub);
          if (!v.visible || v.rect.width < 24 || v.rect.height < 24 || v.rect.height > 120) return false;
          return (
            sub.tagName === "BUTTON" ||
            sub.getAttribute("role") === "button" ||
            v.cursor === "pointer" ||
            isVividBlueColor(v.compBg) ||
            isOrangeColor(v.compBg) ||
            isPaleBlueColor(v.compBg)
          );
        });
        const picked = innerCandidates[innerCandidates.length - 1];
        if (picked) {
          const pv = inspectElementVisualState(picked);
          const pVis = picked.parentElement ? inspectElementVisualState(picked.parentElement) : null;
          const cBtn = picked.closest('button, [role="button"]');
          const lockReasonSelf = isElementOrAncestorLocked(picked);
          rawMatches.push({
            el: picked,
            closestBtn: cBtn,
            isCircleShape: Math.abs(pv.rect.width - pv.rect.height) <= 22,
            rect: pv.rect,
            vis: pv,
            parentVis: pVis,
            effectiveCursor: pv.cursor,
            selfOrAncDisabled: Boolean(lockReasonSelf),
            lockReasonSelf,
            isOrangeCircle: isOrangeColor(pv.compBg) || isOrangeColor(pVis?.compBg),
            hasVividBar: isVividBlueColor(pv.compBg) || isVividBlueColor(pVis?.compBg) || isOrangeColor(pv.compBg),
            hasPaleBar: isPaleBlueColor(pv.compBg) || Boolean(pVis && isPaleBlueColor(pVis.compBg))
          });
        }
      });
    }

    // Deduplicate nested candidates: NEVER let an inner decorative child (e.g. pointer-events: none) mark an interactive parent <button> disabled!
    const deduped = [];
    for (const m of rawMatches) {
      const conflictIdx = deduped.findIndex((d) => d.el.contains(m.el) || m.el.contains(d.el));
      if (conflictIdx === -1) {
        deduped.push(m);
        continue;
      }
      const existing = deduped[conflictIdx];
      const mergedHasVivid = existing.hasVividBar || m.hasVividBar;
      const mergedHasPale = !mergedHasVivid && (existing.hasPaleBar || m.hasPaleBar);
      const mergedOrange = existing.isOrangeCircle || m.isOrangeCircle;

      const mIsBtn = m.el.tagName === "BUTTON" || m.el.getAttribute("role") === "button";
      const eIsBtn = existing.el.tagName === "BUTTON" || existing.el.getAttribute("role") === "button";
      const preferM =
        (!m.selfOrAncDisabled && existing.selfOrAncDisabled) ||
        (m.selfOrAncDisabled === existing.selfOrAncDisabled &&
          ((mIsBtn && !eIsBtn) ||
            (mIsBtn === eIsBtn && m.isCircleShape && !existing.isCircleShape) ||
            (mIsBtn === eIsBtn && m.isCircleShape === existing.isCircleShape && existing.el.contains(m.el))));

      const winner = preferM ? m : existing;
      winner.hasVividBar = mergedHasVivid;
      winner.hasPaleBar = mergedHasPale;
      winner.isOrangeCircle = mergedOrange;
      deduped[conflictIdx] = winner;
    }

    return deduped;
  }

  function scanMediaCards(playedMediaCardKeys = []) {
    let rawBtns = collectCircularPlayButtons();
    if (rawBtns.length === 0) {
      return {
        cards: [],
        playBtnSet: new Set(),
        cardElSet: new Set(),
        anyOrangePlaying: false
      };
    }

    // If >= 2 play controls live inside [id^="interaction-"] cards, drop stray icons outside them (header/corner buttons)
    const inInteractionCount = rawBtns.filter(
      (b) => b.el.closest && b.el.closest('[id^="interaction-"]')
    ).length;
    if (inInteractionCount >= 2) {
      rawBtns = rawBtns.filter((b) => b.el.closest && b.el.closest('[id^="interaction-"]'));
    }

    const playedSet = new Set(Array.isArray(playedMediaCardKeys) ? playedMediaCardKeys : []);
    const allBtnEls = rawBtns.map((b) => b.el);
    const playBtnSet = new Set(allBtnEls);

    const anyVividBar = rawBtns.some((b) => b.hasVividBar);
    const anyPointerBtn = rawBtns.some(
      (b) => !b.selfOrAncDisabled && b.effectiveCursor === "pointer"
    );

    const rawCards = [];
    const cardElSet = new Set();
    const headCount = new Map();

    rawBtns.forEach((b, idx) => {
      // Resolve enclosing card: prefer [id^="interaction-"] when it holds only this play button
      let cardEl = null;
      const interactionCard = b.el.closest ? b.el.closest('[id^="interaction-"]') : null;
      if (interactionCard && allBtnEls.filter((other) => interactionCard.contains(other)).length === 1) {
        cardEl = interactionCard;
      } else {
        cardEl = b.el.parentElement;
        let cur = b.el.parentElement;
        let depth = 0;
        while (cur && cur !== document.body && cur !== document.documentElement && depth < 10) {
          const containedCount = allBtnEls.filter((other) => cur.contains(other)).length;
          if (containedCount > 1) break;
          const r = cur.getBoundingClientRect();
          if (r.height > 680 || r.width > window.innerWidth * 0.92) break;
          if (r.height >= b.rect.height + 24) {
            cardEl = cur;
          }
          cur = cur.parentElement;
          depth++;
        }
      }

      const isPaleLocked = anyVividBar && !b.hasVividBar && b.hasPaleBar;
      const isCursorLocked =
        anyPointerBtn &&
        !b.hasVividBar &&
        (b.el.tagName === "BUTTON" || Boolean(b.closestBtn)) &&
        b.effectiveCursor !== "pointer";

      const lockReasons = [];
      if (b.lockReasonSelf) lockReasons.push(b.lockReasonSelf);
      if (isPaleLocked) lockReasons.push("paleBar");
      if (isCursorLocked) lockReasons.push(`cursor(${b.effectiveCursor})`);
      const locked = lockReasons.length > 0;

      const cardInnerText = (cardEl?.innerText || "").trim();
      const headLines = cardInnerText
        .split(/\r?\n/)
        .map((l) => normalizeText(l))
        .filter((l) => l && !MEDIA_CONTROL_REGEX.test(l) && !/^\d{1,2}:\d{2}$/.test(l))
        .slice(0, 2);
      const headText = headLines.join(" | ").slice(0, 70) || `card-${idx + 1}`;
      const occ = (headCount.get(headText) || 0) + 1;
      headCount.set(headText, occ);
      const key = occ > 1 ? `${headText}#${occ}` : headText;

      const label = headLines.join(" ").slice(0, 48) || `カード${idx + 1}`;
      const hasQuizSignals = Boolean(
        cardEl &&
        (cardEl.querySelector('input, select, textarea') ||
          /\bQ\s*\d+\b/i.test(headLines[0] || "") ||
          /\b0\d:\d{2}\b/.test(cardInnerText))
      );

      if (cardEl && cardEl !== document.body) {
        cardElSet.add(cardEl);
      }

      const aria = (b.el.getAttribute("aria-label") || b.el.getAttribute("title") || "").toLowerCase();
      const cls = `${typeof b.el.className === "string" ? b.el.className : ""} ${typeof b.el.parentElement?.className === "string" ? b.el.parentElement.className : ""
        }`;
      const playing = Boolean(
        b.isOrangeCircle ||
        /(pause|一時停止)/i.test(aria) ||
        /\b(playing|is-playing|pause)\b/i.test(cls)
      );

      const played = playedSet.has(key) || clickedMediaPlayBtns.has(b.el);

      rawCards.push({
        index: idx,
        el: b.el,
        cardEl,
        vis: b.vis,
        rect: b.rect,
        key,
        label,
        cardText: normalizeText(cardInnerText).slice(0, 180),
        locked,
        lockReason: lockReasons.join("+") || "",
        playing,
        played,
        hasQuizSignals
      });
    });

    const anyOrangePlaying = rawCards.some((c) => c.playing);
    return {
      cards: rawCards,
      playBtnSet,
      cardElSet,
      anyOrangePlaying
    };
  }

  function findPlayButtonForTarget(targetBlock) {
    const optsRect = targetBlock?.container
      ? targetBlock.container.getBoundingClientRect()
      : null;

    const otherCards = lastScanContext.allCardEls || [];
    const matches = collectCircularPlayButtons().filter((m) => {
      if (m.selfOrAncDisabled) return false;
      for (const c of otherCards) {
        if (c && c !== document.body && c !== targetBlock?.cardEl && c.contains(m.el)) {
          return false;
        }
      }
      return true;
    });

    if (matches.length === 0) return null;

    // 1. Prefer play button inside targetBlock.cardEl
    if (targetBlock?.cardEl && targetBlock.cardEl !== document.body) {
      const inCard = matches.find((m) => targetBlock.cardEl.contains(m.el));
      if (inCard) return inCard.el;
    }

    // 2. Prefer play button directly above targetBlock.container (within 240px above options)
    if (optsRect) {
      const above = matches
        .filter((m) => m.rect.top >= optsRect.top - 240 && m.rect.top <= optsRect.top + 30)
        .sort((a, b) => Math.abs(optsRect.top - a.rect.top) - Math.abs(optsRect.top - b.rect.top));
      if (above.length > 0) return above[0].el;
    }

    // 3. Fallback to single global play button (e.g. bottom audio player bar)
    return matches[0].el;
  }

  async function fetchAudioAsBase64(targetUrl) {
    let url = targetUrl;

    if (!url) {
      const beforePerf = new Set(getPerformanceAudioUrls());

      try {
        document.documentElement.setAttribute("data-elk-mute-probe", "1");
        document.documentElement.removeAttribute("data-elk-last-audio");
        document.documentElement.removeAttribute("data-elk-captured-wav");
      } catch (_) { }

      const playBtn = findPlayButtonForTarget(lastScanContext.targetBlock);
      if (playBtn) {
        // Check if button is already in orange Pause (⏸) state; if so, click once to reset to Play (▶) first
        const preVis = inspectElementVisualState(playBtn);
        if (isOrangeColor(preVis.compBg)) {
          simulateRealisticClick(playBtn);
          await new Promise((r) => setTimeout(r, 120));
        }

        // Click Play (▶ -> ⏸) to trigger Web Audio AudioBufferSourceNode.start() or HTMLMediaElement.play()
        simulateRealisticClick(playBtn);
        await new Promise((r) => setTimeout(r, 220));
        if (
          !document.documentElement.getAttribute("data-elk-last-audio") &&
          !document.documentElement.getAttribute("data-elk-captured-wav")
        ) {
          await new Promise((r) => setTimeout(r, 220));
        }

        // Click Pause (⏸ -> ▶) if button turned orange so we cleanly stop playback and restore blue ▶ icon!
        const postVis = inspectElementVisualState(playBtn);
        if (isOrangeColor(postVis.compBg)) {
          simulateRealisticClick(playBtn);
        }
      } else {
        for (const a of Array.from(document.querySelectorAll("audio"))) {
          try {
            a.muted = true;
            const p = a.play();
            if (p && typeof p.then === "function") {
              p.then(() => {
                try {
                  a.pause();
                } catch (_) { }
              }).catch(() => { });
            }
          } catch (_) { }
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      document.querySelectorAll("audio").forEach((a) => {
        try {
          a.pause();
        } catch (_) { }
      });

      let hookedUrl = null;
      let capturedWavBase64 = null;
      try {
        hookedUrl = document.documentElement.getAttribute("data-elk-last-audio");
        capturedWavBase64 = document.documentElement.getAttribute("data-elk-captured-wav");
        document.documentElement.removeAttribute("data-elk-mute-probe");
        document.documentElement.removeAttribute("data-elk-captured-wav");
      } catch (_) { }

      // If Web Audio API hook captured the exact AudioBuffer directly as a 16kHz WAV, return it immediately!
      if (capturedWavBase64 && capturedWavBase64.length > 200) {
        const approxBytes = Math.round((capturedWavBase64.length * 3) / 4);
        return {
          ok: true,
          url: `webaudio://${location.pathname}#${lastScanContext.targetBlock?.qId || "q0"}_${approxBytes}`,
          mimeType: "audio/wav",
          sizeBytes: approxBytes,
          base64: capturedWavBase64
        };
      }

      const afterPerf = getPerformanceAudioUrls();
      const newlyLoaded = afterPerf.find((u) => !beforePerf.has(u));
      if (hookedUrl) {
        url = hookedUrl;
      } else if (newlyLoaded) {
        url = newlyLoaded;
      } else {
        const info = extractAudioAndTranscriptContext(
          lastScanContext.targetBlock,
          lastScanContext.targetBlockIdx ?? -1,
          lastScanContext.totalBlocks ?? 0,
          lastScanContext.sharedContext || ""
        );
        url =
          info.activeAudioUrl ||
          (info.audioUrls.length === 1 ? info.audioUrls[0] : null);
      }
    }

    if (!url) {
      return { ok: false, error: "音声ファイルのURLを特定できませんでした" };
    }

    // Use cache: "no-store" + 4s timeout to avoid Chromium HTTP cache deadlock with active <audio> streams!
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

    const base64 = arrayBufferToBase64(buf);
    return {
      ok: true,
      url,
      mimeType,
      sizeBytes: buf.byteLength,
      base64
    };
  }

  // Reject inline blank pills embedded inside a prose paragraph (e.g., "It Q1 [might] ... You Q2 [might] ..." or "[選択...] ... [選択...]")
  function isInlineProseBlankGroup(container, chosenList) {
    if (!container || !chosenList || chosenList.length < 2) return false;

    const itemSet = new Set(chosenList.map((c) => c.el));
    const textsLower = chosenList.map((c) => normalizeText(c.text).toLowerCase());

    // 1. All placeholder pills like "選択...", "select...", "???"
    const placeholderRegex = /^(選択|選択してください|入力|入力してください|select|choose|enter|type|空欄|未選択|\?+|_{2,}|-{2,}|・+|\.{2,}|…+)$/i;
    if (textsLower.every((t) => placeholderRegex.test(t.replace(/[\s.…]+$/g, "")))) {
      return true;
    }

    // 2. Identical text on every candidate button (you cannot pick between ["might", "might"])
    if (new Set(textsLower).size <= 1) {
      return true;
    }

    // 3. Prose sentences interleaved strictly between the first and last candidate element inside container
    const firstEl = chosenList[0].el;
    const lastEl = chosenList[chosenList.length - 1].el;
    let state = "before";
    const betweenChunks = [];

    function walkBetween(node) {
      if (!node || state === "after") return;
      if (node === firstEl) {
        state = "between";
        return;
      }
      if (node === lastEl) {
        state = "after";
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && itemSet.has(node)) {
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        if (state === "between") {
          const v = (node.nodeValue || "").replace(/\s+/g, " ").trim();
          if (v) betweenChunks.push(v);
        }
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") return;
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) {
          return;
        }
        for (const child of node.childNodes) {
          walkBetween(child);
          if (state === "after") break;
        }
      }
    }

    walkBetween(container);
    const betweenText = betweenChunks
      .join(" ")
      .replace(/(?:^|\s)(?:Q\s*\d+|問\s*\d+|[A-Ha-h][.:)]|\d+[.:)])(?=\s|$)/gi, " ")
      .replace(/[|｜/・,.;:!?()[\]「」『』\-—\s]+/g, " ")
      .trim();

    if (betweenText.length >= 16) return true;
    const words = betweenText ? betweenText.split(/\s+/).filter((w) => w.length >= 2) : [];
    if (words.length >= 3) return true;

    return false;
  }

  function scanCourseLessons() {
    const startRegex =
      /^(スタート|開始|開始する|受講開始|続ける|続行|再開|再開する|start|continue|resume)$/i;
    const rawBtns = document.querySelectorAll(
      'button, a, [role="button"], [onclick], div, span'
    );
    const matchedBtns = [];
    for (const el of rawBtns) {
      if (isInsideHud(el) || el.closest("nav, header")) continue;
      const tag = el.tagName;
      if ((tag === "DIV" || tag === "SPAN") && el.getAttribute("role") !== "button" && !el.hasAttribute("onclick")) {
        if (el.querySelector('button, a, [role="button"]')) continue;
      }
      const txt = normalizeText(
        el.innerText || el.textContent || el.getAttribute("aria-label") || ""
      ).replace(/[＞>→»▶▷◀◁«←<＜!！\s]/g, "");
      if (!txt || txt.length > 24 || !startRegex.test(txt)) continue;
      const vis = inspectElementVisualState(el);
      if (!vis.visible || vis.inactive) continue;
      if (
        (tag === "DIV" || tag === "SPAN") &&
        el.getAttribute("role") !== "button" &&
        !el.hasAttribute("onclick") &&
        vis.cursor !== "pointer" &&
        vis.selfBgAlpha < 0.15 &&
        !vis.hasBgImage
      ) {
        continue;
      }
      if (matchedBtns.some((seen) => seen.contains(el) || el.contains(seen))) continue;
      matchedBtns.push(el);
    }

    const lessons = [];
    const keyCount = new Map();
    matchedBtns.forEach((btn, idx) => {
      let cardEl = btn.parentElement;
      let cur = btn.parentElement;
      let depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 10) {
        if (matchedBtns.filter((other) => cur.contains(other)).length > 1) break;
        const r = cur.getBoundingClientRect();
        if (r.height > 340 || r.width > window.innerWidth * 0.9) break;
        if ((cur.innerText || "").trim().length > (btn.innerText || "").trim().length) {
          cardEl = cur;
        }
        cur = cur.parentElement;
        depth++;
      }

      const rawLines = (cardEl?.innerText || "")
        .split(/\r?\n/)
        .map((l) => normalizeText(l))
        .filter(
          (l) =>
            l &&
            !/^(▶\s*)?(スタート|開始|開始する|受講開始|続ける|続行|再開|start|レッスンPDF|PDF)$/i.test(
              l
            )
        );
      const baseTitle = rawLines.slice(0, 3).join(" | ").slice(0, 90) || `lesson-${idx + 1}`;
      const occ = (keyCount.get(baseTitle) || 0) + 1;
      keyCount.set(baseTitle, occ);
      const key = occ > 1 ? `${baseTitle}#${occ}` : baseTitle;
      const label = (rawLines[1] || rawLines[0] || `レッスン${idx + 1}`).slice(0, 60);

      lessons.push({
        el: btn,
        cardEl,
        key,
        label,
        btnText: normalizeText(btn.innerText || btn.textContent || "スタート")
      });
    });

    const bodyTxt = normalizeText(document.body?.innerText || "").slice(0, 3500);
    let courseGoalDone = /進捗率\s*100%/i.test(bodyTxt);
    if (!courseGoalDone) {
      const ratioMatch = bodyTxt.match(/進捗率[\s\S]{0,40}?(\d+)\s*\/\s*(\d+)/i);
      if (ratioMatch && Number(ratioMatch[2]) > 0 && Number(ratioMatch[1]) >= Number(ratioMatch[2])) {
        courseGoalDone = true;
      }
    }

    return { lessons, courseGoalDone };
  }

  function scanLessonReturnButton() {
    const returnRegex =
      /^(コースへ戻る|コースに戻る|コース一覧へ?|一覧へ戻る|一覧に戻る|レッスンを終了|トレーニングを終了|完了|完了する|終了|終了する|閉じる|次へ進む|次へ|back\s*to\s*course|finish|done|close)$/i;
    const candidates = document.querySelectorAll('button, a, [role="button"], [onclick], div, span');
    let best = null;
    for (const el of candidates) {
      if (isInsideHud(el)) continue;
      const tag = el.tagName;
      if ((tag === "DIV" || tag === "SPAN") && el.getAttribute("role") !== "button" && !el.hasAttribute("onclick")) {
        if (el.querySelector('button, a, [role="button"]')) continue;
      }
      const text = normalizeText(
        el.innerText || el.textContent || el.getAttribute("aria-label") || ""
      );
      const href = tag === "A" ? el.getAttribute("href") || "" : "";
      const isCourseHref =
        /\/courses\/[^/?#]+/i.test(href) && !/\/lessons\//i.test(href) && !/pdf/i.test(text);
      const clean = text.replace(/[＞>→»▶▷◀◁«←<＜!！\s]/g, "");
      if (!isCourseHref && (!clean || clean.length > 30 || !returnRegex.test(clean))) continue;
      if (/^(やり直す|もう一回|ログアウト)/i.test(clean)) continue;
      const vis = inspectElementVisualState(el);
      if (!vis.visible || vis.inactive) continue;
      if (
        (tag === "DIV" || tag === "SPAN") &&
        el.getAttribute("role") !== "button" &&
        !el.hasAttribute("onclick") &&
        vis.cursor !== "pointer" &&
        vis.selfBgAlpha < 0.15 &&
        !vis.hasBgImage
      ) {
        continue;
      }
      best = { el, text: text || "コースへ戻る" };
      if (/コース|一覧|戻る|完了|閉じる/i.test(clean) || isCourseHref) break;
    }
    return best;
  }

  function extractPageState(
    answeredBlockKeys = [],
    includeFullDebug = false,
    playedMediaCardKeys = []
  ) {
    elementRegistry.clear();
    const sessionAnsweredSet = new Set(Array.isArray(answeredBlockKeys) ? answeredBlockKeys : []);
    const pagePath = location.pathname || "";
    const pageIsCourseDashboard =
      /\/courses\/[^/?#]+/i.test(pagePath) && !/\/lessons\//i.test(pagePath);
    const pageIsLessonPage = /\/lessons\//i.test(pagePath);
    const topBodySnippet = normalizeText(document.body?.innerText || "").slice(0, 3500);
    const modalResultSnippet = Array.from(
      document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="overlay" i]')
    )
      .filter((el) => !isInsideHud(el))
      .map((el) => normalizeText(el.innerText || el.textContent || "").slice(0, 240))
      .filter(Boolean)
      .join(" ");
    const resultScopeText = `${topBodySnippet.slice(0, 900)} ${modalResultSnippet}`;
    const pageIsResultReview =
      pageIsLessonPage &&
      /(テスト結果\s*[（(]\s*解答と解説\s*[）)]|今回のテスト結果|このレッスンを(?:満点で)?完了しました)/i.test(
        resultScopeText
      );
    const resultScoreMatch = resultScopeText.match(/今回のテスト結果[\s\S]{0,30}?(\d{1,3})\s*%/i);
    const passThreshMatch = resultScopeText.match(/(\d{1,3})\s*%\s*以上のスコアで合格/i);
    const passThresholdPct = passThreshMatch ? Number(passThreshMatch[1]) : 70;
    const resultScorePercent = resultScoreMatch ? Number(resultScoreMatch[1]) : null;
    let resultOutcome = null;
    if (pageIsResultReview) {
      if (
        /(このレッスンを(?:満点で)?完了しました|(?:^|[^不])合格しました|おめでとう|congratulations|passed)/i.test(
          resultScopeText
        ) ||
        (resultScorePercent !== null && resultScorePercent >= passThresholdPct)
      ) {
        resultOutcome = "pass";
      } else if (
        /(不合格|合格点に達|基準.{0,12}満た|failed|try again|再挑戦)/i.test(resultScopeText) ||
        (resultScorePercent !== null && resultScorePercent < passThresholdPct)
      ) {
        resultOutcome = "fail";
      } else {
        resultOutcome = "unknown";
      }
    }
    const pageIsRecordingTask =
      !pageIsCourseDashboard &&
      !pageIsResultReview &&
      RECORDING_TASK_REGEX.test(topBodySnippet);

    const mediaCardScan =
      pageIsCourseDashboard || pageIsResultReview
        ? { cards: [], playBtnSet: new Set(), cardElSet: new Set(), anyOrangePlaying: false }
        : scanMediaCards(playedMediaCardKeys);
    const rawGroups = [];
    const claimedElements = new Set(mediaCardScan.playBtnSet);

    // --- 1. Native <input type="radio"> & <input type="checkbox"> groups ---
    const nativeInputs = Array.from(
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    ).filter((el) => !isInsideHud(el));

    const radioBuckets = new Map();
    const ungroupedCheckboxes = [];

    for (const input of nativeInputs) {
      const info = resolveInputOptionInfo(input);
      if (!info.visible) continue;

      claimedElements.add(input);
      if (info.clickTarget) claimedElements.add(info.clickTarget);
      if (info.highlightTarget) claimedElements.add(info.highlightTarget);

      const item = {
        isNativeInput: true,
        choiceType: input.type === "checkbox" ? "checkbox" : "radio",
        inputEl: input,
        clickTarget: info.clickTarget,
        highlightTarget: info.highlightTarget,
        text: info.text.slice(0, 400),
        rawTextWithMarks: info.text,
        checked: Boolean(input.checked),
        checkedReason: input.checked ? "input.checked=true" : "",
        inactive: info.inactive,
        visual: info.visual
      };

      if (input.type === "radio" && input.name) {
        const formKey = input.form ? input.form : document.body;
        const bucketKey = `${input.name}__${formKey.id || formKey.tagName}`;
        if (!radioBuckets.has(bucketKey)) radioBuckets.set(bucketKey, []);
        radioBuckets.get(bucketKey).push(item);
      } else {
        ungroupedCheckboxes.push(item);
      }
    }

    for (const [, items] of radioBuckets.entries()) {
      const lca = findLowestCommonAncestor(items.map((i) => i.highlightTarget || i.inputEl));
      rawGroups.push({ container: lca, items });
    }

    if (ungroupedCheckboxes.length > 0) {
      const cbMap = new Map();
      for (const item of ungroupedCheckboxes) {
        const node = item.highlightTarget || item.inputEl;
        const immediateList =
          node.parentElement?.children.length === 1 && node.parentElement.parentElement
            ? node.parentElement.parentElement
            : node.parentElement;
        const groupAnc =
          node.closest('fieldset, ul, ol, tbody, [role="group"], [role="radiogroup"]') ||
          immediateList ||
          document.body;
        if (!cbMap.has(groupAnc)) cbMap.set(groupAnc, []);
        cbMap.get(groupAnc).push(item);
      }
      for (const [container, items] of cbMap.entries()) {
        rawGroups.push({ container, items });
      }
    }

    // --- 2. ARIA [role="radio"], [role="checkbox"], [role="option"] groups ---
    const ariaEls = Array.from(
      document.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')
    ).filter((el) => !claimedElements.has(el) && !el.closest("select") && !isInsideHud(el));

    const ariaMap = new Map();
    for (const el of ariaEls) {
      if (el.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
      const vis = inspectElementVisualState(el);
      if (!vis.visible) continue;
      const text = normalizeText(el.innerText || el.textContent || el.getAttribute("aria-label"));
      if (!text) continue;

      claimedElements.add(el);
      const role = el.getAttribute("role");
      const cls = typeof el.className === "string" ? el.className : "";
      const checked =
        el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("aria-selected") === "true" ||
        /\b(selected|is-selected)\b/i.test(cls);

      const container =
        el.closest('[role="radiogroup"], [role="listbox"], [role="group"]') ||
        (el.parentElement?.children.length === 1
          ? el.parentElement.parentElement
          : el.parentElement) ||
        document.body;

      if (!ariaMap.has(container)) ariaMap.set(container, []);
      ariaMap.get(container).push({
        isNativeInput: false,
        choiceType: role === "checkbox" ? "checkbox" : "radio",
        inputEl: null,
        clickTarget: el,
        highlightTarget: el,
        text: text.slice(0, 400),
        rawTextWithMarks: el.innerText || text,
        checked,
        checkedReason: checked ? "aria_or_selected_class" : "",
        inactive: vis.inactive,
        visual: vis
      });
    }

    for (const [container, items] of ariaMap.entries()) {
      if (items.length >= 2) {
        rawGroups.push({ container, items });
      }
    }

    // --- 3. Button / Card / List-item Choice Groups ---
    if (!pageIsCourseDashboard && rawGroups.length === 0) {
      const candidateSelector =
        'button, [role="button"], li, a, label, [data-choice], [data-option], [data-answer], div';
      const allNodes = document.querySelectorAll(candidateSelector);
      const containerBuckets = new Map();

      for (const el of allNodes) {
        if (claimedElements.has(el) || isInsideHud(el)) continue;
        const tag = el.tagName;
        if (el.closest("nav, header, footer")) continue;
        if (
          tag !== "BUTTON" &&
          tag !== "LABEL" &&
          (mediaCardScan.cardElSet.has(el) ||
            Array.from(mediaCardScan.playBtnSet).some((pb) => el.contains(pb)))
        ) {
          continue;
        }

        if (tag === "DIV") {
          const parent = el.parentElement;
          if (!parent) continue;
          const sibCount = parent.children.length;
          const cls = typeof el.className === "string" ? el.className : "";
          const hasChoiceHint =
            /(choice|option|answer|select|quiz|candidate|item|card|btn)/i.test(cls) ||
            el.hasAttribute("onclick");
          if (!hasChoiceHint && (sibCount < 2 || sibCount > 28)) continue;
          if (el.querySelectorAll("button").length >= 2) continue;
        }

        if (tag !== "BUTTON" && el.querySelectorAll("button").length === 1) {
          continue;
        }

        const rawText = el.innerText || el.textContent || "";
        const text = normalizeText(rawText);
        if (!text || text.length > 320) continue;

        const btnKind = classifyButtonText(text);
        if (btnKind === "submit" || btnKind === "next" || btnKind === "avoid" || btnKind === "skip") {
          continue;
        }

        const vis = inspectElementVisualState(el);
        if (!vis.visible) continue;
        if (vis.rect.width < 20 || vis.rect.height < 18) continue;

        let groupContainer = el.parentElement;
        if (
          groupContainer &&
          groupContainer.children.length === 1 &&
          groupContainer.tagName !== "P" &&
          !Array.from(groupContainer.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue || "").trim().length > 8
          ) &&
          groupContainer.parentElement &&
          groupContainer.parentElement !== document.body
        ) {
          groupContainer = groupContainer.parentElement;
        }
        if (!groupContainer) continue;

        if (tag === "DIV") {
          const childDivsWithText = Array.from(el.children).filter(
            (c) => normalizeText(c.innerText || c.textContent).length > 0
          );
          if (childDivsWithText.length >= 3) continue;
        }

        if (!containerBuckets.has(groupContainer)) {
          containerBuckets.set(groupContainer, new Map());
        }
        const byTag = containerBuckets.get(groupContainer);
        if (!byTag.has(tag)) byTag.set(tag, []);
        const listForTag = byTag.get(tag);

        // Prevent parent+child duplicate entries inside the same container bucket
        const ancestorIdx = listForTag.findIndex((item) => item.el.contains(el));
        if (ancestorIdx !== -1) {
          if (listForTag[ancestorIdx].vis.selfBgAlpha < 0.05 && vis.selfBgAlpha >= 0.05) {
            listForTag[ancestorIdx] = { el, text, rawText, vis };
          }
          continue;
        }
        listForTag.push({ el, text, rawText, vis });
      }

      for (const [container, byTag] of containerBuckets.entries()) {
        const tagOrder = ["BUTTON", "LABEL", "LI", "A", "DIV"];
        let chosenList = null;
        for (const t of tagOrder) {
          const list = byTag.get(t);
          if (list && list.length >= 2 && list.length <= 28) {
            chosenList = list;
            break;
          }
        }
        if (!chosenList) continue;
        if (isInlineProseBlankGroup(container, chosenList)) continue;

        const isInsideNonQuizMediaCard =
          chosenList[0].el.tagName === "DIV" &&
          mediaCardScan.cards.some(
            (mc) => !mc.hasQuizSignals && mc.cardEl && mc.cardEl.contains(container)
          ) &&
          !chosenList.some(
            (c) =>
              c.el.getAttribute("role") === "button" ||
              c.el.hasAttribute("onclick") ||
              c.vis.cursor === "pointer" ||
              c.vis.isGradedGreen ||
              c.vis.isGradedRed
          );
        if (isInsideNonQuizMediaCard) continue;

        const widths = chosenList.map((c) => c.vis.rect.width);
        const maxW = Math.max(...widths);
        const minW = Math.min(...widths);
        if (maxW > minW * 6 && chosenList[0].el.tagName === "DIV") continue;
        const uniformWideBars = minW >= 120 && maxW <= minW * 1.25;

        const containerCls =
          (typeof container.className === "string" ? container.className : "") +
          " " +
          (typeof chosenList[0].el.className === "string" ? chosenList[0].el.className : "");
        const hasInteractiveSignal =
          chosenList[0].el.tagName === "BUTTON" ||
          chosenList[0].el.getAttribute("role") === "button" ||
          chosenList.some(
            (c) =>
              c.vis.cursor === "pointer" ||
              c.vis.isGradedGreen ||
              c.vis.isGradedRed ||
              c.el.disabled === true ||
              (uniformWideBars &&
                (c.el.tagName !== "DIV" ||
                  (c.vis.selfBgAlpha >= 0.08 &&
                    (c.vis.compBg.r < 248 || c.vis.compBg.g < 248 || c.vis.compBg.b < 248))) &&
                (c.vis.dimmed || c.vis.pointerNone || c.vis.lowContrastGray))
          ) ||
          /(choice|option|answer|quiz|question|select)/i.test(containerCls);

        if (!hasInteractiveSignal) continue;

        const items = chosenList.map((c) => {
          claimedElements.add(c.el);
          const cls = typeof c.el.className === "string" ? c.el.className : "";
          const selected =
            c.el.getAttribute("aria-pressed") === "true" ||
            c.el.getAttribute("aria-selected") === "true" ||
            /\b(selected|is-selected|active|is-active|current)\b/i.test(cls);
          return {
            isNativeInput: false,
            choiceType: "button-choice",
            inputEl: null,
            clickTarget: c.el,
            highlightTarget: c.el,
            text: c.text.slice(0, 400),
            rawTextWithMarks: c.rawText,
            checked: selected,
            checkedReason: selected ? "aria_or_class_selected" : "",
            inactive: c.vis.inactive,
            visual: c.vis
          };
        });

        rawGroups.push({ container, items });
      }
    }

    const filteredGroups = rawGroups.filter(
      (g, i) =>
        !rawGroups.some(
          (other, j) =>
            i !== j && g.container !== other.container && g.container.contains(other.container)
        )
    );

    filteredGroups.sort((a, b) => {
      const ra = a.container.getBoundingClientRect();
      const rb = b.container.getBoundingClientRect();
      return ra.top - rb.top;
    });

    const allContainers = filteredGroups.map((g) => g.container);
    const anyPointerGroupExists = filteredGroups.some(
      (g) =>
        !g.items[0]?.isNativeInput &&
        g.items.filter((it) => !it.inactive && it.visual?.cursor === "pointer").length >= 2
    );

    const preButtonsForGroupStatus = pageIsCourseDashboard
      ? []
      : scanActionButtons(claimedElements, null, null, pageIsRecordingTask);
    const pageHasNextOnlyNav =
      preButtonsForGroupStatus.some((b) => b.kind === "next") &&
      !preButtonsForGroupStatus.some((b) => b.kind === "submit");

    const questionBlocks = [];
    const allCardEls = new Set();

    filteredGroups.forEach((g, gIdx) => {
      const optNodes = g.items.map((it) => it.highlightTarget || it.clickTarget);
      const { cardEl, labelEls, questionText } = resolveQuestionCardAndText(
        g.container,
        allContainers,
        optNodes
      );
      if (cardEl && cardEl !== document.body) {
        allCardEls.add(cardEl);
      }
      if (filteredGroups.length >= 2 && Array.isArray(labelEls)) {
        for (const le of labelEls) {
          allCardEls.add(le);
        }
      }

      const blockKey = [
        questionText.slice(0, 500),
        ...g.items.map((it) => it.text)
      ].join("::");

      const nextGroupContainer =
        gIdx + 1 < filteredGroups.length ? filteredGroups[gIdx + 1].container : null;

      const { status: groupStatus, reason: statusReason } = classifyQuestionGroup(
        g.items,
        g.container,
        cardEl,
        nextGroupContainer,
        filteredGroups.length,
        anyPointerGroupExists,
        sessionAnsweredSet,
        blockKey,
        pageHasNextOnlyNav
      );

      questionBlocks.push({
        qId: `q-${gIdx}`,
        blockKey,
        status: groupStatus,
        statusReason,
        questionText,
        cardEl,
        container: g.container,
        rawItems: g.items
      });
    });

    const activeBlocks = questionBlocks.filter((b) => b.status === "active");
    const answeredBlocksCount = questionBlocks.filter((b) => b.status === "answered").length;
    const lockedBlocksCount = questionBlocks.filter((b) => b.status === "locked").length;

    const targetBlock = activeBlocks[0] || null;
    const targetBlockIdx = targetBlock ? questionBlocks.indexOf(targetBlock) : -1;
    const nextBlockBelow =
      targetBlockIdx >= 0 && targetBlockIdx + 1 < questionBlocks.length
        ? questionBlocks[targetBlockIdx + 1]
        : null;

    lastScanContext = {
      claimedElements,
      targetBlock,
      targetBlockIdx,
      totalBlocks: questionBlocks.length,
      nextBlockBelow,
      scrollPane: null
    };

    const options = [];
    let optIndex = 0;

    let isTileBlock = false;
    let tilePartialUsedCount = 0;
    let hasTileBackspace = false;

    if (targetBlock) {
      isTileBlock =
        targetBlock.rawItems.length >= 3 &&
        targetBlock.rawItems.every((it) => (it.text || "").length <= 2);

      // For letter-tile questions, if some tiles were already clicked in an incomplete attempt,
      // still expose all tiles of the anagram so the AI sees the complete letter pool!
      for (const item of targetBlock.rawItems) {
        if (item.inactive && !isTileBlock) continue;
        const id = `opt-${optIndex++}`;
        elementRegistry.set(id, {
          kind:
            item.choiceType === "checkbox"
              ? item.isNativeInput
                ? "checkbox"
                : "aria-checkbox"
              : item.isNativeInput
                ? "radio"
                : "choice-button",
          isTile: isTileBlock,
          text: item.text,
          container: targetBlock.container,
          alreadySelected: isTileBlock ? false : Boolean(item.checked),
          inputEl: item.inputEl,
          clickTarget: item.clickTarget,
          highlightTarget: item.highlightTarget
        });

        options.push({
          id,
          type: isTileBlock ? "tile-order" : item.choiceType,
          text: item.text,
          checked: isTileBlock ? false : item.checked,
          disabled: isTileBlock ? Boolean(item.inactive) : false
        });
      }

      if (isTileBlock) {
        tilePartialUsedCount = targetBlock.rawItems.filter((it) => it.inactive).length;
        if (tilePartialUsedCount > 0) {
          const scope =
            targetBlock.cardEl && targetBlock.cardEl !== document.body
              ? targetBlock.cardEl
              : targetBlock.container;
          const tileElSet = new Set(
            targetBlock.rawItems.map((it) => it.clickTarget).filter(Boolean)
          );
          hasTileBackspace = Boolean(findTileBackspaceButton(scope, tileElSet));
        }
      }
    }

    // --- 4. <select> dropdowns (excluding media playback speed selectors!) ---
    const selects = [];
    const selectIdMap = new Map();
    let selIndex = 0;
    const selectEls = Array.from(document.querySelectorAll("select"));
    for (const sel of selectEls) {
      const vis = inspectElementVisualState(sel);
      if (!vis.visible || vis.inactive || hasGradedElementVisual(sel)) continue;
      const optList = Array.from(sel.options)
        .filter((o) => !o.disabled && normalizeText(o.text) !== "")
        .map((o) => ({
          value: o.value,
          text: normalizeText(o.text).slice(0, 200),
          selected: o.selected
        }));
      if (optList.length < 2) continue;
      if (optList.every((o) => MEDIA_CONTROL_REGEX.test(o.text))) continue;

      const selectedOptText = normalizeText(
        sel.options?.[sel.selectedIndex]?.text || optList.find((o) => o.selected)?.text || ""
      );
      const hasSelection = Boolean(
        sel.value &&
        !/^(-+|—+|–+|選択.*|選んで.*|select.*|choose.*)$/i.test(selectedOptText)
      );

      const id = `sel-${selIndex++}`;
      selectIdMap.set(sel, id);
      elementRegistry.set(id, {
        kind: "select",
        clickTarget: sel,
        highlightTarget: sel
      });

      selects.push({
        id,
        currentValue: sel.value,
        hasSelection,
        choices: optList
      });
    }

    const findPrecedingQLabel = (targetEl) => {
      let sib = targetEl?.previousElementSibling;
      for (let steps = 0; sib && steps < 2; steps++, sib = sib.previousElementSibling) {
        const t = normalizeText(sib.innerText || sib.textContent || "");
        const m = t.match(/^(?:Q|問)\s*(\d{1,2})$/i);
        if (m) return `Q${m[1]}`;
      }
      const p = targetEl?.parentElement;
      if (p && p !== document.body && p.children.length <= 3) {
        let ps = p.previousElementSibling;
        for (let steps = 0; ps && steps < 2; steps++, ps = ps.previousElementSibling) {
          const t = normalizeText(ps.innerText || ps.textContent || "");
          const m = t.match(/^(?:Q|問)\s*(\d{1,2})$/i);
          if (m) return `Q${m[1]}`;
        }
      }
      return "";
    };

    const inlineBlankIdMap = new Map(selectIdMap);

    // --- 4b. Text <input>, <textarea>, and [contenteditable] fields ---
    const textInputs = [];
    const textInputElsList = [];
    let txtIndex = 0;
    const rawTextInputEls = Array.from(
      document.querySelectorAll(
        'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]):not([type="range"]):not([type="color"]), textarea, [contenteditable="true"], [contenteditable=""]'
      )
    );
    for (const inp of rawTextInputEls) {
      if (isInsideHud(inp) || claimedElements.has(inp)) continue;
      if (inp.closest("nav, header")) continue;
      if (inp.disabled || inp.readOnly || inp.getAttribute("aria-disabled") === "true") continue;
      const vis = inspectElementVisualState(inp);
      if (!vis.visible || vis.pointerNone || vis.dimmed || vis.cursor === "not-allowed") continue;
      if (hasGradedElementVisual(inp)) continue;

      const placeholder = normalizeText(
        inp.getAttribute("placeholder") || inp.getAttribute("aria-label") || ""
      );
      const qLabel = findPrecedingQLabel(inp);
      if (
        inp.tagName === "INPUT" &&
        (inp.type || "").toLowerCase() === "search" &&
        !qLabel &&
        !/入力|答|answer|word|blank|空欄/i.test(placeholder)
      ) {
        continue;
      }

      const isCE = Boolean(inp.isContentEditable || inp.hasAttribute("contenteditable"));
      const currentValue = isCE
        ? normalizeText(inp.innerText || inp.textContent || "")
        : String(inp.value || "").trim();

      const id = `txt-${txtIndex++}`;
      claimedElements.add(inp);
      inlineBlankIdMap.set(inp, currentValue ? `${id}(現在:"${currentValue.slice(0, 30)}")` : id);
      elementRegistry.set(id, {
        kind: isCE ? "contenteditable" : "text-input",
        clickTarget: inp,
        highlightTarget: inp,
        qLabel
      });
      textInputElsList.push(inp);
      textInputs.push({
        id,
        qLabel: qLabel || undefined,
        placeholder: placeholder || undefined,
        currentValue,
        maxLength:
          typeof inp.maxLength === "number" && inp.maxLength > 0 && inp.maxLength < 200
            ? inp.maxLength
            : undefined
      });
    }

    // --- 4c. Clickable inline "入力..." pills (when input box opens on click) ---
    const inlineInputPills = [];
    const emptyTextInputCount = textInputs.filter((t) => !t.currentValue).length;
    if (
      questionBlocks.length === 0 &&
      selects.length === 0 &&
      emptyTextInputCount === 0
    ) {
      const pillCandidates = Array.from(
        document.querySelectorAll('button, [role="button"], span, div')
      ).filter((el) => {
        if (isInsideHud(el) || claimedElements.has(el)) return false;
        if (el.closest("nav, header, footer")) return false;
        if (el.querySelector("input, textarea, button, select")) return false;
        const txt = normalizeText(el.innerText || el.textContent || "");
        if (!/^入力(?:\s*(?:\.{1,3}|…)+)?$/i.test(txt)) return false;
        const vis = inspectElementVisualState(el);
        return vis.visible && !vis.inactive && vis.rect.width >= 24 && vis.rect.height >= 16;
      });
      const dedupedPills = [];
      for (const el of pillCandidates) {
        if (dedupedPills.some((d) => d.contains(el) || el.contains(d))) continue;
        dedupedPills.push(el);
      }
      dedupedPills.forEach((el, idx) => {
        const id = `pill-${idx}`;
        const qLabel = findPrecedingQLabel(el);
        claimedElements.add(el);
        inlineBlankIdMap.set(el, `入力待ち:${id}`);
        elementRegistry.set(id, {
          kind: "inline-input-pill",
          clickTarget: el,
          highlightTarget: el,
          qLabel
        });
        inlineInputPills.push({
          id,
          qLabel: qLabel || undefined,
          label: qLabel ? `${qLabel} 入力...` : normalizeText(el.innerText || "入力...")
        });
      });
    }

    lastScanContext.hasUnfilledSelectsOrPills = Boolean(
      selects.some((s) => !s.hasSelection) || inlineInputPills.length > 0
    );
    lastScanContext.textInputEls = textInputElsList;

    const extractSnippetAroundBlank = (targetEl, blankId) => {
      const para = targetEl?.closest("p, li, td, div");
      if (!para || para === document.body) return undefined;
      const full = extractCleanTextExcluding(para, new Set(), inlineBlankIdMap);
      if (full.length <= 360) return full;
      const markerIdx = full.indexOf(`[空欄:${blankId}`);
      if (markerIdx === -1) return full.slice(0, 360);
      const start = Math.max(0, markerIdx - 170);
      const end = Math.min(full.length, markerIdx + 190);
      return full.slice(start, end);
    };

    // Attach local paragraph context for each <select> dropdown & text input
    for (const sObj of selects) {
      const entry = elementRegistry.get(sObj.id);
      const snippet = extractSnippetAroundBlank(entry?.clickTarget, sObj.id);
      if (snippet) sObj.contextSnippet = snippet;
    }
    for (const tObj of textInputs) {
      const entry = elementRegistry.get(tObj.id);
      const snippet = extractSnippetAroundBlank(entry?.clickTarget, tObj.id);
      if (snippet) tObj.contextSnippet = snippet;
    }

    // --- 5. Action / Navigation Buttons ---
    const inactiveButtons = [];
    const scannedButtons = scanActionButtons(
      claimedElements,
      targetBlock,
      nextBlockBelow,
      pageIsRecordingTask,
      inactiveButtons
    );
    const buttons = [];
    let btnIndex = 0;

    for (const b of scannedButtons) {
      const id = `btn-${btnIndex++}`;
      elementRegistry.set(id, {
        kind: "button",
        buttonCategory: b.kind,
        insideActiveCard: b.insideActiveCard,
        belongsToActiveQuestion: b.belongsToActiveQuestion,
        clickTarget: b.el,
        highlightTarget: b.el
      });

      buttons.push({
        id,
        text: b.text,
        kind: b.kind,
        tag: b.tagDesc,
        belongsToActiveQuestion: b.belongsToActiveQuestion
      });
    }

    // --- 6. Question Text + Shared Passage Context ---
    let sharedContext = "";
    if (document.body && allCardEls.size > 0) {
      sharedContext = extractCleanTextExcluding(document.body, allCardEls, inlineBlankIdMap).slice(
        0,
        6500
      );
    }

    let focusedQuestionText = "";
    if (targetBlock) {
      focusedQuestionText = targetBlock.questionText;
      if (!focusedQuestionText && sharedContext) {
        focusedQuestionText = sharedContext;
      }
    } else if (document.body) {
      focusedQuestionText = extractCleanTextExcluding(document.body, new Set(), inlineBlankIdMap).slice(
        0,
        5500
      );
    }

    // Inline cloze passage helper: if the shared passage contains numbered blanks (Q1, Q2, ..., Q10)
    // and targetBlock doesn't already include the sentence around its Q#, pinpoint the exact active Q# sentence!
    if (targetBlock && sharedContext && /\bQ\s*1\b/i.test(sharedContext) && /\bQ\s*2\b/i.test(sharedContext)) {
      let activeQNum = null;
      const ownQMatch = (targetBlock.questionText || "").match(/(?:^|\n|\s)Q\s*(\d+)\b/i);
      if (ownQMatch) {
        activeQNum = Number(ownQMatch[1]);
      } else if (questionBlocks.length >= 2 && targetBlockIdx >= 0) {
        activeQNum = targetBlockIdx + 1;
      } else {
        // Single choice bar controlling inline Q1..Q10 badges inside the passage: detect which badge is highlighted or first unfilled!
        const badgeEls = Array.from(document.querySelectorAll("span, div, button")).filter((el) => {
          if (isInsideHud(el) || targetBlock.container?.contains(el)) return false;
          if (el.children.length > 0) return false;
          return /^Q\s*\d{1,2}$/i.test(normalizeText(el.textContent || ""));
        });
        const badgeInfos = badgeEls.map((el) => {
          const num = Number((el.textContent || "").replace(/\D+/g, ""));
          const vis = inspectElementVisualState(el);
          const parentVis = el.parentElement ? inspectElementVisualState(el.parentElement) : null;
          const cls = `${el.className || ""} ${el.parentElement?.className || ""}`;
          const isBlue =
            (vis.compBg && vis.compBg.b > 170 && vis.compBg.b - vis.compBg.r > 65) ||
            (parentVis?.compBg && parentVis.compBg.b > 170 && parentVis.compBg.b - parentVis.compBg.r > 65);
          const isActiveCls =
            /\b(active|current|selected|focus)\b/i.test(cls) ||
            el.getAttribute("aria-current") === "true" ||
            el.getAttribute("aria-selected") === "true";
          const nextText = normalizeText(el.nextElementSibling?.textContent || "");
          const isEmptySlot = !nextText || /^[_?\-\s・]+$/.test(nextText);
          return { num, isBlue, isActiveCls, isEmptySlot };
        });
        const highlighted = badgeInfos.find((b) => b.isActiveCls || b.isBlue);
        const firstEmpty = badgeInfos.find((b) => b.isEmptySlot);
        if (highlighted) activeQNum = highlighted.num;
        else if (firstEmpty) activeQNum = firstEmpty.num;
      }

      if (activeQNum !== null && activeQNum > 0) {
        // Find ALL occurrences of Q# in sharedContext and pick the one actually embedded inside prose text!
        const qMarkerGlobalRegex = new RegExp(`\\bQ\\s*${activeQNum}\\b`, "gi");
        let bestMatch = null;
        let bestScore = -1;
        let matchObj;
        while ((matchObj = qMarkerGlobalRegex.exec(sharedContext)) !== null) {
          const beforeCtx = sharedContext.slice(Math.max(0, matchObj.index - 45), matchObj.index);
          const afterCtx = sharedContext.slice(
            matchObj.index + matchObj[0].length,
            matchObj.index + matchObj[0].length + 45
          );
          const beforeClean = beforeCtx.replace(/\bQ\s*\d+\b/gi, "").replace(/[^a-zA-Zぁ-んァ-ン一-龥]+/g, "");
          const afterClean = afterCtx
            .replace(/\bQ\s*\d+\b|選択|select|choose/gi, "")
            .replace(/[^a-zA-Zぁ-んァ-ン一-龥]+/g, "");
          let score = Math.min(20, beforeClean.length) + Math.min(20, afterClean.length);
          if (beforeClean.length >= 3 && afterClean.length >= 3) score += 50;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { index: matchObj.index, len: matchObj[0].length };
          }
        }

        if (bestMatch) {
          // Determine sentence-aware bounds around bestMatch so adjacent blanks in neighboring sentences don't steal focus
          const rawStart = Math.max(0, bestMatch.index - 170);
          let rawEnd = Math.min(sharedContext.length, bestMatch.index + bestMatch.len + 160);

          let beforeSlice = sharedContext.slice(rawStart, bestMatch.index);
          // Snap backward to a paragraph or sentence start if at least 40 chars of leading context remain
          const nlIdx = beforeSlice.lastIndexOf("\n");
          if (nlIdx !== -1 && beforeSlice.length - nlIdx >= 25) {
            beforeSlice = beforeSlice.slice(nlIdx + 1);
          }

          let afterSlice = sharedContext.slice(bestMatch.index + bestMatch.len, rawEnd);
          // Trim trailing placeholder ("選択..." / "select...") immediately following the Q# badge
          afterSlice = afterSlice.replace(
            /^\s*(?:選択してください|選択|select|choose)(?:\s*(?:\.{1,3}|…)+|\b)/i,
            ""
          );
          // Trim at newline or stop right after the end of the target sentence if another Q# appears later
          const afterNl = afterSlice.indexOf("\n");
          if (afterNl >= 12) {
            afterSlice = afterSlice.slice(0, afterNl);
          }
          const nextQMatch = afterSlice.match(/(?:^|[^.])[.!?。](?:\s+|$)[\s\S]*?\bQ\s*\d+\b/);
          if (nextQMatch) {
            const endAtSentence = afterSlice.search(/(?<=[^.])[.!?。](?:\s|$)/);
            if (endAtSentence >= 6) {
              afterSlice = afterSlice.slice(0, endAtSentence + 1);
            }
          }

          // Label any OTHER Q# markers inside beforeSlice/afterSlice so AI never confuses them with the active blank
          const maskOtherQ = (str) =>
            str
              .replace(/\bQ\s*(\d+)\b(?:\s*(?:選択|select|choose)(?:\.{1,3}|…)*)?/gi, (_, num) => `(別の空欄Q${num})`);

          const focusedSentence = `${maskOtherQ(beforeSlice)} 【★空欄 Q${activeQNum}★(_____)】 ${maskOtherQ(
            afterSlice
          )}`
            .replace(/\s+/g, " ")
            .trim();

          focusedQuestionText = `【現在の解答対象: 本文中の空欄 Q${activeQNum}（全${Math.max(
            questionBlocks.length,
            activeQNum
          )}問中のQ${activeQNum}）】\n対象文（この★空欄 Q${activeQNum}★だけを見て解答すること）:\n${focusedSentence}\n\n元見出し: ${focusedQuestionText}`.trim();
        }
      }
    }

    const hasQuizKeywords = /(問題|設問|問\s*\d|Q\s*\d|選択|入力|空所補充|当てはまる|正しい|誤っている|適切|すべて選|次へ|解答|採点|テスト)/i.test(
      `${focusedQuestionText}\n${sharedContext}`
    );

    const questionBaseKey = targetBlock
      ? targetBlock.blockKey
      : selects.length > 0
        ? [
          focusedQuestionText.slice(0, 500),
          ...selects.map((s) => s.choices.map((c) => c.text).join("|"))
        ].join("::")
        : textInputs.length > 0
          ? [
            focusedQuestionText.slice(0, 500),
            ...textInputs.map((t) => `${t.id}:${t.qLabel || ""}`)
          ].join("::")
          : "";

    const fullHeaderAndBody = `${focusedQuestionText}\n${sharedContext}`;
    const isRecordingTask =
      !pageIsCourseDashboard &&
      (pageIsRecordingTask || RECORDING_TASK_REGEX.test(fullHeaderAndBody));
    const hasFlashcardCue = /(単語カード|重要表現|flashcard|vocabulary|発音を確認|音声を確認)/i.test(
      fullHeaderAndBody
    );
    const hasNoQuizControls =
      !pageIsCourseDashboard &&
      !isRecordingTask &&
      questionBlocks.length === 0 &&
      selects.length === 0 &&
      textInputs.length === 0 &&
      inlineInputPills.length === 0;
    const eligibleMediaCards = hasNoQuizControls
      ? mediaCardScan.cards.filter((c) => hasFlashcardCue || !c.hasQuizSignals)
      : [];

    const mediaCardsList = eligibleMediaCards.map((c, mIdx) => {
      const id = `mc-${mIdx}`;
      if (!c.locked) {
        elementRegistry.set(id, {
          kind: "media-card",
          key: c.key,
          label: c.label,
          cardEl: c.cardEl,
          clickTarget: c.el,
          highlightTarget: c.cardEl || c.el
        });
      }
      return {
        id,
        key: c.key,
        label: c.label,
        locked: c.locked,
        lockReason: c.lockReason || undefined,
        playing: c.playing,
        played: c.played
      };
    });

    const mediaCardsSummary = {
      cards: mediaCardsList,
      totalCount: mediaCardsList.length,
      activeCount: mediaCardsList.filter((c) => !c.locked).length,
      lockedCount: mediaCardsList.filter((c) => c.locked).length,
      playingCount: mediaCardsList.filter((c) => c.playing).length,
      unplayedActiveCount: mediaCardsList.filter((c) => !c.locked && !c.played && !c.playing).length,
      isAudioPlaying:
        mediaCardsList.length > 0 &&
        (mediaCardsList.some((c) => c.playing) || isAnyHtmlAudioPlaying())
    };

    // Course dashboard & lesson completion return detection
    const courseScan = pageIsCourseDashboard
      ? scanCourseLessons()
      : { lessons: [], courseGoalDone: false };
    const courseLessons = courseScan.lessons.map((l, cIdx) => {
      const id = `crs-${cIdx}`;
      elementRegistry.set(id, {
        kind: "course-start",
        key: l.key,
        label: l.label,
        btnText: l.btnText,
        clickTarget: l.el,
        highlightTarget: l.cardEl || l.el
      });
      return {
        id,
        key: l.key,
        label: l.label,
        btnText: l.btnText
      };
    });
    const courseGoalDone = Boolean(courseScan.courseGoalDone);

    const activeBlockCountForReturn = questionBlocks.filter((b) => b.status === "active").length;
    const lockedBlockCountForReturn = questionBlocks.filter((b) => b.status === "locked").length;
    const pageBodySampleForReturn = normalizeText(document.body?.innerText || "").slice(0, 3500);
    const hasCompletionCue =
      /(レッスン完了|レッスン終了|トレーニング完了|テスト完了|学習完了|テスト結果|学習結果|正答率\s*[:：]?\s*\d|スコア\s*[:：]?\s*\d|congratulations|lesson\s*complet)/i.test(
        `${fullHeaderAndBody}\n${pageBodySampleForReturn}`
      );
    let courseReturnBtn = null;
    if (
      pageIsLessonPage &&
      !isRecordingTask &&
      activeBlockCountForReturn === 0 &&
      lockedBlockCountForReturn === 0 &&
      selects.length === 0 &&
      textInputs.length === 0 &&
      inlineInputPills.length === 0 &&
      mediaCardsSummary.unplayedActiveCount === 0 &&
      mediaCardsSummary.lockedCount === 0 &&
      hasCompletionCue
    ) {
      const ret = scanLessonReturnButton();
      if (ret && ret.el) {
        elementRegistry.set("ret-0", {
          kind: "course-return",
          text: ret.text,
          clickTarget: ret.el,
          highlightTarget: ret.el
        });
        courseReturnBtn = { id: "ret-0", text: ret.text };
      }
    }

    // Inner scrollable pane detection
    let scrollPane = null;
    const refEl =
      questionBlocks[questionBlocks.length - 1]?.container ||
      targetBlock?.container ||
      textInputElsList[textInputElsList.length - 1] ||
      eligibleMediaCards[eligibleMediaCards.length - 1]?.cardEl ||
      courseScan.lessons[courseScan.lessons.length - 1]?.cardEl ||
      null;
    if (refEl) {
      let anc = refEl.parentElement;
      while (anc && anc !== document.body && anc !== document.documentElement) {
        const cs = window.getComputedStyle(anc);
        if (/(auto|scroll)/i.test(cs.overflowY) && anc.scrollHeight > anc.clientHeight + 24) {
          scrollPane = anc;
          break;
        }
        anc = anc.parentElement;
      }
    }
    lastScanContext.scrollPane = scrollPane;
    lastScanContext.allCardEls = Array.from(allCardEls);
    lastScanContext.sharedContext = sharedContext;

    const innerCanScroll = Boolean(
      scrollPane && scrollPane.scrollTop + scrollPane.clientHeight < scrollPane.scrollHeight - 40
    );
    const windowCanScroll =
      window.scrollY + window.innerHeight <
      Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      ) -
      60;
    const canScrollMore = innerCanScroll || windowCanScroll;

    const stateHash = [
      location.href,
      `rec:${isRecordingTask}`,
      `resrev:${pageIsResultReview}`,
      `crs:${courseLessons.length}:${courseGoalDone}`,
      `ret:${courseReturnBtn ? courseReturnBtn.text : ""}`,
      `active:${activeBlocks.length}`,
      `ans:${answeredBlocksCount}`,
      `lock:${lockedBlocksCount}`,
      `mc:${mediaCardsSummary.activeCount}/${mediaCardsSummary.lockedCount}/${mediaCardsSummary.playingCount}/${mediaCardsSummary.unplayedActiveCount}`,
      `txt:${textInputs.length}`,
      `pills:${inlineInputPills.length}`,
      scrollPane ? `sp:${Math.round(scrollPane.scrollTop / 50)}` : "",
      focusedQuestionText.slice(0, 500),
      ...options.map((o) => `${o.text}:${o.checked}`),
      ...textInputs.map((t) => `${t.id}:${t.currentValue}`),
      ...inlineInputPills.map((p) => p.label),
      ...buttons.map((b) => `${b.text}:${b.kind}`),
      ...mediaCardsSummary.cards.map((c) => `${c.id}:${c.locked}:${c.played}:${c.playing}`)
    ].join("|");

    // Compact per-block summary always included for step logging
    const blocksSummary = questionBlocks.map((b) => ({
      qId: b.qId,
      status: b.status,
      reason: b.statusReason,
      qPreview: b.questionText.replace(/\s+/g, " ").slice(0, 55),
      optCount: b.rawItems.length,
      checkedTexts: b.rawItems.filter((i) => i.checked).map((i) => i.text.slice(0, 30)),
      optTag: describeEl(b.rawItems[0]?.clickTarget)
    }));

    const audioInfo = pageIsResultReview
      ? { hasAudioPlayer: false, activeAudioUrl: null, audioUrls: [], hiddenTranscript: "" }
      : extractAudioAndTranscriptContext(
          targetBlock,
          targetBlockIdx,
          questionBlocks.length,
          sharedContext
        );

    const result = {
      title: document.title || "",
      url: location.href,
      activeQuestionId: pageIsResultReview ? null : targetBlock?.qId || null,
      activeQuestionText: pageIsResultReview ? "" : focusedQuestionText,
      sharedContext:
        !pageIsResultReview && targetBlock && sharedContext !== focusedQuestionText
          ? sharedContext
          : "",
      hiddenTranscript: audioInfo.hiddenTranscript || "",
      activeAudioUrl: audioInfo.activeAudioUrl || null,
      audioUrls: audioInfo.audioUrls || [],
      hasAudioPlayer: Boolean(audioInfo.hasAudioPlayer),
      pageText: pageIsResultReview ? topBodySnippet.slice(0, 900) : focusedQuestionText || sharedContext,
      options: pageIsResultReview ? [] : options,
      selects: pageIsResultReview ? [] : selects,
      textInputs: pageIsResultReview ? [] : textInputs,
      inlineInputPills: pageIsResultReview ? [] : inlineInputPills,
      buttons,
      inactiveButtons,
      blocksSummary: pageIsResultReview
        ? blocksSummary.map((b) => ({ ...b, status: "answered", reason: "test_result_review_screen" }))
        : blocksSummary,
      questionSummary: pageIsResultReview
        ? {
            totalBlocks: questionBlocks.length,
            activeCount: 0,
            answeredCount: questionBlocks.length,
            lockedCount: 0
          }
        : {
            totalBlocks: questionBlocks.length,
            activeCount: activeBlocks.length,
            answeredCount: answeredBlocksCount,
            lockedCount: lockedBlocksCount
          },
      canScrollMore,
      hasQuizKeywords,
      isRecordingTask,
      isResultReview: pageIsResultReview,
      resultOutcome,
      resultScorePercent,
      isCourseDashboard: pageIsCourseDashboard,
      courseLessons,
      courseGoalDone,
      courseReturnBtn,
      questionBaseKey,
      isTileQuestion: isTileBlock,
      tilePartialUsedCount,
      hasTileBackspace,
      mediaCards: mediaCardsSummary,
      stateHash
    };

    // Detailed DOM diagnostic snapshot when requested by Debug Inspector
    if (includeFullDebug) {
      result.debugSnapshot = {
        url: location.href,
        title: document.title,
        isRecordingTask,
        isResultReview: pageIsResultReview,
        resultOutcome,
        resultScorePercent,
        isCourseDashboard: pageIsCourseDashboard,
        courseGoalDone,
        courseLessonsCount: courseLessons.length,
        courseLessonsPreview: courseLessons.slice(0, 8),
        courseReturnBtn,
        textInputsCount: textInputs.length,
        textInputsPreview: textInputs.slice(0, 12),
        inlineInputPillsCount: inlineInputPills.length,
        inlineInputPillsPreview: inlineInputPills.slice(0, 12),
        mediaCards: {
          totalCount: mediaCardsSummary.totalCount,
          activeCount: mediaCardsSummary.activeCount,
          lockedCount: mediaCardsSummary.lockedCount,
          playingCount: mediaCardsSummary.playingCount,
          unplayedActiveCount: mediaCardsSummary.unplayedActiveCount,
          cards: mediaCardsList
        },
        viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
        audio: {
          hasAudioPlayer: audioInfo.hasAudioPlayer,
          activeAudioUrl: audioInfo.activeAudioUrl,
          audioUrls: audioInfo.audioUrls,
          hiddenTranscriptLength: (audioInfo.hiddenTranscript || "").length,
          hiddenTranscriptPreview: (audioInfo.hiddenTranscript || "").slice(0, 300)
        },
        scrollPane: scrollPane
          ? {
            el: describeEl(scrollPane),
            scrollTop: Math.round(scrollPane.scrollTop),
            clientHeight: scrollPane.clientHeight,
            scrollHeight: scrollPane.scrollHeight
          }
          : null,
        sharedContextLength: sharedContext.length,
        sharedContextPreview: sharedContext.slice(0, 350),
        questionBlocks: questionBlocks.map((b) => ({
          qId: b.qId,
          status: b.status,
          statusReason: b.statusReason,
          cardEl: describeEl(b.cardEl),
          containerEl: describeEl(b.container),
          questionText: b.questionText.slice(0, 240),
          sampleOptionHtml: sanitizeHtmlSkeleton(
            b.rawItems[0]?.highlightTarget || b.rawItems[0]?.clickTarget
          ),
          options: b.rawItems.map((it) => ({
            text: it.text.slice(0, 70),
            type: it.choiceType,
            isNative: it.isNativeInput,
            checked: it.checked,
            checkedReason: it.checkedReason || "",
            inactive: it.inactive,
            clickEl: describeEl(it.clickTarget),
            bg: rgbStr(it.visual?.compBg),
            fg: rgbStr(it.visual?.compFg),
            lumBg: it.visual?.lumBg,
            lumFg: it.visual?.lumFg,
            contrast: it.visual?.textContrast,
            opacity: it.visual?.effectiveOpacity,
            cursor: it.visual?.cursor,
            pointerNone: it.visual?.pointerNone
          }))
        })),
        buttons: scannedButtons.map((b) => ({
          text: b.text,
          kind: b.kind,
          el: b.tagDesc,
          insideActiveCard: b.insideActiveCard,
          belongsToActiveQuestion: b.belongsToActiveQuestion,
          bg: rgbStr(b.vis?.compBg),
          cursor: b.vis?.cursor,
          rect: {
            top: Math.round(b.vis.rect.top),
            left: Math.round(b.vis.rect.left),
            w: Math.round(b.vis.rect.width),
            h: Math.round(b.vis.rect.height)
          }
        })),
        inactiveButtons
      };
    }

    return result;
  }

  // ============================================================================
  // Action Execution (with Detailed Action Trace for Debugging!)
  // ============================================================================
  function simulateRealisticClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    } catch (_) { }

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // Hit-test the innermost visible child at (clientX, clientY) so events bubble up through all inner & outer layers
    let dispatchTarget = el;
    try {
      const hitEl = document.elementFromPoint(clientX, clientY);
      if (hitEl && el.contains(hitEl) && !isInsideHud(hitEl)) {
        dispatchTarget = hitEl;
      }
    } catch (_) { }

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    try {
      dispatchTarget.dispatchEvent(new PointerEvent("pointerover", eventInit));
      dispatchTarget.dispatchEvent(new MouseEvent("mouseover", eventInit));
      dispatchTarget.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      dispatchTarget.dispatchEvent(new MouseEvent("mousedown", eventInit));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      dispatchTarget.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
      dispatchTarget.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    } catch (_) { }

    if (typeof dispatchTarget.click === "function") {
      dispatchTarget.click();
    } else {
      dispatchTarget.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
    }
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findTileBackspaceButton(scope, excludedTileSet = null) {
    if (!scope) return null;
    const allBtns = scope.querySelectorAll('button, [role="button"]');
    for (const b of allBtns) {
      if (isInsideHud(b)) continue;
      if (excludedTileSet && excludedTileSet.has(b)) continue;
      const t = normalizeText(b.innerText || b.textContent || "");
      const aria = (b.getAttribute("aria-label") || b.getAttribute("title") || "").toLowerCase();
      const cls = typeof b.className === "string" ? b.className.toLowerCase() : "";
      if (/(play|pause|再生|一時停止)/i.test(aria) || /\bplay\b/.test(cls)) continue;
      const looksLikeBackspace =
        (t.length === 0 && Boolean(b.querySelector("svg, i, img"))) ||
        /^[⌫←✕✖]$/u.test(t) ||
        /(backspace|delete|erase|clear|消去|削除)/i.test(aria);
      if (!looksLikeBackspace) continue;
      const vis = inspectElementVisualState(b);
      if (!vis.visible || vis.inactive) continue;
      if (vis.rect.width >= 18 && vis.rect.width <= 110 && vis.rect.height >= 18 && vis.rect.height <= 80) {
        return b;
      }
    }
    return null;
  }

  async function clearPartialTilesOnBlock(targetBlock, maxClicks, actionsTaken) {
    if (!targetBlock) return 0;
    const scope =
      targetBlock.cardEl && targetBlock.cardEl !== document.body
        ? targetBlock.cardEl
        : targetBlock.container;
    if (!scope) return 0;
    const tileElSet = new Set(
      (targetBlock.rawItems || []).map((it) => it.clickTarget).filter(Boolean)
    );
    const backspaceBtn = findTileBackspaceButton(scope, tileElSet);
    if (!backspaceBtn) return 0;

    let clickedCount = 0;
    const limit = Math.max(1, Number(maxClicks) || 1);
    for (let k = 0; k < limit; k++) {
      if (!document.contains(backspaceBtn)) break;
      const vis = inspectElementVisualState(backspaceBtn);
      if (!vis.visible || vis.inactive) break;
      simulateRealisticClick(backspaceBtn);
      clickedCount += 1;
      await delay(45);
      // Stop early once all tiles become active again
      const stillInactive = (targetBlock.rawItems || []).some((it) => {
        const el = it.clickTarget;
        return el && document.contains(el) && inspectElementVisualState(el).inactive;
      });
      if (!stillInactive) break;
    }
    if (clickedCount > 0) {
      actionsTaken.push(`cleared partial tiles via backspace (${clickedCount}x)`);
      await delay(80);
    }
    return clickedCount;
  }

  async function executeAction(payload) {
    ensurePageHighlightStyle();
    clearHighlights();

    const actionsTaken = [];
    const {
      status,
      selectedOptionIds = [],
      selectValues = [],
      textValues = [],
      pillId = null,
      courseBtnId = null,
      returnBtnId = null,
      clickButtonId = null,
      allowGlobalSubmit = true,
      autoSubmit = true,
      clickDelayMs = 650,
      highlightAnswer = true
    } = payload || {};

    if (status === "scroll_down") {
      const sp = lastScanContext.scrollPane;
      if (sp && sp.scrollTop + sp.clientHeight < sp.scrollHeight - 20) {
        const before = Math.round(sp.scrollTop);
        sp.scrollBy({ top: Math.round(sp.clientHeight * 0.75), behavior: "instant" });
        await delay(250);
        actionsTaken.push(`scrolled innerPane ${describeEl(sp)} ${before}->${Math.round(sp.scrollTop)}`);
      } else {
        const before = Math.round(window.scrollY);
        window.scrollBy({ top: Math.round(window.innerHeight * 0.75), behavior: "instant" });
        await delay(250);
        actionsTaken.push(`scrolled window ${before}->${Math.round(window.scrollY)}`);
      }
      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, actionsTaken };
    }

    if (status === "click_pill" && pillId) {
      const entry = elementRegistry.get(pillId);
      const pillEl = entry?.clickTarget;
      if (!pillEl || !document.contains(pillEl)) {
        return { ok: false, error: `missing pill ${pillId}`, actionsTaken };
      }
      if (highlightAnswer) pillEl.classList.add(HIGHLIGHT_CLASS);
      try {
        pillEl.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      } catch (_) { }
      await delay(60);
      simulateRealisticClick(pillEl);
      actionsTaken.push(`clicked inline pill ${pillId}("${entry.qLabel || "入力..."}")`);
      await delay(240);
      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, actionsTaken };
    }

    if (status === "click_course_start" && courseBtnId) {
      const entry = elementRegistry.get(courseBtnId);
      const btnEl = entry?.clickTarget;
      if (!btnEl || !document.contains(btnEl)) {
        return { ok: false, error: `missing course start ${courseBtnId}`, actionsTaken };
      }
      const hlTarget = entry.highlightTarget || btnEl;
      if (highlightAnswer && hlTarget) hlTarget.classList.add(HIGHLIGHT_CLASS);
      try {
        btnEl.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      } catch (_) { }
      await delay(80);
      simulateRealisticClick(btnEl);
      actionsTaken.push(`clicked course start ${courseBtnId}("${entry.label || ""}")`);
      await delay(250);
      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, actionsTaken };
    }

    if (status === "click_course_return" && returnBtnId) {
      const entry = elementRegistry.get(returnBtnId);
      const btnEl = entry?.clickTarget;
      if (!btnEl || !document.contains(btnEl)) {
        return { ok: false, error: `missing course return ${returnBtnId}`, actionsTaken };
      }
      if (highlightAnswer) btnEl.classList.add(HIGHLIGHT_CLASS);
      try {
        btnEl.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      } catch (_) { }
      await delay(80);
      simulateRealisticClick(btnEl);
      actionsTaken.push(`clicked course return ${returnBtnId}("${entry.text || ""}")`);
      await delay(250);
      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, actionsTaken };
    }

    if (status === "play_media_card") {
      const targetCardId = payload?.targetCardId;
      const entry = targetCardId ? elementRegistry.get(targetCardId) : null;
      const clickEl = entry?.clickTarget;
      const cardEl = entry?.cardEl;
      if (!clickEl || !document.contains(clickEl)) {
        return { ok: false, error: `missing media card ${targetCardId || ""}`, actionsTaken };
      }

      const preScan = scanMediaCards();
      const preUnlockedCount = preScan.cards.filter((c) => !c.locked).length;
      const preNextCount = scanActionButtons(
        lastScanContext.claimedElements,
        null,
        null
      ).filter((b) => b.kind === "next" || b.kind === "submit").length;
      const preCardText = normalizeText(cardEl?.innerText || "");

      const hlTarget = entry.highlightTarget || clickEl;
      if (highlightAnswer && hlTarget) {
        hlTarget.classList.add(HIGHLIGHT_CLASS);
      }

      try {
        clickEl.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      } catch (_) { }
      await delay(80);

      simulateRealisticClick(clickEl);
      clickedMediaPlayBtns.add(clickEl);
      actionsTaken.push(`clicked media play ${targetCardId}("${entry.label || ""}")`);

      await delay(280);
      let sawPlaying = false;
      let stillPlaying = false;
      const startedWaitAt = Date.now();
      const maxWaitMs = 4500;

      while (Date.now() - startedWaitAt < maxWaitMs) {
        const liveScan = scanMediaCards();
        const playingNow = liveScan.anyOrangePlaying || isAnyHtmlAudioPlaying();
        if (playingNow) sawPlaying = true;

        const liveUnlockedCount = liveScan.cards.filter((c) => !c.locked).length;
        const liveNextCount = scanActionButtons(
          lastScanContext.claimedElements,
          null,
          null
        ).filter((b) => b.kind === "next" || b.kind === "submit").length;

        if (!playingNow && sawPlaying) {
          await delay(260);
          stillPlaying = false;
          actionsTaken.push("playback finished");
          break;
        }
        if (!playingNow && (liveUnlockedCount > preUnlockedCount || liveNextCount > preNextCount)) {
          await delay(180);
          stillPlaying = false;
          actionsTaken.push("next card/button unlocked");
          break;
        }

        const elapsed = Date.now() - startedWaitAt;
        const liveCardText = normalizeText(cardEl?.innerText || "");
        if (
          !playingNow &&
          elapsed >= 750 &&
          (liveCardText !== preCardText || !document.contains(clickEl))
        ) {
          await delay(180);
          stillPlaying = false;
          actionsTaken.push("card updated");
          break;
        }
        if (!playingNow && elapsed >= 1100) {
          stillPlaying = false;
          break;
        }

        stillPlaying = playingNow;
        await delay(220);
      }

      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, stillPlaying, actionsTaken };
    }

    if (status === "clear_partial_tiles") {
      const tb = lastScanContext.targetBlock;
      const usedCount = tb
        ? (tb.rawItems || []).filter((it) => inspectElementVisualState(it.clickTarget).inactive).length
        : 0;
      const targetClicks = Math.max(usedCount + 2, Number(payload?.clickCount) || 1);
      await clearPartialTilesOnBlock(tb, targetClicks, actionsTaken);
      console.log("[ELK] Exec:", actionsTaken);
      return { ok: true, actionsTaken };
    }

    const preExistingButtonElements = new Set();
    for (const [, item] of elementRegistry.entries()) {
      if (item.kind === "button" && item.clickTarget) {
        preExistingButtonElements.add(item.clickTarget);
      }
    }

    let performedOptionClick = false;
    const isMultiTileSequence =
      selectedOptionIds.length >= 2 &&
      selectedOptionIds.some((id) => elementRegistry.get(id)?.isTile);

    // If this is a letter-tile question and some tiles were already used/disabled from a partial attempt,
    // click the backspace button [⌫] first to clear the blank slots so all tiles are active!
    if (isMultiTileSequence && lastScanContext.targetBlock) {
      const tb = lastScanContext.targetBlock;
      const usedCount = (tb.rawItems || []).filter((it) => inspectElementVisualState(it.clickTarget).inactive).length;
      if (usedCount > 0) {
        await clearPartialTilesOnBlock(tb, usedCount + 2, actionsTaken);
      }
    }

    const clickedElementsInThisTurn = new Set();

    // 1. Select options (or click letter tiles in exact sequence!)
    for (const optId of selectedOptionIds) {
      const entry = elementRegistry.get(optId);
      if (!entry) {
        actionsTaken.push(`missing ${optId} in registry`);
        continue;
      }

      let clickEl = entry.clickTarget;
      let highlightEl = entry.highlightTarget || clickEl;
      let targetVis = inspectElementVisualState(highlightEl);

      // For multi-tile sequences (e.g. duplicate letters like two "h" tiles in "might have", or React re-rendering tiles):
      // If the specific element was already clicked in this turn or is inactive/detached, find another active tile with the same text!
      if (
        isMultiTileSequence &&
        (!clickEl ||
          !document.contains(clickEl) ||
          !targetVis.visible ||
          targetVis.inactive ||
          clickedElementsInThisTurn.has(clickEl))
      ) {
        const searchScope =
          entry.container ||
          lastScanContext.targetBlock?.container ||
          lastScanContext.targetBlock?.cardEl;
        if (searchScope && entry.text) {
          const candidates = searchScope.querySelectorAll('button, [role="button"], div');
          for (const cand of candidates) {
            if (clickedElementsInThisTurn.has(cand)) continue;
            if (normalizeText(cand.innerText || cand.textContent) !== entry.text) continue;
            const cVis = inspectElementVisualState(cand);
            if (cVis.visible && !cVis.inactive) {
              clickEl = cand;
              highlightEl = cand;
              targetVis = cVis;
              break;
            }
          }
        }
      }

      if (!targetVis.visible || targetVis.inactive) {
        actionsTaken.push(`skipped ${optId}("${entry.text || ""}") (inactive/hidden)`);
        continue;
      }

      try {
        highlightEl.scrollIntoView({
          behavior: "instant",
          block: "center",
          inline: "nearest"
        });
      } catch (_) { }
      await delay(isMultiTileSequence ? 35 : 60);

      if (highlightAnswer && highlightEl) {
        highlightEl.classList.add(HIGHLIGHT_CLASS);
      }

      if (entry.kind === "radio" || entry.kind === "checkbox") {
        const input = entry.inputEl;
        if (input && !input.checked) {
          simulateRealisticClick(clickEl || input);
          performedOptionClick = true;
          await delay(80);
          if (!input.checked) {
            simulateRealisticClick(input);
            await delay(60);
          }
          if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          actionsTaken.push(
            `clicked ${optId} (${entry.kind} ${describeEl(clickEl || input)} checked=${input.checked})`
          );
        } else {
          actionsTaken.push(`kept ${optId} (native already checked)`);
        }
      } else {
        const alreadyChecked =
          !isMultiTileSequence &&
          (Boolean(entry.alreadySelected) ||
            clickEl?.getAttribute("aria-checked") === "true" ||
            clickEl?.getAttribute("aria-pressed") === "true" ||
            clickEl?.getAttribute("aria-selected") === "true");

        if (!alreadyChecked) {
          simulateRealisticClick(clickEl);
          clickedElementsInThisTurn.add(clickEl);
          performedOptionClick = true;
          actionsTaken.push(`clicked ${optId}("${entry.text || ""}") (${describeEl(clickEl)})`);
        } else {
          actionsTaken.push(`kept ${optId} (${describeEl(clickEl)} alreadySelected=true)`);
        }
      }

      await delay(isMultiTileSequence ? 95 : 160);
    }

    // 2. Fill <select> dropdowns
    for (const selItem of selectValues) {
      const entry = elementRegistry.get(selItem.id);
      if (!entry || !entry.clickTarget) continue;
      const selEl = entry.clickTarget;
      if (highlightAnswer) {
        selEl.classList.add(HIGHLIGHT_CLASS);
      }
      selEl.value = selItem.value;
      selEl.dispatchEvent(new Event("input", { bubbles: true }));
      selEl.dispatchEvent(new Event("change", { bubbles: true }));
      performedOptionClick = true;
      actionsTaken.push(`selected ${selItem.id}=${selItem.value}`);
      await delay(150);
    }

    // 2b. Fill text <input>, <textarea>, and [contenteditable] fields (React-compatible native value setter)
    for (const txtItem of textValues) {
      if (!txtItem || !txtItem.id) continue;
      const entry = elementRegistry.get(txtItem.id);
      const inpEl = entry?.clickTarget;
      if (!inpEl || !document.contains(inpEl)) {
        actionsTaken.push(`missing ${txtItem.id}`);
        continue;
      }
      const valStr = txtItem.value == null ? "" : String(txtItem.value);
      try {
        inpEl.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      } catch (_) { }
      if (highlightAnswer) {
        inpEl.classList.add(HIGHLIGHT_CLASS);
      }
      try {
        if (typeof inpEl.focus === "function") inpEl.focus({ preventScroll: true });
      } catch (_) { }

      if (entry.kind === "contenteditable") {
        inpEl.textContent = valStr;
      } else {
        const proto =
          inpEl.tagName === "TEXTAREA"
            ? typeof HTMLTextAreaElement !== "undefined"
              ? HTMLTextAreaElement.prototype
              : null
            : typeof HTMLInputElement !== "undefined"
              ? HTMLInputElement.prototype
              : null;
        const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
        if (nativeSetter) {
          nativeSetter.call(inpEl, valStr);
        } else {
          inpEl.value = valStr;
        }
      }

      try {
        if (typeof InputEvent !== "undefined") {
          inpEl.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: valStr })
          );
        } else {
          inpEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (_) {
        inpEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      inpEl.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        if (typeof inpEl.blur === "function") inpEl.blur();
      } catch (_) { }
      inpEl.dispatchEvent(new Event("blur", { bubbles: true }));

      performedOptionClick = true;
      actionsTaken.push(`typed ${txtItem.id}="${valStr}"`);
      await delay(140);
    }

    // 3. Submit / Confirm ("確認", "解答する", "次へ", etc.)
    if (autoSubmit) {
      if (performedOptionClick) {
        await delay(Math.max(300, Number(clickDelayMs) || 600));
      } else {
        await delay(120);
      }

      const canClickGlobal = status === "next_only" || allowGlobalSubmit;

      if (clickButtonId) {
        const btnEntry = elementRegistry.get(clickButtonId);
        const isConfirmWord = /^(確認|確認する|解答|解答する|回答|回答する|判定|判定する|決定|答え合わせ|チェック|check|confirm)$/i.test(
          normalizeText(btnEntry?.clickTarget?.innerText || btnEntry?.clickTarget?.textContent || "")
        );
        if (btnEntry && (canClickGlobal || btnEntry.belongsToActiveQuestion || isConfirmWord)) {
          const btnVis = inspectElementVisualState(btnEntry.clickTarget);
          if (document.contains(btnEntry.clickTarget) && btnVis.visible && !btnVis.inactive) {
            simulateRealisticClick(btnEntry.clickTarget);
            actionsTaken.push(
              `clicked AI btn ${clickButtonId} (${describeEl(btnEntry.clickTarget)})`
            );
            console.log("[ELK] Exec:", actionsTaken);
            return { ok: true, actionsTaken };
          }
        } else if (btnEntry) {
          actionsTaken.push(
            `blocked AI btn ${clickButtonId} (canClickGlobal=${canClickGlobal}, belongsToActive=${btnEntry.belongsToActiveQuestion})`
          );
        }
      }

      if (status === "answer" || status === "next_only") {
        const maxPolls = performedOptionClick ? 2 : 1;
        for (let poll = 0; poll < maxPolls; poll++) {
          if (poll > 0) await delay(350);

          const liveButtons = scanActionButtons(
            lastScanContext.claimedElements,
            lastScanContext.targetBlock,
            lastScanContext.nextBlockBelow
          );
          const allLiveSubmits = liveButtons.filter((b) => b.kind === "submit");

          const submitCandidate = allLiveSubmits.find((b) => {
            const isPerQWord = /^(確認|確認する|解答|解答する|回答|回答する|判定|判定する|決定|答え合わせ|チェック|check|confirm)$/i.test(
              b.text
            );
            return (
              b.belongsToActiveQuestion ||
              canClickGlobal ||
              (isPerQWord && allLiveSubmits.length === 1)
            );
          });

          if (submitCandidate) {
            simulateRealisticClick(submitCandidate.el);
            actionsTaken.push(
              `clicked live submit "${submitCandidate.text}" (${submitCandidate.tagDesc}, belongs=${submitCandidate.belongsToActiveQuestion}, poll=${poll})`
            );
            console.log("[ELK] Exec:", actionsTaken);
            return { ok: true, actionsTaken };
          }

          const hasUnfilledAfterAction =
            Boolean(lastScanContext.hasUnfilledSelectsOrPills) ||
            Boolean(
              Array.isArray(lastScanContext.textInputEls) &&
              lastScanContext.textInputEls.some((el) => {
                if (!document.contains(el)) return false;
                const val = el.isContentEditable || el.hasAttribute("contenteditable")
                  ? normalizeText(el.innerText || el.textContent || "")
                  : String(el.value || "").trim();
                return !val;
              })
            );

          const nextCandidate = liveButtons.find(
            (b) =>
              b.kind === "next" &&
              (status === "next_only" ||
                b.belongsToActiveQuestion ||
                (canClickGlobal &&
                  (!preExistingButtonElements.has(b.el) ||
                    (performedOptionClick && !hasUnfilledAfterAction))))
          );

          if (nextCandidate) {
            simulateRealisticClick(nextCandidate.el);
            actionsTaken.push(
              `clicked live next "${nextCandidate.text}" (${nextCandidate.tagDesc})`
            );
            console.log("[ELK] Exec:", actionsTaken);
            return { ok: true, actionsTaken };
          }

          if (poll === maxPolls - 1) {
            actionsTaken.push(
              `no submit clicked (canClickGlobal=${canClickGlobal}, liveBtns=${liveButtons.length})`
            );
          }
        }
      }
    }

    console.log("[ELK] Exec:", actionsTaken);
    return { ok: true, actionsTaken };
  }

  // ============================================================================
  // Floating HUD with Live Debug Console & 1-Click Copy Debug Report
  // ============================================================================
  let hudRefs = null;
  let hudVisibleSetting = true;

  function createHud() {
    if (!alive || window !== window.top) return null;
    if (hudRefs) return hudRefs;
    if (typeof globalThis.__elkCreateHud !== "function") return null;
    hudRefs = globalThis.__elkCreateHud({
      hostId: HUD_HOST_ID,
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
      if (document.body) {
        createHud();
      }
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
        .catch(() => { });
    } catch (_) { }
  }

  if (isContextValid()) {
    const onRuntimeMessage = (message, _sender, sendResponse) => {
      if (!isContextValid()) return false;
      (async () => {
        switch (message.type) {
          case "ELK_PING":
            sendResponse({ ok: true, instanceId });
            break;

          case "ELK_EXTRACT_STATE": {
            const data = extractPageState(
              message.answeredBlockKeys || [],
              Boolean(message.includeFullDebug),
              message.playedMediaCardKeys || []
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
        } catch (_) { }
      });

      return true;
    };

    try {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      cleanupCallbacks.push(() => {
        try {
          chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        } catch (_) { }
      });
    } catch (_) { }
  }
})();
