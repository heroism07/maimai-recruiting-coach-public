export class MockAdapter {
  constructor(options = {}) {
    this.pageContext = options.pageContext ?? {};
    this.stepQueues = new Map();
    this.riskSignals = [...(options.riskSignals ?? [])];

    const outcomes = options.stepOutcomes ?? {};
    for (const [action, value] of Object.entries(outcomes)) {
      const queue = Array.isArray(value) ? [...value] : [value];
      this.stepQueues.set(action, queue);
    }
    this.learningDraft = options.learningDraft ?? null;
  }

  async getPageContext() {
    return this.pageContext;
  }

  async executeStep(step) {
    const queue = this.stepQueues.get(step.action) ?? [];
    const next = queue.length > 0 ? queue.shift() : null;
    this.stepQueues.set(step.action, queue);

    if (!next) {
      return {
        ok: true,
        signal: `${step.action}_ok`,
        detail: "mock default success"
      };
    }

    return {
      ok: Boolean(next.ok),
      signal: next.signal ?? null,
      detail: next.detail ?? ""
    };
  }

  async consumeRiskSignal() {
    if (this.riskSignals.length === 0) {
      return null;
    }
    return this.riskSignals.shift();
  }

  async captureLearningDraft() {
    return this.learningDraft;
  }
}
