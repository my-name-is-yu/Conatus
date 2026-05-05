import type { AutomationFailureCode } from "./types.js";

export interface ClassifiedAutomationFailure {
  failureCode: AutomationFailureCode;
  authRequired: boolean;
  retryable: boolean;
}

export function classifyAutomationFailure(params: {
  status?: number;
  failureCode?: AutomationFailureCode;
}): ClassifiedAutomationFailure {
  if (params.failureCode) {
    return {
      failureCode: params.failureCode,
      authRequired: params.failureCode === "auth_required" || params.failureCode === "auth_expired",
      retryable: isRetryable(params.failureCode),
    };
  }

  const status = params.status ?? 0;
  if (status === 401) {
    return { failureCode: "auth_required", authRequired: true, retryable: false };
  }
  if (status === 403) {
    return { failureCode: "permission_denied", authRequired: false, retryable: false };
  }
  if (status === 429) {
    return { failureCode: "rate_limited", authRequired: false, retryable: true };
  }
  if (status >= 500 && status <= 599) {
    return { failureCode: "provider_unavailable", authRequired: false, retryable: true };
  }

  return { failureCode: "unknown_automation_error", authRequired: false, retryable: true };
}

function isRetryable(code: AutomationFailureCode): boolean {
  return code === "rate_limited"
    || code === "provider_unavailable"
    || code === "site_blocked"
    || code === "navigation_failed"
    || code === "unknown_automation_error";
}
