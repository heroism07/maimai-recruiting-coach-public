const RISK_KEYWORDS = ["验证码", "访问受限", "账号异常", "操作过于频繁", "稍后再试"];
const DEFAULT_ALLOWED_HOST_SUFFIXES = ["maimai.cn"];
const DEFAULT_LEARNING_WAIT_MS = 20000;
const MAX_LEARNING_EVENTS = 240;
const DEFAULT_HUMAN_MIN_DELAY_MS = 380;
const DEFAULT_HUMAN_MAX_DELAY_MS = 1350;
const DEFAULT_HUMAN_MAX_ACTIONS_PER_MIN = 24;

function isAllowedMaimaiUrl(url, allowedHostSuffixes) {
  try {
    const parsed = new URL(url);
    const host = (parsed.hostname ?? "").toLowerCase();
    if (!host) {
      return false;
    }
    return allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export class PlaywrightRecruitingAdapter {
  constructor(page, options = {}) {
    this.page = page;
    this.listUrl = options.listUrl ?? "";
    this.contextMarkers = options.contextMarkers ?? [];
    this.allowedHostSuffixes =
      Array.isArray(options.allowedHostSuffixes) && options.allowedHostSuffixes.length > 0
        ? options.allowedHostSuffixes.map((item) => String(item).toLowerCase())
        : DEFAULT_ALLOWED_HOST_SUFFIXES;
    this.learningMode = options.learningMode !== false;
    this.learningWaitMs = Number(options.learningWaitMs ?? DEFAULT_LEARNING_WAIT_MS);
    this.learningSelectorHints =
      options.learningSelectorHints && typeof options.learningSelectorHints === "object"
        ? options.learningSelectorHints
        : {};
    this.learningRecorderInstalled = false;
    this.humanize = options.humanize !== false;
    this.humanMinDelayMs = Number(options.humanMinDelayMs ?? DEFAULT_HUMAN_MIN_DELAY_MS);
    this.humanMaxDelayMs = Number(options.humanMaxDelayMs ?? DEFAULT_HUMAN_MAX_DELAY_MS);
    this.maxActionsPerMin = Number(options.maxActionsPerMin ?? DEFAULT_HUMAN_MAX_ACTIONS_PER_MIN);
    this.actionTimestamps = [];
  }

  randomBetween(min, max) {
    const lower = Math.max(0, Number(min ?? 0));
    const upper = Math.max(lower, Number(max ?? lower));
    return Math.round(lower + Math.random() * (upper - lower));
  }

  async pauseForHumanPacing(extraDelayMs = 0) {
    if (!this.humanize) {
      if (Number.isFinite(extraDelayMs) && extraDelayMs > 0) {
        await this.page.waitForTimeout(extraDelayMs);
      }
      return;
    }
    const now = Date.now();
    this.actionTimestamps = this.actionTimestamps.filter((ts) => now - ts < 60_000);
    if (Number.isFinite(this.maxActionsPerMin) && this.maxActionsPerMin > 0) {
      if (this.actionTimestamps.length >= this.maxActionsPerMin) {
        const oldest = this.actionTimestamps[0];
        const waitMs = Math.max(600, 60_000 - (now - oldest) + this.randomBetween(120, 520));
        await this.page.waitForTimeout(waitMs);
      }
    }
    const waitMs = this.randomBetween(this.humanMinDelayMs, this.humanMaxDelayMs);
    const extra = Number.isFinite(extraDelayMs) && extraDelayMs > 0 ? extraDelayMs : 0;
    await this.page.waitForTimeout(waitMs + extra);
    this.actionTimestamps.push(Date.now());
  }

  async typeHumanized(locator, text) {
    await locator.click({ timeout: 5000 });
    try {
      await locator.press("Control+A");
      await locator.press("Backspace");
    } catch {
      // 输入框不支持快捷键时忽略
    }
    const value = String(text ?? "");
    if (!value) {
      return;
    }
    const delay = this.humanize ? this.randomBetween(42, 130) : 0;
    await locator.type(value, { delay });
  }

  assertPageInScope(actionName = "unknown_action") {
    const currentUrl = this.page.url();
    if (!currentUrl || currentUrl.startsWith("about:blank")) {
      return;
    }
    if (!isAllowedMaimaiUrl(currentUrl, this.allowedHostSuffixes)) {
      throw new Error(
        `仅允许接管脉脉页面，当前页面不在白名单内：${currentUrl}（动作 ${actionName} 已阻止）`
      );
    }
  }

  assertTargetUrlInScope(targetUrl) {
    if (!isAllowedMaimaiUrl(targetUrl, this.allowedHostSuffixes)) {
      throw new Error(`仅允许打开脉脉页面，已阻止非白名单地址：${targetUrl}`);
    }
  }

  async getPageContext() {
    this.assertPageInScope("getPageContext");
    const url = this.page.url();
    const visibleText = await this.page.locator("body").innerText();
    const domMarkers = [];
    for (const marker of this.contextMarkers) {
      const count = await this.page.locator(marker).count();
      if (count > 0) {
        domMarkers.push(marker);
      }
    }
    return {
      url,
      visible_text: visibleText,
      dom_markers: domMarkers
    };
  }

  async executeStep(step, executionContext = {}) {
    try {
      if (step.action !== "open_page") {
        this.assertPageInScope(step.action);
      }
      switch (step.action) {
        case "open_page":
          await this.handleOpenPage(step);
          return { ok: true, signal: "open_page_ok", detail: "page opened" };
        case "wait_for_stable":
          await this.page.waitForLoadState("networkidle", { timeout: 15000 });
          return { ok: true, signal: "wait_for_stable_ok", detail: "network idle" };
        case "apply_filter":
          await this.handleClickOrFill(step, executionContext.selectorBundle);
          return { ok: true, signal: "filter_applied", detail: "filter applied" };
        case "apply_filter_bundle":
          await this.handleApplyFilterBundle(step);
          return { ok: true, signal: "filter_bundle_applied", detail: "filter bundle applied" };
        case "capture_filter_summary": {
          const captured = await this.handleCaptureFilterSummary(step);
          return {
            ok: true,
            signal: "filter_summary_captured",
            detail: JSON.stringify(captured)
          };
        }
        case "scroll_candidates":
          await this.page.mouse.wheel(0, Number(step.scroll_delta ?? 800));
          return { ok: true, signal: "scroll_ok", detail: "scrolled" };
        case "open_profile":
          await this.handleClickOrFill(step, executionContext.selectorBundle);
          return { ok: true, signal: "profile_opened", detail: "profile opened" };
        case "send_greeting":
          await this.handleClickOrFill(step, executionContext.selectorBundle);
          return { ok: true, signal: "greeting_sent", detail: "greeting sent" };
        case "back_to_list":
          await this.page.goBack({ waitUntil: "domcontentloaded" });
          return { ok: true, signal: "back_to_list_ok", detail: "returned to list" };
        case "refresh_page":
          await this.page.reload({ waitUntil: "domcontentloaded" });
          return { ok: true, signal: "refresh_ok", detail: "page refreshed" };
        default:
          return { ok: false, signal: null, detail: `unsupported action: ${step.action}` };
      }
    } catch (error) {
      return {
        ok: false,
        signal: null,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async consumeRiskSignal() {
    this.assertPageInScope("consumeRiskSignal");
    const bodyText = await this.page.locator("body").innerText();
    const hit = RISK_KEYWORDS.find((keyword) => bodyText.includes(keyword));
    return hit ?? null;
  }

  async ensureLearningRecorder() {
    if (this.learningRecorderInstalled) {
      return;
    }
    this.assertPageInScope("ensureLearningRecorder");
    await this.page.evaluate((maxEvents) => {
      if (window.__maimaiLearningRecorder?.installed) {
        return;
      }
      function toShortText(value) {
        return String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      }
      function buildSelector(element) {
        if (!element || element.nodeType !== 1) {
          return "";
        }
        const testId = element.getAttribute("data-testid");
        if (testId) {
          return `[data-testid="${testId}"]`;
        }
        const name = element.getAttribute("name");
        if (name) {
          return `[name="${name}"]`;
        }
        if (element.id && !/\d{4,}/.test(element.id)) {
          return `#${element.id}`;
        }
        const classes = (element.className || "")
          .split(/\s+/)
          .map((item) => item.trim())
          .filter((item) => item && !/\d{3,}/.test(item))
          .slice(0, 2);
        const tag = (element.tagName || "div").toLowerCase();
        if (classes.length > 0) {
          return `${tag}.${classes.join(".")}`;
        }
        return tag;
      }
      function pushEvent(event) {
        if (!window.__maimaiLearningRecorder) {
          return;
        }
        const item = {
          at: new Date().toISOString(),
          page_url: location.href,
          ...event
        };
        const queue = window.__maimaiLearningRecorder.events;
        queue.push(item);
        if (queue.length > maxEvents) {
          queue.splice(0, queue.length - maxEvents);
        }
      }
      window.__maimaiLearningRecorder = {
        installed: true,
        events: []
      };
      document.addEventListener(
        "click",
        (e) => {
          const target = e.target;
          if (!(target instanceof Element)) {
            return;
          }
          pushEvent({
            type: "click",
            selector: buildSelector(target),
            text: toShortText(target.textContent),
            value: ""
          });
        },
        true
      );
      document.addEventListener(
        "input",
        (e) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            return;
          }
          pushEvent({
            type: "input",
            selector: buildSelector(target),
            text: toShortText(target.placeholder || target.getAttribute("aria-label") || ""),
            value: toShortText(target.value)
          });
        },
        true
      );
      document.addEventListener(
        "change",
        (e) => {
          const target = e.target;
          if (!(target instanceof Element)) {
            return;
          }
          const value =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement
              ? target.value
              : "";
          pushEvent({
            type: "change",
            selector: buildSelector(target),
            text: toShortText(target.textContent || target.getAttribute("aria-label") || ""),
            value: toShortText(value)
          });
        },
        true
      );
    }, MAX_LEARNING_EVENTS);
    this.learningRecorderInstalled = true;
  }

  pickSelectorByKeyword(events, keywordRegex, fallbackValue = "") {
    const matched = [...events]
      .reverse()
      .find((item) => keywordRegex.test(String(item.text || "")) && String(item.selector || "").trim());
    if (matched?.selector) {
      return matched.selector;
    }
    return fallbackValue;
  }

  extractFilterOperations(events) {
    const outputs = [];
    for (const event of events) {
      const selector = String(event.selector ?? "").trim();
      if (!selector) {
        continue;
      }
      if (!["input", "change"].includes(String(event.type))) {
        continue;
      }
      const value = String(event.value ?? "").trim();
      if (!value) {
        continue;
      }
      const exists = outputs.find((item) => item.selector === selector && item.input_text === value);
      if (exists) {
        continue;
      }
      outputs.push({
        selector,
        mode: "fill",
        input_text: value,
        wait_ms: 180
      });
    }
    return outputs.slice(-8);
  }

  buildLearningDraftFromEvents(input = {}, pageContext = {}, events = []) {
    const listSelector =
      String(this.learningSelectorHints.candidate_list || "").trim() ||
      this.pickSelectorByKeyword(events, /候选|人才|列表|简历/) ||
      "[data-testid='candidate-list']";
    const greetSelector =
      String(this.learningSelectorHints.greet_button || "").trim() ||
      this.pickSelectorByKeyword(events, /招呼|沟通|联系|邀约/) ||
      "[data-testid='greet-btn']";
    const filterOps = this.extractFilterOperations(events);

    const selectors = [
      {
        key: "candidate_list",
        primary: listSelector,
        fallbacks: [".candidate-list", ".resume-list", ".candidate-card-list"]
      },
      {
        key: "greet_button",
        primary: greetSelector,
        fallbacks: [".greet-btn", "button:has-text('打招呼')"]
      }
    ];

    const steps = [
      {
        id: "s1",
        action: "open_page",
        selector_key: "candidate_list",
        url: pageContext.url || this.listUrl || ""
      },
      {
        id: "s2",
        action: "wait_for_stable",
        selector_key: "candidate_list"
      }
    ];
    if (filterOps.length > 0) {
      steps.push({
        id: "s3",
        action: "apply_filter_bundle",
        selector_key: "candidate_list",
        operations: filterOps
      });
    }
    steps.push(
      {
        id: "s4",
        action: "open_profile",
        selector_key: "candidate_list"
      },
      {
        id: "s5",
        action: "send_greeting",
        selector_key: "greet_button"
      }
    );

    const currentUrl = String(pageContext.url || this.listUrl || "https://maimai.cn/recruiter/candidates");
    const currentPath = (() => {
      try {
        const parsed = new URL(currentUrl);
        return `${parsed.origin}${parsed.pathname}*`;
      } catch {
        return "https://maimai.cn/recruiter/*";
      }
    })();

    const visibleText = String(pageContext.visible_text || "");
    const requiredText = ["候选", "筛选", "招呼"].filter((item) => visibleText.includes(item));
    return {
      job_family: String(input.job_family || input.jobFamily || "generic"),
      task_type: String(input.task_type || input.taskType || "greeting"),
      page_signature: {
        url_pattern: currentPath,
        required_text: requiredText.length > 0 ? requiredText : ["候选人"],
        dom_markers: Array.isArray(pageContext.dom_markers) ? pageContext.dom_markers.slice(0, 6) : []
      },
      selectors,
      steps,
      human_pacing: {
        min_delay_ms: 1800,
        max_delay_ms: 4600,
        jitter_ratio: 0.2,
        max_batch_per_session: 20,
        page_stable_wait_ms: 1000
      },
      success_criteria: {
        required_signals: ["greeting_sent"],
        max_step_failures: 0
      },
      safety: {
        require_manual_confirm_before_send: true
      }
    };
  }

  async captureLearningDraft(input = {}) {
    if (!this.learningMode) {
      return null;
    }
    this.assertPageInScope("captureLearningDraft");
    await this.ensureLearningRecorder();
    if (Number.isFinite(this.learningWaitMs) && this.learningWaitMs > 0) {
      await this.page.waitForTimeout(this.learningWaitMs);
    }
    const pageContext = await this.getPageContext();
    const recorderData = await this.page.evaluate(() => {
      const store = window.__maimaiLearningRecorder;
      if (!store || !Array.isArray(store.events)) {
        return [];
      }
      return store.events.slice(-120);
    });
    return this.buildLearningDraftFromEvents(input, pageContext, Array.isArray(recorderData) ? recorderData : []);
  }

  async handleOpenPage(step) {
    const target = step.url ?? this.listUrl;
    if (!target) {
      throw new Error("open_page 缺少目标 URL。");
    }
    this.assertTargetUrlInScope(target);
    await this.page.goto(target, { waitUntil: "domcontentloaded" });
  }

  async handleClickOrFill(step, selectorBundle) {
    const selectors = [];
    if (selectorBundle?.primary) {
      selectors.push(selectorBundle.primary);
    }
    if (Array.isArray(selectorBundle?.fallbacks)) {
      selectors.push(...selectorBundle.fallbacks);
    }
    if (step.selector_override) {
      selectors.unshift(step.selector_override);
    }
    if (selectors.length === 0) {
      throw new Error(`步骤 ${step.id ?? ""} 缺少可用选择器。`);
    }

    let lastError = null;
    for (const selector of selectors) {
      try {
        const locator = this.page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: 3000 });
        await this.pauseForHumanPacing();
        if (step.input_text) {
          await this.typeHumanized(locator, step.input_text);
        } else {
          await locator.click({ timeout: 5000 });
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("未找到可点击/可填写元素。");
  }

  async handleApplyFilterBundle(step) {
    const operations = Array.isArray(step.operations) ? step.operations : [];
    if (operations.length === 0) {
      throw new Error("apply_filter_bundle 需要 step.operations");
    }

    for (const operation of operations) {
      const selector = String(operation.selector ?? "").trim();
      if (!selector) {
        continue;
      }
      const mode = String(operation.mode ?? "").trim();
      const text = String(operation.input_text ?? "").trim();
      const waitMs = Number(operation.wait_ms ?? 0);
      const locator = this.page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 5000 });
      await this.pauseForHumanPacing();
      if (mode === "fill") {
        await this.typeHumanized(locator, text);
      } else if (mode === "type") {
        await locator.type(text, { delay: this.humanize ? this.randomBetween(45, 120) : 0 });
      } else {
        await locator.click({ timeout: 5000 });
      }
      await this.pauseForHumanPacing(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0);
    }
  }

  async handleCaptureFilterSummary(step) {
    const selectors = Array.isArray(step.capture_selectors) ? step.capture_selectors : [];
    if (selectors.length === 0) {
      return [];
    }

    const output = [];
    for (const selector of selectors) {
      const locator = this.page.locator(selector);
      const count = await locator.count();
      if (count === 0) {
        continue;
      }
      const texts = await locator.allInnerTexts();
      output.push({
        selector,
        texts: texts.map((text) => text.trim()).filter(Boolean)
      });
    }
    return output;
  }
}
