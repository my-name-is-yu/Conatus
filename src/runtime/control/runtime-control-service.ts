import { randomUUID } from "node:crypto";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeSessionRegistry,
  type BackgroundRun,
} from "../session-registry/index.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceLedgerPort } from "../store/evidence-ledger.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import { BrowserSessionStore, RuntimeAuthHandoffStore } from "../interactive-automation/index.js";
import { breakerKey, GuardrailStore } from "../guardrails/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlOperation,
  RuntimeControlOperationKind,
  RuntimeControlOperationState,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";
import { resolveRuntimeTarget } from "./runtime-target-resolver.js";

export interface RuntimeControlRequest {
  intent: RuntimeControlIntent;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeRunControlRequestBase {
  runId?: string;
  sessionId?: string;
  reason: string;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeFinalizeRunRequest extends RuntimeRunControlRequestBase {
  externalActions?: string[];
  irreversible?: boolean;
}

export interface RuntimeControlResult {
  success: boolean;
  message: string;
  operationId?: string;
  state?: RuntimeControlOperationState;
}

export type RuntimeAutomationControlDomain = "auth_handoff" | "browser_session" | "guardrail" | "backpressure";

export interface RuntimeAutomationControlRequest {
  domain: RuntimeAutomationControlDomain;
  action: string;
  reason: string;
  cwd: string;
  handoffId?: string;
  sessionId?: string;
  providerId?: string;
  serviceKey?: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeControlExecutorResult {
  ok: boolean;
  message?: string;
  state?: RuntimeControlOperationState;
}

export type RuntimeControlExecutor = (
  operation: RuntimeControlOperation,
  request: RuntimeControlRequest
) => Promise<RuntimeControlExecutorResult>;

export interface RuntimeControlServiceOptions {
  operationStore?: RuntimeOperationStore;
  runtimeRoot?: string;
  stateManager?: StateManager;
  sessionRegistry?: Pick<ReturnType<typeof createRuntimeSessionRegistry>, "snapshot">;
  evidenceLedger?: RuntimeEvidenceLedgerPort;
  operatorHandoffStore?: Pick<RuntimeOperatorHandoffStore, "create">;
  authHandoffStore?: RuntimeAuthHandoffStore;
  browserSessionStore?: BrowserSessionStore;
  guardrailStore?: GuardrailStore;
  executor?: RuntimeControlExecutor;
  now?: () => Date;
}

type RuntimeControlStep =
  | { ok: true; operation: RuntimeControlOperation }
  | { ok: false; result: RuntimeControlResult };

type TargetResolution =
  | { ok: true; run?: BackgroundRun; goalId?: string | null }
  | { ok: false; result: RuntimeControlResult };

export class RuntimeControlService {
  private readonly operationStore: RuntimeOperationStore;
  private readonly sessionRegistry?: Pick<ReturnType<typeof createRuntimeSessionRegistry>, "snapshot">;
  private readonly evidenceLedger?: RuntimeEvidenceLedgerPort;
  private readonly operatorHandoffStore?: Pick<RuntimeOperatorHandoffStore, "create">;
  private readonly authHandoffStore: RuntimeAuthHandoffStore;
  private readonly browserSessionStore: BrowserSessionStore;
  private readonly guardrailStore: GuardrailStore;
  private readonly executor?: RuntimeControlExecutor;
  private readonly now: () => Date;

  constructor(options: RuntimeControlServiceOptions = {}) {
    this.operationStore = options.operationStore ?? new RuntimeOperationStore(options.runtimeRoot);
    this.sessionRegistry = options.sessionRegistry ?? (options.stateManager
      ? createRuntimeSessionRegistry({ stateManager: options.stateManager })
      : undefined);
    this.evidenceLedger = options.evidenceLedger ?? (options.runtimeRoot ? new RuntimeEvidenceLedger(options.runtimeRoot) : undefined);
    this.operatorHandoffStore = options.operatorHandoffStore ?? (options.runtimeRoot ? new RuntimeOperatorHandoffStore(options.runtimeRoot) : undefined);
    this.authHandoffStore = options.authHandoffStore ?? new RuntimeAuthHandoffStore(options.runtimeRoot);
    this.browserSessionStore = options.browserSessionStore ?? new BrowserSessionStore(options.runtimeRoot);
    this.guardrailStore = options.guardrailStore ?? new GuardrailStore(options.runtimeRoot);
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  async request(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    if (isRunControlKind(request.intent.kind)) {
      return this.handleRunControl(request);
    }

    if (!isExecutableRuntimeControlKind(request.intent.kind)) {
      return {
        success: false,
        message: `Runtime control operation ${request.intent.kind} is not supported by the production executor.`,
        state: "failed",
      };
    }

    const initial = await this.createInitialOperation(request);
    const approved = await this.approveIfRequired(initial, request.approvalFn);
    if (!approved.ok) return approved.result;

    const acknowledged = await this.acknowledge(approved.operation);
    return this.executeAcknowledgedOperation(acknowledged, request);
  }

  inspectRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "inspect_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  pauseRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "pause_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  resumeRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "resume_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  cancelRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "cancel_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  finalizeRun(request: RuntimeFinalizeRunRequest): Promise<RuntimeControlResult> {
    return this.request({
      ...request,
      intent: {
        kind: "finalize_run",
        reason: request.reason,
        target: targetFromRunRequest(request),
        externalActions: request.externalActions,
        irreversible: request.irreversible ?? true,
      },
    });
  }

  async controlAutomation(request: RuntimeAutomationControlRequest): Promise<RuntimeControlResult> {
    const mutation = request.action !== "inspect";
    if (mutation && !request.approvalFn) {
      return this.recordAutomationOperation(request, "blocked", false, "Runtime automation mutation requires an approval surface.");
    }
    if (mutation) {
      const approved = await request.approvalFn?.(`Runtime automation ${request.domain}.${request.action}: ${request.reason}`);
      if (!approved) {
        return this.recordAutomationOperation(request, "cancelled", false, "Runtime automation operation was not approved.");
      }
    }

    const result = await this.applyAutomationControl(request);
    return this.recordAutomationOperation(
      request,
      result.success ? "verified" : "blocked",
      result.success,
      result.message,
    );
  }

  private async handleRunControl(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const initial = await this.createInitialOperation(request);
    if (initial.state === "blocked") return this.toResult(initial);

    if (request.intent.kind === "inspect_run") {
      const inspected = await this.update(initial, "verified", {
        ok: true,
        message: await this.formatInspection(initial),
      });
      await this.appendControlEvidence(inspected);
      return this.toResult(inspected);
    }

    if (request.intent.kind === "finalize_run") {
      const proposed = await this.proposeFinalize(initial, request);
      await this.appendControlEvidence(proposed);
      return this.toResult(proposed);
    }

    if (!initial.target?.goal_id) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: `Runtime control ${request.intent.kind} is blocked: selected run ${initial.target?.run_id ?? "unknown"} has no typed goal/runtime bridge yet.`,
      });
      await this.appendControlEvidence(blocked);
      return this.toResult(blocked);
    }

    const approved = await this.approveIfRequired(initial, request.approvalFn);
    if (!approved.ok) return approved.result;

    const acknowledged = await this.acknowledge(approved.operation);
    const result = await this.executeAcknowledgedOperation(acknowledged, request);
    if (result.operationId) {
      const operation = await this.operationStore.load(result.operationId);
      if (operation) await this.appendControlEvidence(operation);
    }
    return result;
  }

  private async createInitialOperation(request: RuntimeControlRequest): Promise<RuntimeControlOperation> {
    const target = await this.resolveTarget(request);
    if (!target.ok) {
      return this.createBlockedOperation(request, target.result.message);
    }

    const requestedAt = this.nowIso();
    const risk = riskForIntent(request.intent);
    const operation: RuntimeControlOperation = {
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "pending",
      requested_at: requestedAt,
      updated_at: requestedAt,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
      ...(target.run
        ? {
            target: {
              run_id: target.run.id,
              ...(target.run.child_session_id ? { session_id: target.run.child_session_id } : {}),
              ...(target.goalId ? { goal_id: target.goalId } : {}),
            },
          }
        : {}),
      ...(risk ? { risk } : {}),
    };

    return this.operationStore.save(operation);
  }

  private async createBlockedOperation(
    request: RuntimeControlRequest,
    message: string
  ): Promise<RuntimeControlOperation> {
    const now = this.nowIso();
    return this.operationStore.save({
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "blocked",
      requested_at: now,
      updated_at: now,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
      result: { ok: false, message },
    });
  }

  private async applyAutomationControl(request: RuntimeAutomationControlRequest): Promise<{ success: boolean; message: string }> {
    if (request.domain === "auth_handoff") {
      if (!request.handoffId) return { success: false, message: "auth_handoff control requires handoffId." };
      const handoff = await this.authHandoffStore.load(request.handoffId);
      if (!handoff) return { success: false, message: `Auth handoff not found: ${request.handoffId}` };
      if (request.action === "inspect") return { success: true, message: `Auth handoff ${handoff.handoff_id} is ${handoff.state}.` };
      if (handoff.state === "completed" || handoff.state === "cancelled" || handoff.state === "expired" || handoff.state === "superseded") {
        return { success: false, message: `Auth handoff ${handoff.handoff_id} is terminal: ${handoff.state}.` };
      }
      if (isPastIso(handoff.expires_at)) {
        await this.authHandoffStore.transition(handoff.handoff_id, "expired");
        return { success: false, message: `Auth handoff ${handoff.handoff_id} is expired.` };
      }
      if (request.action === "complete") {
        const sessionId = handoff.browser_session_id ?? handoff.resumable_session_id ?? null;
        if (!sessionId) {
          return { success: false, message: `Auth handoff ${handoff.handoff_id} has no linked browser session.` };
        }
        const session = await this.browserSessionStore.load(sessionId);
        if (!session) {
          return { success: false, message: `Linked browser session not found: ${sessionId}` };
        }
        if (isPastIso(session.expires_at)) {
          return { success: false, message: `Linked browser session ${sessionId} is expired.` };
        }
        await this.authHandoffStore.transition(handoff.handoff_id, "completed", {
          browser_session_id: sessionId,
          resumable_session_id: handoff.resumable_session_id ?? sessionId,
        });
        const marked = await this.browserSessionStore.markAuthenticated(sessionId);
        if (!marked) return { success: false, message: `Linked browser session not found: ${sessionId}` };
        return { success: true, message: `Auth handoff ${handoff.handoff_id} completed.` };
      }
      if (request.action === "cancel" || request.action === "expire") {
        await this.authHandoffStore.transition(handoff.handoff_id, request.action === "cancel" ? "cancelled" : "expired");
        return { success: true, message: `Auth handoff ${handoff.handoff_id} ${request.action === "cancel" ? "cancelled" : "expired"}.` };
      }
    }

    if (request.domain === "browser_session") {
      if (!request.sessionId) return { success: false, message: "browser_session control requires sessionId." };
      const session = await this.browserSessionStore.load(request.sessionId);
      if (!session) return { success: false, message: `Browser session not found: ${request.sessionId}` };
      if (request.action === "inspect") return { success: true, message: `Browser session ${session.session_id} is ${session.state}.` };
      if (request.action === "expire") {
        await this.browserSessionStore.upsert({ ...session, state: "expired", updated_at: this.nowIso() });
        return { success: true, message: `Browser session ${session.session_id} expired.` };
      }
    }

    if (request.domain === "guardrail") {
      if (!request.providerId || !request.serviceKey) return { success: false, message: "guardrail control requires providerId and serviceKey." };
      const key = breakerKey(request.providerId, request.serviceKey);
      const breaker = await this.guardrailStore.loadBreaker(key);
      if (request.action === "inspect") return { success: true, message: `Guardrail ${key} is ${breaker?.state ?? "closed"}.` };
      const now = this.nowIso();
      if (request.action === "reset" || request.action === "unpause") {
        await this.guardrailStore.saveBreaker({
          key,
          provider_id: request.providerId,
          service_key: request.serviceKey,
          state: "closed",
          failure_count: 0,
          last_failure_code: null,
          last_failure_message: null,
          last_failure_at: null,
          opened_at: null,
          cooldown_until: null,
          updated_at: now,
        });
        return { success: true, message: `Guardrail ${key} reset.` };
      }
      if (request.action === "pause") {
        await this.guardrailStore.saveBreaker({
          key,
          provider_id: request.providerId,
          service_key: request.serviceKey,
          state: "paused",
          failure_count: breaker?.failure_count ?? 0,
          last_failure_code: breaker?.last_failure_code ?? null,
          last_failure_message: breaker?.last_failure_message ?? null,
          last_failure_at: breaker?.last_failure_at ?? null,
          opened_at: breaker?.opened_at ?? now,
          cooldown_until: null,
          updated_at: now,
        });
        return { success: true, message: `Guardrail ${key} paused.` };
      }
      if (request.action === "half_open") {
        if (!breaker) return { success: false, message: `Guardrail not found: ${key}` };
        await this.guardrailStore.saveBreaker({ ...breaker, state: "half_open", updated_at: now });
        return { success: true, message: `Guardrail ${key} moved to half_open.` };
      }
    }

    if (request.domain === "backpressure") {
      const snapshot = await this.guardrailStore.loadBackpressureSnapshot();
      if (request.action === "inspect") return { success: true, message: `Backpressure active leases: ${snapshot?.active.length ?? 0}.` };
      if (request.action === "reset") {
        await this.guardrailStore.saveBackpressureSnapshot({ updated_at: this.nowIso(), active: [], throttled: [] });
        return { success: true, message: "Backpressure leases reset." };
      }
    }

    return { success: false, message: `Unsupported runtime automation operation: ${request.domain}.${request.action}` };
  }

  private async recordAutomationOperation(
    request: RuntimeAutomationControlRequest,
    state: Extract<RuntimeControlOperationState, "verified" | "blocked" | "cancelled">,
    ok: boolean,
    message: string,
  ): Promise<RuntimeControlResult> {
    const now = this.nowIso();
    const operation = await this.operationStore.save({
      operation_id: randomUUID(),
      kind: "automation_control",
      state,
      requested_at: now,
      updated_at: now,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.reason,
      target: {
        ...(request.handoffId ? { handoff_id: request.handoffId } : {}),
        ...(request.sessionId ? { session_id: request.sessionId } : {}),
        ...(request.providerId ? { provider_id: request.providerId } : {}),
        ...(request.serviceKey ? { service_key: request.serviceKey } : {}),
      },
      automation_control: { domain: request.domain, action: request.action },
      risk: {
        requires_approval: request.action !== "inspect",
        irreversible: request.action === "cancel" || request.action === "expire" || request.action === "reset",
        external_actions: [],
      },
      expected_health: expectedHealthFor("automation_control"),
      completed_at: now,
      result: { ok, message },
    });
    return { success: ok, message, operationId: operation.operation_id, state };
  }

  private async resolveTarget(request: RuntimeControlRequest): Promise<TargetResolution> {
    if (!isRunControlKind(request.intent.kind)) return { ok: true };
    if (!this.sessionRegistry) {
      return blocked("Runtime session catalog is not available for run control.");
    }

    const snapshot = await this.sessionRegistry.snapshot();
    const resolution = resolveRuntimeTarget({
      snapshot,
      operation: request.intent.kind,
      target: request.intent.target,
      selector: request.intent.targetSelector,
      conversationId: request.replyTarget?.conversation_id ?? request.requestedBy?.conversation_id ?? null,
    });

    if (resolution.status === "ambiguous") {
      return blocked(`Multiple runtime runs match this request. Specify one run id: ${resolution.evidence.candidates.map((candidate) => candidate.run_id).join(", ")}`);
    }
    if (resolution.status === "unknown") {
      return blocked(`No runtime run matched this request: ${resolution.evidence.reason}.`);
    }
    if (resolution.status === "stale") {
      return blocked(`${resolution.evidence.reason}; refusing to reuse previous-session state.`);
    }
    return { ok: true, run: resolution.run, goalId: resolution.goalId };
  }

  private async proposeFinalize(
    operation: RuntimeControlOperation,
    request: RuntimeControlRequest
  ): Promise<RuntimeControlOperation> {
    const approved = await this.approveIfRequired(operation, request.approvalFn);
    if (!approved.ok) return this.operationStore.load(operation.operation_id).then((saved) => saved ?? operation);

    const handoff = await this.operatorHandoffStore?.create({
      handoff_id: `handoff:${operation.target?.run_id ?? operation.operation_id}:runtime-finalize`,
      ...(operation.target?.goal_id ? { goal_id: operation.target.goal_id } : {}),
      ...(operation.target?.run_id ? { run_id: operation.target.run_id } : {}),
      triggers: [
        "finalization",
        ...(operation.risk?.irreversible ? ["irreversible_action" as const] : []),
        ...((operation.risk?.external_actions.length ?? 0) > 0 ? ["external_action" as const] : []),
      ],
      title: "Runtime finalization approval required",
      summary: operation.reason,
      current_status: `Run ${operation.target?.run_id ?? "unknown"} is awaiting operator finalization approval.`,
      recommended_action: "Review the proposed finalization. External submit/publish/secret/production/destructive actions remain blocked until explicit approval.",
      candidate_options: [
        { id: "approve_finalize", label: "Approve finalization", tradeoff: "Allows the runtime to finalize without external submission." },
        { id: "keep_running", label: "Keep running", tradeoff: "Leaves the background run unchanged." },
      ],
      risks: [
        "Finalization may be irreversible.",
        ...((operation.risk?.external_actions ?? []).map((action) => `External action requested but not executed: ${action}`)),
      ],
      required_approvals: ["operator_finalization"],
      next_action: {
        label: "approve runtime finalization",
        approval_required: true,
      },
      gate: {
        autonomous_task_generation: "pause",
        external_action_requires_approval: true,
      },
    });

    return this.update(approved.operation, "blocked", {
      ok: true,
      message: [
        `Finalization proposal recorded for ${operation.target?.run_id ?? "the selected run"}.`,
        handoff ? `Operator handoff: ${handoff.handoff_id}.` : "Operator handoff store is not configured.",
        "No external submit/publish/secret/production/destructive action was executed.",
      ].join(" "),
    });
  }

  private async formatInspection(operation: RuntimeControlOperation): Promise<string> {
    if (!this.sessionRegistry || !operation.target?.run_id) return "Runtime run inspection is unavailable.";
    const snapshot = await this.sessionRegistry.snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === operation.target?.run_id);
    if (!run) return `Runtime run ${operation.target.run_id} was not found.`;
    return [
      `Runtime run ${run.id}: ${run.status}.`,
      run.title ? `Title: ${run.title}.` : null,
      run.summary ? `Summary: ${run.summary}.` : null,
      run.error ? `Error: ${run.error}.` : null,
      `Updated: ${run.updated_at ?? "unknown"}.`,
    ].filter((line): line is string => Boolean(line)).join(" ");
  }

  private async appendControlEvidence(operation: RuntimeControlOperation): Promise<void> {
    if (!this.evidenceLedger || !operation.target?.run_id) return;
    await this.evidenceLedger.append({
      kind: operation.state === "failed" || operation.state === "blocked" ? "decision" : "execution",
      scope: { run_id: operation.target.run_id },
      outcome: operation.result?.ok ? "continued" : "blocked",
      summary: operation.result?.message ?? ackMessage(operation.kind),
      result: {
        status: operation.state,
        summary: operation.result?.message ?? ackMessage(operation.kind),
      },
      raw_refs: [{ kind: "runtime_control_operation", id: operation.operation_id }],
    });
  }

  private async approveIfRequired(
    operation: RuntimeControlOperation,
    approvalFn: RuntimeControlRequest["approvalFn"]
  ): Promise<RuntimeControlStep> {
    if (!requiresApproval(operation.kind)) {
      return { ok: true, operation };
    }

    if (!approvalFn) {
      return this.failStep(
        operation,
        "failed",
        "Runtime control requires approval, but no approval handler is configured."
      );
    }

    let approved: boolean;
    try {
      approved = await approvalFn(approvalReason(operation));
    } catch (err) {
      return this.failStep(
        operation,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!approved) {
      return this.failStep(operation, "cancelled", "Runtime control operation was not approved.");
    }

    const updated = await this.operationStore.save({
      ...operation,
      state: "approved",
      updated_at: this.nowIso(),
    });
    return { ok: true, operation: updated };
  }

  private acknowledge(operation: RuntimeControlOperation): Promise<RuntimeControlOperation> {
    return this.update(operation, "acknowledged", {
      ok: true,
      message: ackMessage(operation.kind),
    });
  }

  private async executeAcknowledgedOperation(
    operation: RuntimeControlOperation,
    request: RuntimeControlRequest
  ): Promise<RuntimeControlResult> {
    if (!this.executor) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: "Runtime control executor is not configured; operation was recorded but not started.",
      });
      return this.toResult(failed);
    }

    let executed: RuntimeControlExecutorResult;
    try {
      executed = await this.executor(operation, request);
    } catch (err) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return this.toResult(failed);
    }

    const nextState = executed.state ?? (executed.ok ? "acknowledged" : "failed");
    const saved = await this.update(operation, nextState, {
      ok: executed.ok,
      message: executed.message ?? ackMessage(operation.kind),
    });
    return this.toResult(saved);
  }

  private async failStep(
    operation: RuntimeControlOperation,
    state: Extract<RuntimeControlOperationState, "failed" | "cancelled">,
    message: string
  ): Promise<RuntimeControlStep> {
    const saved = await this.update(operation, state, {
      ok: false,
      message,
    });
    return { ok: false, result: this.toResult(saved) };
  }

  private toResult(operation: RuntimeControlOperation): RuntimeControlResult {
    return {
      success: operation.result?.ok ?? false,
      message: operation.result?.message ?? ackMessage(operation.kind),
      operationId: operation.operation_id,
      state: operation.state,
    };
  }

  private async update(
    operation: RuntimeControlOperation,
    state: RuntimeControlOperationState,
    result: { ok: boolean; message: string }
  ): Promise<RuntimeControlOperation> {
    const updated: RuntimeControlOperation = {
      ...operation,
      state,
      updated_at: this.nowIso(),
      result,
    };
    return this.operationStore.save(updated);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export function isExecutableRuntimeControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "restart_daemon" | "restart_gateway" | "reload_config" | "self_update" | "pause_run" | "resume_run" | "cancel_run"> {
  return kind === "restart_daemon"
    || kind === "restart_gateway"
    || kind === "reload_config"
    || kind === "self_update"
    || kind === "pause_run"
    || kind === "resume_run"
    || kind === "cancel_run";
}

function isRunControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "inspect_run" | "pause_run" | "resume_run" | "cancel_run" | "finalize_run"> {
  return kind === "inspect_run" || kind === "pause_run" || kind === "resume_run" || kind === "cancel_run" || kind === "finalize_run";
}

function requiresApproval(kind: RuntimeControlOperationKind): boolean {
  return kind === "restart_daemon"
    || kind === "restart_gateway"
    || kind === "reload_config"
    || kind === "self_update"
    || kind === "pause_run"
    || kind === "resume_run"
    || kind === "cancel_run"
    || kind === "finalize_run";
}

function normalizeReplyTarget(target: RuntimeControlReplyTarget): RuntimeControlReplyTarget {
  return {
    ...target,
    channel: target.channel ?? defaultChannelForSurface(target.surface),
  };
}

function defaultChannelForSurface(
  surface: RuntimeControlReplyTarget["surface"]
): RuntimeControlReplyTarget["channel"] {
  switch (surface) {
    case "gateway":
      return "plugin_gateway";
    case "cli":
    case "tui":
      return surface;
    case "chat":
    case undefined:
      return undefined;
  }
}

function expectedHealthFor(kind: RuntimeControlOperationKind): { daemon_ping: boolean; gateway_acceptance: boolean } {
  return {
    daemon_ping: isExecutableRuntimeControlKind(kind),
    gateway_acceptance: isExecutableRuntimeControlKind(kind),
  };
}

function approvalReason(operation: RuntimeControlOperation): string {
  const target = operation.target?.run_id ? ` for ${operation.target.run_id}` : "";
  return `Runtime control ${operation.kind}${target}: ${operation.reason}`;
}

function isPastIso(value?: string | null): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= Date.now();
}

function ackMessage(kind: RuntimeControlOperationKind): string {
  switch (kind) {
    case "restart_gateway":
      return "gateway の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "restart_daemon":
      return "PulSeed daemon の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "reload_config":
      return "runtime 設定の再読み込みを開始します。";
    case "self_update":
      return "PulSeed 自身の更新準備を開始します。実行前に内容を確認します。";
    case "inspect_run":
      return "runtime run の状況を確認しました。";
    case "pause_run":
      return "runtime run の safe pause を要求します。";
    case "resume_run":
      return "runtime run の再開を要求します。";
    case "cancel_run":
      return "runtime run のキャンセルを要求します。";
    case "finalize_run":
      return "runtime run の最終化 proposal を作成します。";
    case "automation_control":
      return "runtime automation control を記録しました。";
  }
}

function targetFromRunRequest(request: RuntimeRunControlRequestBase): RuntimeControlIntent["target"] | undefined {
  if (!request.runId && !request.sessionId) return undefined;
  return {
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  };
}

function riskForIntent(intent: RuntimeControlIntent): RuntimeControlOperation["risk"] | null {
  if (intent.kind !== "finalize_run") return null;
  return {
    requires_approval: true,
    irreversible: intent.irreversible ?? true,
    external_actions: intent.externalActions ?? [],
  };
}

function blocked(message: string): TargetResolution {
  return { ok: false, result: { success: false, message, state: "blocked" } };
}
