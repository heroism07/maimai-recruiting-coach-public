import { wildcardToRegExp } from "./utils.js";

function normalizeText(input) {
  return String(input ?? "").toLowerCase();
}

function hasAllTokens(container, tokens) {
  const source = normalizeText(container);
  return tokens.every((token) => source.includes(normalizeText(token)));
}

function hasAllMarkers(contextMarkers, requiredMarkers) {
  const markerSet = new Set((contextMarkers ?? []).map((item) => String(item).trim()));
  return requiredMarkers.every((marker) => markerSet.has(String(marker).trim()));
}

export function signatureMatches(pageSignature, pageContext) {
  if (!pageSignature || Object.keys(pageSignature).length === 0) {
    return true;
  }

  if (pageSignature.hash && pageContext?.hash && pageSignature.hash !== pageContext.hash) {
    return false;
  }

  if (pageSignature.url_pattern) {
    const reg = wildcardToRegExp(pageSignature.url_pattern);
    if (!reg.test(pageContext?.url ?? "")) {
      return false;
    }
  }

  if (Array.isArray(pageSignature.required_text) && pageSignature.required_text.length > 0) {
    if (!hasAllTokens(pageContext?.visible_text ?? "", pageSignature.required_text)) {
      return false;
    }
  }

  if (Array.isArray(pageSignature.dom_markers) && pageSignature.dom_markers.length > 0) {
    if (!hasAllMarkers(pageContext?.dom_markers ?? [], pageSignature.dom_markers)) {
      return false;
    }
  }

  return true;
}

function sortByPriority(workflows) {
  return [...workflows].sort((a, b) => {
    if ((b.version ?? 0) !== (a.version ?? 0)) {
      return (b.version ?? 0) - (a.version ?? 0);
    }
    if ((b.metrics?.success_rate ?? 0) !== (a.metrics?.success_rate ?? 0)) {
      return (b.metrics?.success_rate ?? 0) - (a.metrics?.success_rate ?? 0);
    }
    return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
  });
}

export function matchWorkflow(memory, query) {
  const candidates = memory.workflows.filter((workflow) => {
    return (
      workflow.status === "active" &&
      workflow.job_family === query.jobFamily &&
      workflow.task_type === query.taskType
    );
  });

  if (candidates.length === 0) {
    return { workflow: null, level: "none", reason: "no_job_task_match" };
  }

  const primaryMatches = candidates.filter((workflow) =>
    signatureMatches(workflow.page_signature, query.pageContext)
  );

  if (primaryMatches.length > 0) {
    return {
      workflow: sortByPriority(primaryMatches)[0],
      level: "primary",
      reason: "job_task_signature_match"
    };
  }

  return {
    workflow: sortByPriority(candidates)[0],
    level: "secondary",
    reason: "job_task_fallback_match"
  };
}
