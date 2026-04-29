import type { AutomationFailureCode } from "./types.js";

export interface ClassifiedAutomationFailure {
  failureCode: AutomationFailureCode;
  authRequired: boolean;
  retryable: boolean;
}

export function classifyAutomationFailure(params: {
  status?: number;
  error?: string;
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

  const error = (params.error ?? "").toLowerCase();
  if (error.includes("login") || error.includes("sign in") || error.includes("authenticate")) {
    return { failureCode: "auth_required", authRequired: true, retryable: false };
  }
  if (error.includes("expired") && (error.includes("session") || error.includes("auth"))) {
    return { failureCode: "auth_expired", authRequired: true, retryable: false };
  }
  if (error.includes("rate limit") || error.includes("too many requests")) {
    return { failureCode: "rate_limited", authRequired: false, retryable: true };
  }
  if (error.includes("blocked") || error.includes("captcha") || error.includes("unsafe browser")) {
    return { failureCode: "site_blocked", authRequired: false, retryable: true };
  }
  if (error.includes("navigate") || error.includes("navigation")) {
    return { failureCode: "navigation_failed", authRequired: false, retryable: true };
  }
  if (error.includes("permission") || error.includes("forbidden")) {
    return { failureCode: "permission_denied", authRequired: false, retryable: false };
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
