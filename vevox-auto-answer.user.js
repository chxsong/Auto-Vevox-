// ==UserScript==
// @name         Vevox Auto Answer
// @namespace    auto-vevox
// @version      0.1.0
// @description  Detect Vevox question changes, call OpenAI-compatible API, auto click option and submit.
// @match        *://*.vevox.app/*
// @match        *://*.vevox.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEYS = {
    apiKey: "vevox_api_key",
    endpoint: "vevox_endpoint",
    model: "vevox_model",
    temperature: "vevox_temperature",
    maxTokens: "vevox_max_tokens",
    timeoutMs: "vevox_timeout_ms",
    autoSubmit: "vevox_auto_submit",
    submitDelayMs: "vevox_submit_delay_ms",
    debug: "vevox_debug",
    debugButtonEnabled: "vevox_debug_button_enabled"
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    debounceMs: 700,
    scanIntervalMs: 2500,
    retryCooldownMs: 5000,
    maxAttemptsPerQuestion: 5,
    minOptionCount: 2,
    maxOptionCount: 8,
    maxOptionTextLength: 180,
    endpoint: "",
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 80,
    timeout_ms: 20000,
    autoSubmit: true,
    submitDelayMs: 350,
    debug: true,
    debugButtonEnabled: true,
    questionSelectors: [
      "h2[data-testid='question-title']",
      "[data-testid='question-title']",
      "[data-testid*='question']",
      ".v-question-title",
      ".question-title",
      "[class*='question']",
      "main h1",
      "main h2",
      "main h3",
      "h1",
      "h2"
    ],
    optionSelectors: [
      "p.py-4.wrapchoices.pr-4",
      "[data-testid*='option']",
      "[class*='option']",
      "[class*='answer']",
      "[role='button']",
      "button",
      "label"
    ],
    submitSelectors: [
      "button[type='submit']",
      "button[data-testid*='submit']",
      "button[class*='submit']",
      "button[class*='send']",
      "button[class*='vote']"
    ]
  };

  const state = {
    apiKey: "",
    observer: null,
    observerTimer: null,
    inFlight: false,
    attemptsBySignature: new Map(),
    lastAttemptBySignature: new Map(),
    answeredSignatures: new Set(),
    currentSignature: "",
    missingConfigWarned: false,
    lastApiError: null,
    lastSnapshot: null,
    lastAiRaw: "",
    runCounter: 0,
    runReports: [],
    debugEntries: [],
    debugButtonEl: null,
    startedAt: Date.now()
  };

  const MAX_RUN_REPORTS = 200;
  const MAX_DEBUG_ENTRIES = 500;

  const GENERIC_BUTTON_TEXT = new Set([
    "submit",
    "send",
    "vote",
    "vote now",
    "next",
    "back",
    "continue",
    "join",
    "start",
    "confirm",
    "cancel",
    "close",
    "ok"
  ]);

  const CONFIG = loadConfig();
  state.apiKey = readValue(STORAGE_KEYS.apiKey, "");

  function toFiniteNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (typeof min === "number" && n < min) return fallback;
    if (typeof max === "number" && n > max) return fallback;
    return n;
  }

  function readValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallback);
      }
    } catch (err) {
      console.error("[VevoxAuto] GM_getValue failed:", err);
    }
    return fallback;
  }

  function writeValue(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (err) {
      console.error("[VevoxAuto] GM_setValue failed:", err);
    }
  }

  function loadConfig() {
    const storedEndpoint = String(readValue(STORAGE_KEYS.endpoint, DEFAULT_CONFIG.endpoint) || "").trim();
    return {
      ...DEFAULT_CONFIG,
      endpoint: storedEndpoint,
      model: String(readValue(STORAGE_KEYS.model, DEFAULT_CONFIG.model) || DEFAULT_CONFIG.model).trim(),
      temperature: toFiniteNumber(
        readValue(STORAGE_KEYS.temperature, DEFAULT_CONFIG.temperature),
        DEFAULT_CONFIG.temperature,
        0,
        2
      ),
      max_tokens: Math.floor(
        toFiniteNumber(readValue(STORAGE_KEYS.maxTokens, DEFAULT_CONFIG.max_tokens), DEFAULT_CONFIG.max_tokens, 1, 2000)
      ),
      timeout_ms: Math.floor(
        toFiniteNumber(readValue(STORAGE_KEYS.timeoutMs, DEFAULT_CONFIG.timeout_ms), DEFAULT_CONFIG.timeout_ms, 1000, 120000)
      ),
      autoSubmit: Boolean(readValue(STORAGE_KEYS.autoSubmit, DEFAULT_CONFIG.autoSubmit)),
      submitDelayMs: Math.floor(
        toFiniteNumber(
          readValue(STORAGE_KEYS.submitDelayMs, DEFAULT_CONFIG.submitDelayMs),
          DEFAULT_CONFIG.submitDelayMs,
          0,
          5000
        )
      ),
      debug: Boolean(readValue(STORAGE_KEYS.debug, DEFAULT_CONFIG.debug)),
      debugButtonEnabled: Boolean(
        readValue(STORAGE_KEYS.debugButtonEnabled, DEFAULT_CONFIG.debugButtonEnabled)
      )
    };
  }

  function normalizeLoadedEndpoint() {
    if (!CONFIG.endpoint) return;
    const normalized = resolveChatCompletionsUrl(CONFIG.endpoint);
    if (normalized !== CONFIG.endpoint) {
      CONFIG.endpoint = normalized;
      writeValue(STORAGE_KEYS.endpoint, CONFIG.endpoint);
    }
  }

  function formatLogValue(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  function pushDebugEntry(level, args) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message: args.map(formatLogValue).join(" ")
    };
    state.debugEntries.push(entry);
    if (state.debugEntries.length > MAX_DEBUG_ENTRIES) {
      state.debugEntries.shift();
    }
  }

  function log() {
    const args = Array.from(arguments);
    pushDebugEntry("info", args);
    if (!CONFIG.debug) return;
    console.log("[VevoxAuto]", ...args);
  }

  function normalizeText(input) {
    return String(input || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(el) {
    if (!el || typeof el.getClientRects !== "function") return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return true;
  }

  function isDisabled(el) {
    if (!el) return true;
    if ("disabled" in el && el.disabled) return true;
    return el.getAttribute("aria-disabled") === "true";
  }

  function scoreQuestionCandidate(el, selector, text) {
    let score = 0;
    if (selector.includes("question-title")) score += 8;
    if (selector.includes("question")) score += 6;
    if (/^h[1-3]$/i.test(el.tagName)) score += 3;
    if (text.endsWith("?")) score += 1;
    if (text.length >= 12 && text.length <= 220) score += 2;
    if (el.closest("main, article, section")) score += 1;
    return score;
  }

  function findQuestionText() {
    // Vevox stable structure: data-testid='question-title' usually contains pure question text.
    const exactSelectors = [
      "[data-testid='question-title'] p",
      "[data-testid='question-title']"
    ];
    for (const selector of exactSelectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalizeText(node.innerText || node.textContent);
        if (text.length >= 1 && text.length <= 300) {
          return text;
        }
      }
    }

    const candidates = [];
    for (const selector of CONFIG.questionSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isVisible(el)) continue;
        let text = normalizeText(el.innerText || el.textContent);
        text = text.replace(/thanks!?\s*press clear to change your answer/gi, '').trim();
        if (text.length < 1 || text.length > 300) continue;
        if (/radio_button_unchecked|clear|select a choice/i.test(text)) continue;
        candidates.push({
          text,
          score: scoreQuestionCandidate(el, selector, text)
        });
      }
    }
    if (candidates.length === 0) return "";
    candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
    return candidates[0].text;
  }

  function optionTextScore(el, selector, text) {
    let score = 0;
    if (selector === "p.py-4.wrapchoices.pr-4") score += 12;
    if (selector.includes("option") || selector.includes("answer")) score += 6;
    if (el.tagName === "LABEL") score += 3;
    if (el.tagName === "BUTTON") score += 2;
    if (el.closest("main, article, section")) score += 1;
    const lower = text.toLowerCase();
    if (GENERIC_BUTTON_TEXT.has(lower)) score -= 12;
    if (lower.includes("submit") || lower.includes("vote now")) score -= 8;
    return score;
  }

  function collectOptions() {
    const optionMap = new Map();

    for (const selector of CONFIG.optionSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isVisible(el) || isDisabled(el) || el.id === 'vevox-auto-debug-btn') continue;
        let text = normalizeText(el.innerText || el.textContent);
        text = text.replace(/radio_button_(un)?checked/gi, '').trim();
        if (!text) continue;
        if (text.length < 1 || text.length > CONFIG.maxOptionTextLength) continue;
        const lower = text.toLowerCase();
        if (GENERIC_BUTTON_TEXT.has(lower)) continue;
        if (/^(log in|login|register|menu)$/i.test(lower)) continue;
        if (/(clear|expand_more|explore about vevox|help using the app|language|exit session)/i.test(lower)) continue;

        const rect = el.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) continue;

        const candidate = {
          text,
          element: resolveClickableOptionElement(el),
          score: optionTextScore(el, selector, text),
          top: rect.top,
          left: rect.left
        };

        const existing = optionMap.get(text);
        if (!existing || candidate.score > existing.score) {
          optionMap.set(text, candidate);
        }
      }
    }

    const options = Array.from(optionMap.values())
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .slice(0, CONFIG.maxOptionCount);

    if (options.length < CONFIG.minOptionCount) return [];
    return options;
  }

  function resolveClickableOptionElement(el) {
    if (!el) return el;
    const clickable = el.closest(
      "[data-testid='question-choice'], .v-list-item, [role='option'], [role='button'], button, label"
    );
    return clickable || el;
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function getSnapshot() {
    const options = collectOptions();
    if (options.length < CONFIG.minOptionCount) return null;
    const question = findQuestionText();
    const optionTexts = options.map((item) => item.text);
    const signature = hashText(`${question}||${optionTexts.join("||")}`);
    return { signature, question, options };
  }

  function buildMessages(snapshot) {
    const optionsText = snapshot.options
      .map((option, index) => `${index}. ${option.text}`)
      .join("\n");

    return [
      {
        role: "system",
        content:
          "You select the best option for a multiple-choice question. Return strict JSON only."
      },
      {
        role: "user",
        content: [
          "Return JSON with this schema only:",
          '{"answer_index": number, "confidence": number, "reason": "short"}',
          "Use zero-based answer_index.",
          "",
          `Question: ${snapshot.question || "(No clear question text found in DOM)"}`,
          "Options:",
          optionsText
        ].join("\n")
      }
    ];
  }

  function gmRequest(request) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          ...request,
          onload: (response) => resolve(response),
          onerror: (error) => reject(new Error(`Network error: ${JSON.stringify(error)}`)),
          ontimeout: () => reject(new Error(`Request timeout after ${request.timeout} ms`))
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function callAI(snapshot) {
    const resolvedUrl = resolveChatCompletionsUrl(CONFIG.endpoint);
    const body = {
      model: CONFIG.model,
      messages: buildMessages(snapshot),
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.max_tokens
    };

    const startedAt = performance.now();
    const response = await gmRequest({
      method: "POST",
      url: resolvedUrl,
      timeout: CONFIG.timeout_ms,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.apiKey}`
      },
      data: JSON.stringify(body)
    });

    const elapsed = (performance.now() - startedAt).toFixed(2);
    log(`API call time: ${elapsed} ms`);

    if (response.status < 200 || response.status >= 300) {
      const details = {
        url: resolvedUrl,
        status: response.status,
        statusText: response.statusText || "",
        responseText: String(response.responseText || "").slice(0, 1000)
      };
      state.lastApiError = details;
      throw new Error(`AI request failed: ${response.status} ${details.responseText}`.trim());
    }

    let json;
    try {
      json = JSON.parse(response.responseText || "{}");
    } catch (err) {
      throw new Error(`Invalid JSON response: ${String(err)}`);
    }

    if (json && json.choices && json.choices[0] && json.choices[0].message) {
      state.lastApiError = null;
      return String(json.choices[0].message.content || "");
    }
    if (json && typeof json.answer_index !== "undefined") {
      state.lastApiError = null;
      return JSON.stringify(json);
    }
    throw new Error("AI response format not recognized");
  }

  function resolveChatCompletionsUrl(inputUrl) {
    const raw = String(inputUrl || "").trim();
    if (!raw) return raw;
    const normalized = raw.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(normalized)) return normalized;
    if (/\/chat$/i.test(normalized)) return `${normalized}/completions`;
    if (/^https?:\/\/api\.deepseek\.com\/v1$/i.test(normalized)) {
      return "https://api.deepseek.com/chat/completions";
    }
    if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
    return `${normalized}/chat/completions`;
  }

  function extractJsonObject(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
    const match = trimmed.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  }

  function parseAnswerIndexFromObject(obj, optionCount) {
    const candidates = [obj.answer_index, obj.answerIndex, obj.index, obj.choice, obj.option];

    for (const value of candidates) {
      if (typeof value === "number" && Number.isInteger(value)) {
        if (value >= 0 && value < optionCount) return value;
        if (value >= 1 && value <= optionCount) return value - 1;
      }

      if (typeof value === "string") {
        const numeric = Number.parseInt(value, 10);
        if (Number.isInteger(numeric)) {
          if (numeric >= 0 && numeric < optionCount) return numeric;
          if (numeric >= 1 && numeric <= optionCount) return numeric - 1;
        }

        const letter = value.trim().match(/^[A-Ha-h]$/);
        if (letter) {
          const index = letter[0].toUpperCase().charCodeAt(0) - 65;
          if (index >= 0 && index < optionCount) return index;
        }
      }
    }

    return null;
  }

  function parseAnswerIndex(rawText, options) {
    const optionCount = options.length;
    const text = String(rawText || "").trim();
    if (!text) return null;

    const jsonText = extractJsonObject(text);
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        const jsonIndex = parseAnswerIndexFromObject(parsed, optionCount);
        if (jsonIndex !== null) return jsonIndex;
      } catch (err) {
        log("JSON parse failed, fallback parser used:", err);
      }
    }

    const letter = text.match(/\b([A-Ha-h])\b/);
    if (letter) {
      const index = letter[1].toUpperCase().charCodeAt(0) - 65;
      if (index >= 0 && index < optionCount) return index;
    }

    const firstNumber = text.match(/-?\d+/);
    if (firstNumber) {
      const number = Number.parseInt(firstNumber[0], 10);
      if (number >= 0 && number < optionCount) return number;
      if (number >= 1 && number <= optionCount) return number - 1;
    }

    const lowerText = text.toLowerCase();
    for (let i = 0; i < options.length; i += 1) {
      if (lowerText.includes(options[i].text.toLowerCase())) {
        return i;
      }
    }

    return null;
  }

  function clickElement(el) {
    if (!el || !isVisible(el) || isDisabled(el)) return false;
    el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });

    const eventTypes = ["pointerdown", "mousedown", "mouseup", "click"];
    for (const type of eventTypes) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }

    if (typeof el.click === "function") {
      el.click();
    }
    return true;
  }

  function findSubmitButton() {
    for (const selector of CONFIG.submitSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!isVisible(el) || isDisabled(el)) continue;
        const text = normalizeText(el.innerText || el.textContent).toLowerCase();
        if (!text || /(submit|send|vote|confirm|next)/i.test(text)) {
          return el;
        }
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function updateDebugButtonLabel() {
    if (!state.debugButtonEl) return;
    const total = state.runReports.length;
    const latest = state.runReports[total - 1];
    const suffix = latest ? ` | ${latest.result}` : "";
    state.debugButtonEl.textContent = `Copy Debug (${total})${suffix}`;
  }

  function appendRunReport(report) {
    const row = {
      at: new Date().toISOString(),
      ...report
    };
    state.runReports.push(row);
    if (state.runReports.length > MAX_RUN_REPORTS) {
      state.runReports.shift();
    }
    pushDebugEntry("run", [row]);
    updateDebugButtonLabel();
  }

  function hasApiConfig() {
    return Boolean(CONFIG.endpoint && CONFIG.endpoint.trim() && state.apiKey && state.apiKey.trim());
  }

  function warnMissingConfigOnce() {
    if (state.missingConfigWarned) return;
    state.missingConfigWarned = true;
    log("Missing API configuration. Use Tampermonkey menu to set API key and endpoint.");
  }

  function clearMissingConfigWarning() {
    state.missingConfigWarned = false;
  }

  async function answerSnapshot(snapshot, reason, runReport) {
    if (state.inFlight) return;
    const startedAt = performance.now();
    let result = "unknown";
    let error = "";
    state.inFlight = true;
    state.currentSignature = snapshot.signature;
    const previousAttempts = state.attemptsBySignature.get(snapshot.signature) || 0;
    state.attemptsBySignature.set(snapshot.signature, previousAttempts + 1);

    try {
      state.lastSnapshot = {
        reason,
        signature: snapshot.signature,
        question: snapshot.question,
        options: snapshot.options.map((item) => item.text),
        at: new Date().toISOString()
      };
      log("Detected question", {
        reason,
        signature: snapshot.signature,
        question: snapshot.question,
        options: snapshot.options.map((item) => item.text)
      });

      const aiRaw = await callAI(snapshot);
      state.lastAiRaw = aiRaw;
      log("AI raw response:", aiRaw);

      const answerIndex = parseAnswerIndex(aiRaw, snapshot.options);
      if (answerIndex === null || !snapshot.options[answerIndex]) {
        log("No valid answer index parsed");
        result = "no_valid_answer";
        return;
      }

      const selectedOption = snapshot.options[answerIndex];
      const selected = clickElement(selectedOption.element);
      if (!selected) {
        log("Could not click option element");
        result = "click_failed";
        return;
      }

      log(`Clicked option [${answerIndex}]: ${selectedOption.text}`);
      result = "clicked_option";

      if (CONFIG.autoSubmit) {
        await sleep(CONFIG.submitDelayMs);
        const submitButton = findSubmitButton();
        if (submitButton) {
          clickElement(submitButton);
          log("Clicked submit button");
          result = "clicked_option_and_submit";
        } else {
          log("No submit button found, Vevox might submit immediately after option click");
          result = "clicked_option_submit_not_found";
        }
      }

      state.answeredSignatures.add(snapshot.signature);
    } catch (err) {
      log("Answer flow failed:", err);
      result = "error";
      error = String(err && err.message ? err.message : err);
    } finally {
      state.inFlight = false;
      if (runReport) {
        appendRunReport({
          ...runReport,
          result,
          error,
          duration_ms: Number((performance.now() - startedAt).toFixed(2))
        });
      }
    }
  }

  function canAttempt(signature) {
    if (state.inFlight) return { ok: false, reason: "in_flight" };

    if (state.answeredSignatures.has(signature)) {
      const hasSelectedOption = Array.from(document.querySelectorAll(CONFIG.optionSelectors.join(",")))
        .some(el => {
          if (!isVisible(el)) return false;
          const text = (el.innerText || el.textContent || "").toLowerCase();
          const html = (el.innerHTML || "");
          return text.includes("radio_button_checked") || html.includes("radio_button_checked") || el.classList.contains("selected") || el.getAttribute("aria-checked") === "true";
        });

      // Also check if the "Thanks! Press CLEAR" text is on the screen as a fallback
      const hasClearText = document.body.innerText.includes("Press CLEAR to change your answer");

      if (hasSelectedOption || hasClearText) {
        return { ok: false, reason: "already_answered" };
      }
    }

    const attempts = state.attemptsBySignature.get(signature) || 0;
    if (attempts >= CONFIG.maxAttemptsPerQuestion) return { ok: false, reason: "max_attempts" };

    const lastAttemptAt = state.lastAttemptBySignature.get(signature) || 0;
    if (Date.now() - lastAttemptAt < CONFIG.retryCooldownMs) return { ok: false, reason: "cooldown" };

    state.lastAttemptBySignature.set(signature, Date.now());
    return { ok: true, reason: "ok" };
  }

  function runScan(reason) {
    const runId = ++state.runCounter;
    const baseReport = {
      id: runId,
      reason,
      signature: "",
      question: "",
      option_count: 0
    };

    if (!CONFIG.enabled) {
      appendRunReport({ ...baseReport, result: "disabled", error: "" });
      return;
    }
    if (!hasApiConfig()) {
      warnMissingConfigOnce();
      appendRunReport({ ...baseReport, result: "missing_config", error: "" });
      return;
    }

    const snapshot = getSnapshot();
    if (!snapshot) {
      appendRunReport({ ...baseReport, result: "no_snapshot", error: "" });
      return;
    }

    const currentReport = {
      ...baseReport,
      signature: snapshot.signature,
      question: snapshot.question,
      option_count: snapshot.options.length
    };

    const attempt = canAttempt(snapshot.signature);
    if (!attempt.ok) {
      appendRunReport({
        ...currentReport,
        result: `skipped_${attempt.reason}`,
        error: ""
      });
      return;
    }

    void answerSnapshot(snapshot, reason, currentReport);
  }

  function scheduleScan(reason) {
    if (state.observerTimer) {
      window.clearTimeout(state.observerTimer);
    }
    state.observerTimer = window.setTimeout(() => runScan(reason), CONFIG.debounceMs);
  }

  function startObserver() {
    const root = document.documentElement || document.body;
    if (!root) {
      log("DOM root not ready");
      return;
    }

    state.observer = new MutationObserver(() => scheduleScan("mutation"));
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
    log("MutationObserver started");
  }

  function maskKey(key) {
    const value = String(key || "");
    if (!value) return "(empty)";
    if (value.length <= 8) return "*".repeat(value.length);
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  function showConfigSummary() {
    const summary = [
      `Endpoint: ${CONFIG.endpoint || "(empty)"}`,
      `Model: ${CONFIG.model}`,
      `Temperature: ${CONFIG.temperature}`,
      `Max Tokens: ${CONFIG.max_tokens}`,
      `Timeout(ms): ${CONFIG.timeout_ms}`,
      `Auto Submit: ${CONFIG.autoSubmit}`,
      `Submit Delay(ms): ${CONFIG.submitDelayMs}`,
      `Debug: ${CONFIG.debug}`,
      `Debug Button: ${CONFIG.debugButtonEnabled}`,
      `Run Logs: ${state.runReports.length}`,
      `API Key: ${maskKey(state.apiKey)}`
    ].join("\n");
    alert(summary);
  }

  function promptAndSetApiKey() {
    const current = state.apiKey || "";
    const next = prompt("Set API Key (stored locally via GM_setValue):", current);
    if (next === null) return;
    state.apiKey = String(next).trim();
    writeValue(STORAGE_KEYS.apiKey, state.apiKey);
    clearMissingConfigWarning();
    log(`API key updated: ${maskKey(state.apiKey)}`);
  }

  function promptAndSetEndpoint() {
    const current = CONFIG.endpoint || "";
    const next = prompt(
      "Set OpenAI-compatible endpoint (example: https://api.openai.com/v1/chat/completions):",
      current
    );
    if (next === null) return;
    CONFIG.endpoint = resolveChatCompletionsUrl(next);
    writeValue(STORAGE_KEYS.endpoint, CONFIG.endpoint);
    clearMissingConfigWarning();
    log("Endpoint updated:", CONFIG.endpoint || "(empty)");
  }

  function promptAndSetModel() {
    const current = CONFIG.model || DEFAULT_CONFIG.model;
    const next = prompt("Set model name:", current);
    if (next === null) return;
    CONFIG.model = String(next).trim() || DEFAULT_CONFIG.model;
    writeValue(STORAGE_KEYS.model, CONFIG.model);
    log("Model updated:", CONFIG.model);
  }

  function toggleAutoSubmit() {
    CONFIG.autoSubmit = !CONFIG.autoSubmit;
    writeValue(STORAGE_KEYS.autoSubmit, CONFIG.autoSubmit);
    log("Auto Submit:", CONFIG.autoSubmit);
    alert(`Auto Submit = ${CONFIG.autoSubmit}`);
  }

  function toggleDebug() {
    CONFIG.debug = !CONFIG.debug;
    writeValue(STORAGE_KEYS.debug, CONFIG.debug);
    console.log("[VevoxAuto] Debug:", CONFIG.debug);
    alert(`Debug = ${CONFIG.debug}`);
  }

  function toggleDebugButton() {
    CONFIG.debugButtonEnabled = !CONFIG.debugButtonEnabled;
    writeValue(STORAGE_KEYS.debugButtonEnabled, CONFIG.debugButtonEnabled);
    setupDebugButton();
    alert(`Debug Button = ${CONFIG.debugButtonEnabled}`);
  }

  function buildDebugPayload() {
    const snapshot = getSnapshot();
    return {
      now: new Date().toISOString(),
      page: location.href,
      config: {
        endpoint: resolveChatCompletionsUrl(CONFIG.endpoint),
        model: CONFIG.model,
        temperature: CONFIG.temperature,
        max_tokens: CONFIG.max_tokens,
        timeout_ms: CONFIG.timeout_ms,
        autoSubmit: CONFIG.autoSubmit,
        debug: CONFIG.debug,
        debugButtonEnabled: CONFIG.debugButtonEnabled
      },
      state: {
        hasApiKey: Boolean(state.apiKey),
        currentSignature: state.currentSignature,
        inFlight: state.inFlight,
        lastApiError: state.lastApiError,
        lastSnapshot: state.lastSnapshot,
        lastAiRaw: state.lastAiRaw
      },
      runReports: state.runReports,
      debugEntries: state.debugEntries,
      liveSnapshot: snapshot
        ? {
          signature: snapshot.signature,
          question: snapshot.question,
          options: snapshot.options.map((o) => o.text)
        }
        : null
    };
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  async function copyDebugReport() {
    const payload = buildDebugPayload();
    const json = JSON.stringify(payload, null, 2);
    console.log("[VevoxAuto][DebugJSON]", json);
    try {
      const copied = await copyText(json);
      if (copied) {
        alert(`Debug JSON copied. Runs: ${state.runReports.length}`);
      } else {
        prompt("Clipboard blocked. Copy debug JSON manually:", json);
      }
    } catch (err) {
      log("Copy debug JSON failed:", err);
      prompt("Copy debug JSON manually:", json);
    }
  }

  function removeDebugButton() {
    if (state.debugButtonEl && state.debugButtonEl.parentNode) {
      state.debugButtonEl.parentNode.removeChild(state.debugButtonEl);
    }
    state.debugButtonEl = null;
  }

  function setupDebugButton() {
    removeDebugButton();
    if (!CONFIG.debugButtonEnabled) return;
    if (!document.body) return;

    const btn = document.createElement("button");
    btn.id = "vevox-auto-debug-btn";
    btn.type = "button";
    btn.style.position = "fixed";
    btn.style.right = "16px";
    btn.style.bottom = "16px";
    btn.style.zIndex = "2147483647";
    btn.style.padding = "8px 12px";
    btn.style.border = "none";
    btn.style.borderRadius = "9999px";
    btn.style.background = "#111827";
    btn.style.color = "#ffffff";
    btn.style.fontSize = "12px";
    btn.style.fontWeight = "600";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 6px 20px rgba(0,0,0,0.25)";
    btn.style.opacity = "0.92";
    btn.style.maxWidth = "240px";
    btn.style.textOverflow = "ellipsis";
    btn.style.whiteSpace = "nowrap";
    btn.style.overflow = "hidden";
    btn.title = "Click to copy debug JSON for Codex. Right click to hide button.";
    btn.addEventListener("click", () => {
      void copyDebugReport();
    });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleDebugButton();
    });

    state.debugButtonEl = btn;
    updateDebugButtonLabel();
    document.body.appendChild(btn);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("Set API Key", promptAndSetApiKey);
    GM_registerMenuCommand("Set Endpoint", promptAndSetEndpoint);
    GM_registerMenuCommand("Set Model", promptAndSetModel);
    GM_registerMenuCommand("Toggle Auto Submit", toggleAutoSubmit);
    GM_registerMenuCommand("Toggle Debug", toggleDebug);
    GM_registerMenuCommand("Toggle Debug Button", toggleDebugButton);
    GM_registerMenuCommand("Show Config Summary", showConfigSummary);
    GM_registerMenuCommand("Run Self Test", runSelfTest);
    GM_registerMenuCommand("Export Debug JSON", () => {
      void copyDebugReport();
    });
  }

  async function runSelfTest() {
    const snapshot = getSnapshot();
    const report = {
      endpoint: resolveChatCompletionsUrl(CONFIG.endpoint),
      model: CONFIG.model,
      hasApiKey: Boolean(state.apiKey),
      optionCount: snapshot ? snapshot.options.length : 0,
      question: snapshot ? snapshot.question : "(none)",
      timestamp: new Date().toISOString()
    };

    log("SelfTest(base):", report);

    if (!snapshot) {
      alert("SelfTest: No detectable question/options on current page.");
      return;
    }

    if (!hasApiConfig()) {
      alert("SelfTest: Missing endpoint or API key.");
      return;
    }

    try {
      const aiRaw = await callAI(snapshot);
      state.lastAiRaw = aiRaw;
      log("SelfTest(API) OK:", aiRaw);
      alert("SelfTest: API call succeeded. Check console for AI raw output.");
    } catch (err) {
      log("SelfTest(API) failed:", err, state.lastApiError);
      alert("SelfTest: API call failed. Use 'Export Debug JSON' and send it to me.");
    }
  }

  function exportDebugJson() {
    const json = JSON.stringify(buildDebugPayload(), null, 2);
    console.log("[VevoxAuto][DebugJSON]", json);
    prompt("Copy this debug JSON and send it to Codex:", json);
  }

  function bootstrap() {
    normalizeLoadedEndpoint();
    registerMenuCommands();
    setupDebugButton();
    startObserver();
    runScan("initial");
    window.setInterval(() => runScan("interval"), CONFIG.scanIntervalMs);

    const publicApi = {
      CONFIG,
      state,
      runScan,
      runSelfTest,
      copyDebugReport,
      exportDebugJson,
      setApiKey: promptAndSetApiKey,
      setEndpoint: promptAndSetEndpoint,
      setModel: promptAndSetModel,
      toggleDebugButton,
      showConfigSummary,
      stop: () => {
        CONFIG.enabled = false;
        if (state.observer) {
          state.observer.disconnect();
        }
      },
      start: () => {
        if (!CONFIG.enabled) {
          CONFIG.enabled = true;
        }
        if (!state.observer) {
          startObserver();
        }
      }
    };
    window.VEVOX_AUTO = publicApi;
    if (typeof unsafeWindow !== "undefined") {
      unsafeWindow.VEVOX_AUTO = publicApi;
    }

    log("Bootstrapped in", Date.now() - state.startedAt, "ms");
  }

  bootstrap();
})();
