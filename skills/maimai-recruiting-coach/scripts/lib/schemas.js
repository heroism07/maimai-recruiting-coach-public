export const MEMORY_SCHEMA_VERSION = 1;

export const DEFAULT_HUMAN_PACING = {
  min_delay_ms: 2000,
  max_delay_ms: 5500,
  jitter_ratio: 0.2,
  max_batch_per_session: 20,
  page_stable_wait_ms: 1200
};

export const DEFAULT_SUCCESS_CRITERIA = {
  required_signals: ["greeting_sent"],
  max_step_failures: 0
};

export function createEmptyMemoryStore(now = new Date().toISOString()) {
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    updated_at: now,
    workflows: []
  };
}

export function ensureArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`字段 ${fieldName} 必须是数组。`);
  }
}

export function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`字段 ${fieldName} 必须是非空字符串。`);
  }
}

export function normalizeWorkflowDraft(draft, now = new Date().toISOString()) {
  ensureString(draft.workflow_id, "workflow_id");
  ensureString(draft.job_family, "job_family");
  ensureString(draft.task_type, "task_type");
  ensureArray(draft.steps, "steps");
  ensureArray(draft.selectors, "selectors");

  const humanPacing = {
    ...DEFAULT_HUMAN_PACING,
    ...(draft.human_pacing ?? {})
  };

  const successCriteria = {
    ...DEFAULT_SUCCESS_CRITERIA,
    ...(draft.success_criteria ?? {})
  };

  return {
    workflow_id: draft.workflow_id,
    version: Number.isInteger(draft.version) ? draft.version : 1,
    status: draft.status ?? "draft",
    job_family: draft.job_family,
    task_type: draft.task_type,
    page_signature: draft.page_signature ?? {},
    steps: draft.steps,
    selectors: draft.selectors,
    human_pacing: humanPacing,
    success_criteria: successCriteria,
    metrics: {
      success_rate: 0,
      last_success_at: null,
      consecutive_failures: 0,
      total_runs: 0,
      ...(draft.metrics ?? {})
    },
    safety: {
      require_manual_confirm_before_send: true,
      ...(draft.safety ?? {})
    },
    created_at: draft.created_at ?? now,
    updated_at: draft.updated_at ?? now
  };
}
