import { z } from "zod";
import type { ApprovalRecord } from "./store/runtime-schemas.js";

export const PermissionRiskClassSchema = z.enum(["low", "medium", "high", "critical", "unknown"]);
export type PermissionRiskClass = z.infer<typeof PermissionRiskClassSchema>;

export const PendingPermissionTargetSchema = z.object({
  session_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  tool_id: z.string().min(1).optional(),
  tool_call_id: z.string().min(1).optional(),
});
export type PendingPermissionTarget = z.infer<typeof PendingPermissionTargetSchema>;

export const PendingPermissionTaskSchema = z.object({
  kind: z.literal("permission"),
  id: z.string().min(1),
  description: z.string().min(1),
  action: z.string().min(1),
  operation_summary: z.string().min(1),
  risk_class: PermissionRiskClassSchema,
  target: PendingPermissionTargetSchema,
  state_epoch: z.string().min(1),
  state_version: z.string().min(1).optional(),
  expires_at: z.number().int().nonnegative().optional(),
  permission_level: z.string().min(1).optional(),
  is_destructive: z.boolean().optional(),
  reversibility: z.string().min(1).optional(),
});
export type PendingPermissionTask = z.infer<typeof PendingPermissionTaskSchema>;

export function createPendingPermissionTask(input: {
  id: string;
  description: string;
  action: string;
  target: PendingPermissionTarget;
  stateEpoch: string;
  stateVersion?: string;
  expiresAt?: number;
  permissionLevel?: string;
  isDestructive?: boolean;
  reversibility?: string;
}): PendingPermissionTask {
  return PendingPermissionTaskSchema.parse({
    kind: "permission",
    id: input.id,
    description: input.description,
    action: input.action,
    operation_summary: input.description,
    risk_class: classifyPermissionRisk({
      permissionLevel: input.permissionLevel,
      isDestructive: input.isDestructive,
    }),
    target: input.target,
    state_epoch: input.stateEpoch,
    ...(input.stateVersion ? { state_version: input.stateVersion } : {}),
    ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
    ...(input.permissionLevel ? { permission_level: input.permissionLevel } : {}),
    ...(typeof input.isDestructive === "boolean" ? { is_destructive: input.isDestructive } : {}),
    ...(input.reversibility ? { reversibility: input.reversibility } : {}),
  });
}

export function withPermissionExpiry<T extends { kind?: string; expires_at?: number }>(
  task: T,
  expiresAt: number,
): T {
  return task.kind === "permission"
    ? { ...task, expires_at: expiresAt }
    : task;
}

export function getPendingPermissionTask(record: ApprovalRecord): PendingPermissionTask | null {
  const payload = record.payload;
  if (!isRecord(payload)) return null;
  const task = payload["task"];
  const parsed = PendingPermissionTaskSchema.safeParse(task);
  return parsed.success ? parsed.data : null;
}

export function isPermissionApprovalStale(
  record: ApprovalRecord,
  currentStateEpoch: string | null,
): boolean {
  const task = getPendingPermissionTask(record);
  if (!task || !currentStateEpoch) return false;
  return task.state_epoch !== currentStateEpoch;
}

export function classifyPermissionRisk(input: {
  permissionLevel?: string;
  isDestructive?: boolean;
}): PermissionRiskClass {
  if (input.isDestructive) return "critical";
  switch (input.permissionLevel) {
    case "write_remote":
    case "execute":
      return "high";
    case "write_local":
      return "medium";
    case "read_metrics":
    case "read_only":
      return "low";
    default:
      return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
