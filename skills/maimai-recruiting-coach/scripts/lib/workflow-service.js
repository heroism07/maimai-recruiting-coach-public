import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompliantWorkflow, resolveSelector } from "./compliance.js";
import { matchWorkflow } from "./matcher.js";
import { HumanPacingController } from "./pacing.js";
import {
  appendRunLog,
  ensureDataFiles,
  loadMemory,
  saveMemory
} from "./storage.js";
import { createEmptyMemoryStore, normalizeWorkflowDraft } from "./schemas.js";
import { buildWorkflowId, hashObject, isoNow, makeRunId } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultMemoryPath = resolve(__dirname, "../../../../data/maimai-flow-memory.json");
const defaultRunsPath = resolve(__dirname, "../../../../data/maimai-flow-runs.ndjson");

function evaluateSuccess(criteria, runStepLogs, runSignals, finalStatus) {
  const failedSteps = runStepLogs.filter((item) => !item.ok).length;
  const requiredSignals = criteria.required_signals ?? [];
  const allRequiredSignalPresent = requiredSignals.every((signal) => runSignals.includes(signal));
  const maxFailures = criteria.max_step_failures ?? 0;
  return finalStatus === "completed" && allRequiredSignalPresent && failedSteps <= maxFailures;
}

function patchMetrics(workflow, success, now) {
  const metrics = workflow.metrics ?? {};
  const totalRuns = (metrics.total_runs ?? 0) + 1;
  const successCountBefore = Math.round((metrics.success_rate ?? 0) * (metrics.total_runs ?? 0));
  const successCountAfter = success ? successCountBefore + 1 : successCountBefore;
  return {
    success_rate: totalRuns === 0 ? 0 : successCountAfter / totalRuns,
    last_success_at: success ? now : metrics.last_success_at ?? null,
    consecutive_failures: success ? 0 : (metrics.consecutive_failures ?? 0) + 1,
    total_runs: totalRuns
  };
}

function findCandidatesByIdentity(memory, draft) {
  const draftHash = draft.page_signature?.hash ?? hashObject(draft.page_signature ?? {});
  return memory.workflows.filter((item) => {
    const itemHash = item.page_signature?.hash ?? hashObject(item.page_signature ?? {});
    return (
      item.job_family === draft.job_family &&
      item.task_type === draft.task_type &&
      itemHash === draftHash
    );
  });
}

export class WorkflowService {
  constructor(options = {}) {
    this.memoryPath = options.memoryPath ?? defaultMemoryPath;
    this.runsPath = options.runsPath ?? defaultRunsPath;
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleepFn;
    this.skipSleep = Boolean(options.skipSleep);
  }

  async init() {
    await ensureDataFiles(this.memoryPath, this.runsPath);
  }

  async execute(input, adapter) {
    await this.init();

    if (!adapter || typeof adapter.executeStep !== "function") {
      throw new Error("adapter.executeStep 缺失，无法执行流程。");
    }

    const runId = makeRunId();
    const now = isoNow();
    const memory = await loadMemory(this.memoryPath);
    const pageContext = input.pageContext ?? (await adapter.getPageContext?.()) ?? {};

    const match = matchWorkflow(memory, {
      jobFamily: input.jobFamily,
      taskType: input.taskType,
      pageContext
    });

    if (!match.workflow) {
      let draftWorkflow = null;
      if (typeof adapter.captureLearningDraft === "function") {
        const learned = await adapter.captureLearningDraft({
          job_family: input.jobFamily,
          task_type: input.taskType,
          page_context: pageContext
        });
        if (learned) {
          draftWorkflow = this.createDraftWorkflow({
            ...learned,
            job_family: learned.job_family ?? input.jobFamily,
            task_type: learned.task_type ?? input.taskType,
            page_signature: learned.page_signature ?? {}
          });
        }
      }

      const runEntry = {
        run_id: runId,
        timestamp: now,
        mode: "learn",
        result: "needs_learning",
        reason: match.reason,
        job_family: input.jobFamily,
        task_type: input.taskType,
        page_context: pageContext,
        has_draft: Boolean(draftWorkflow)
      };
      await appendRunLog(this.runsPath, runEntry);
      return {
        runId,
        mode: "learn",
        result: "needs_learning",
        reason: match.reason,
        draftWorkflow
      };
    }

    const workflow = match.workflow;
    assertCompliantWorkflow(workflow);

    const pacing = new HumanPacingController(workflow.human_pacing, {
      random: this.random,
      sleepFn: this.sleepFn,
      skipSleep: this.skipSleep
    });

    const stepLogs = [];
    const signals = [];
    let finalStatus = "completed";
    let sentCount = 0;
    let stopReason = null;

    for (const step of workflow.steps) {
      if (step.action === "send_greeting" && !pacing.canRunNext(sentCount)) {
        finalStatus = "stopped";
        stopReason = "batch_limit_reached";
        break;
      }

      if (
        step.action === "send_greeting" &&
        workflow.safety?.require_manual_confirm_before_send !== false &&
        !input.manualSendConfirm
      ) {
        finalStatus = "paused";
        stopReason = "manual_confirm_required";
        break;
      }

      await pacing.waitPageStable();
      const delay = await pacing.waitHumanDelay();
      const selectorBundle = resolveSelector(workflow.selectors, step.selector_key);
      const stepResult = await adapter.executeStep(step, {
        selectorBundle,
        workflowId: workflow.workflow_id,
        delayMs: delay
      });

      const normalizedResult = {
        step_id: step.id ?? null,
        action: step.action,
        ok: Boolean(stepResult?.ok),
        detail: stepResult?.detail ?? "",
        signal: stepResult?.signal ?? null,
        used_fallback: false
      };

      if (normalizedResult.signal) {
        signals.push(normalizedResult.signal);
      }

      if (!normalizedResult.ok && step.fallback_action) {
        const fallbackResult = await adapter.executeStep(
          {
            ...step,
            action: step.fallback_action
          },
          {
            selectorBundle,
            workflowId: workflow.workflow_id,
            isFallback: true
          }
        );
        normalizedResult.used_fallback = true;
        normalizedResult.fallback_ok = Boolean(fallbackResult?.ok);
        normalizedResult.fallback_detail = fallbackResult?.detail ?? "";
        normalizedResult.fallback_signal = fallbackResult?.signal ?? null;
        if (normalizedResult.fallback_signal) {
          signals.push(normalizedResult.fallback_signal);
        }
        normalizedResult.ok = normalizedResult.fallback_ok;
      }

      stepLogs.push(normalizedResult);

      if (!normalizedResult.ok) {
        finalStatus = "failed";
        stopReason = "step_failed";
        break;
      }

      if (step.action === "send_greeting") {
        sentCount += 1;
      }

      const riskSignal = await adapter.consumeRiskSignal?.();
      if (riskSignal) {
        finalStatus = "stopped";
        stopReason = `risk_event:${riskSignal}`;
        break;
      }
    }

    const success = evaluateSuccess(workflow.success_criteria ?? {}, stepLogs, signals, finalStatus);
    const workflowIndex = memory.workflows.findIndex(
      (item) =>
        item.workflow_id === workflow.workflow_id &&
        item.version === workflow.version &&
        item.status === workflow.status
    );

    if (workflowIndex >= 0) {
      memory.workflows[workflowIndex] = {
        ...memory.workflows[workflowIndex],
        metrics: patchMetrics(memory.workflows[workflowIndex], success, now),
        updated_at: now
      };
      memory.updated_at = now;
      await saveMemory(this.memoryPath, memory);
    }

    const runEntry = {
      run_id: runId,
      timestamp: now,
      mode: "execute",
      result: success ? "success" : "not_success",
      final_status: finalStatus,
      stop_reason: stopReason,
      job_family: input.jobFamily,
      task_type: input.taskType,
      workflow_id: workflow.workflow_id,
      workflow_version: workflow.version,
      match_level: match.level,
      page_context: pageContext,
      step_logs: stepLogs,
      signals
    };
    await appendRunLog(this.runsPath, runEntry);

    return {
      runId,
      mode: "execute",
      workflowId: workflow.workflow_id,
      workflowVersion: workflow.version,
      matchLevel: match.level,
      success,
      finalStatus,
      stopReason,
      signals,
      stepLogs
    };
  }

  createDraftWorkflow(input) {
    const now = isoNow();
    const signature = {
      ...(input.page_signature ?? {})
    };
    if (!signature.hash) {
      signature.hash = hashObject(signature);
    }

    const draft = normalizeWorkflowDraft(
      {
        workflow_id: input.workflow_id ?? buildWorkflowId(input.job_family, input.task_type, signature),
        version: 0,
        status: "draft",
        job_family: input.job_family,
        task_type: input.task_type,
        page_signature: signature,
        steps: input.steps,
        selectors: input.selectors,
        human_pacing: input.human_pacing,
        success_criteria: input.success_criteria,
        metrics: {
          success_rate: 0,
          last_success_at: null,
          consecutive_failures: 0,
          total_runs: 0
        },
        safety: input.safety
      },
      now
    );
    assertCompliantWorkflow(draft);
    return draft;
  }

  async promoteDraft(input) {
    await this.init();
    if (!input.approvedBy || String(input.approvedBy).trim() === "") {
      throw new Error("入库必须提供 approvedBy（人工确认人）。");
    }

    const now = isoNow();
    const memory = await loadMemory(this.memoryPath);
    const draft = normalizeWorkflowDraft(input.draftWorkflow, now);
    assertCompliantWorkflow(draft);

    const candidates = findCandidatesByIdentity(memory, draft);
    const nextVersion =
      candidates.length === 0 ? 1 : Math.max(...candidates.map((item) => item.version ?? 0)) + 1;

    for (const item of memory.workflows) {
      if (candidates.includes(item) && item.status === "active") {
        item.status = "deprecated";
        item.updated_at = now;
      }
    }

    const promoted = {
      ...draft,
      version: nextVersion,
      status: "active",
      created_at: now,
      updated_at: now
    };
    memory.workflows.push(promoted);
    memory.updated_at = now;
    await saveMemory(this.memoryPath, memory);

    await appendRunLog(this.runsPath, {
      run_id: makeRunId(),
      timestamp: now,
      mode: "promote",
      result: "approved",
      approved_by: input.approvedBy,
      approval_note: input.approvalNote ?? "",
      workflow_id: promoted.workflow_id,
      workflow_version: promoted.version,
      job_family: promoted.job_family,
      task_type: promoted.task_type
    });

    return promoted;
  }

  async resetMemory() {
    const now = isoNow();
    const empty = createEmptyMemoryStore(now);
    await saveMemory(this.memoryPath, empty);
  }
}
