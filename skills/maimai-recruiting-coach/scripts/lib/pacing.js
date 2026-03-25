import { sleep } from "./utils.js";

export class HumanPacingController {
  constructor(config, options = {}) {
    this.config = {
      min_delay_ms: 2000,
      max_delay_ms: 5500,
      jitter_ratio: 0.2,
      max_batch_per_session: 20,
      page_stable_wait_ms: 1200,
      ...(config ?? {})
    };
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleepFn ?? sleep;
    this.skipSleep = Boolean(options.skipSleep);
  }

  canRunNext(sentCount) {
    return sentCount < this.config.max_batch_per_session;
  }

  nextDelayMs() {
    const min = this.config.min_delay_ms;
    const max = this.config.max_delay_ms;
    const base = min + Math.floor(this.random() * (Math.max(max - min, 0) + 1));
    const jitter = Math.floor(base * this.config.jitter_ratio * this.random());
    return base + jitter;
  }

  async waitPageStable() {
    if (this.skipSleep) {
      return;
    }
    await this.sleepFn(this.config.page_stable_wait_ms);
  }

  async waitHumanDelay() {
    if (this.skipSleep) {
      return 0;
    }
    const delay = this.nextDelayMs();
    await this.sleepFn(delay);
    return delay;
  }
}
