import { z } from "zod";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import { RuntimeJournal } from "./runtime-journal.js";

export const RuntimeOperatorHandoffTriggerSchema = z.enum([
  "deadline",
  "budget",
  "auth",
  "external_action",
  "irreversible_action",
  "finalization",
  "policy",
]);
export type RuntimeOperatorHandoffTrigger = z.infer<typeof RuntimeOperatorHandoffTriggerSchema>;

export const RuntimeOperatorHandoffStatusSchema = z.enum([
  "open",
  "approved",
  "resolved",
  "dismissed",
]);
export type RuntimeOperatorHandoffStatus = z.infer<typeof RuntimeOperatorHandoffStatusSchema>;

export const RuntimeOperatorHandoffRecordSchema = z.object({
  schema_version: z.literal("runtime-operator-handoff-v1"),
  handoff_id: z.string().min(1),
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  status: RuntimeOperatorHandoffStatusSchema.default("open"),
  triggers: z.array(RuntimeOperatorHandoffTriggerSchema).min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  current_status: z.string().min(1),
  recommended_action: z.string().min(1),
  candidate_options: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    tradeoff: z.string().min(1),
  }).strict()).default([]),
  risks: z.array(z.string().min(1)).default([]),
  required_approvals: z.array(z.string().min(1)).default([]),
  required_credentials: z.array(z.string().min(1)).default([]),
  approval_request_id: z.string().min(1).optional(),
  next_action: z.object({
    label: z.string().min(1),
    command: z.string().min(1).optional(),
    tool_name: z.string().min(1).optional(),
    payload_ref: z.string().min(1).optional(),
    approval_required: z.boolean().default(true),
  }).strict(),
  gate: z.object({
    autonomous_task_generation: z.enum(["pause", "constrain", "none"]).default("constrain"),
    external_action_requires_approval: z.boolean().default(true),
  }).strict().default({}),
  evidence_refs: z.array(z.object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    observed_at: z.string().datetime().optional(),
  }).strict()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().default(null),
}).strict();
export type RuntimeOperatorHandoffRecord = z.infer<typeof RuntimeOperatorHandoffRecordSchema>;
export type RuntimeOperatorHandoffInput = Omit<
  z.input<typeof RuntimeOperatorHandoffRecordSchema>,
  "schema_version" | "status" | "created_at" | "updated_at" | "resolved_at"
> & {
  handoff_id?: string;
  status?: RuntimeOperatorHandoffStatus;
  created_at?: string;
};

const RuntimeOperatorHandoffRecordRuntimeSchema =
  RuntimeOperatorHandoffRecordSchema as unknown as z.ZodType<RuntimeOperatorHandoffRecord>;

export class RuntimeOperatorHandoffStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;
  private readonly now: () => Date;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths, options: { now?: () => Date } = {}) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
    this.now = options.now ?? (() => new Date());
  }

  async load(handoffId: string): Promise<RuntimeOperatorHandoffRecord | null> {
    return this.journal.load(this.paths.operatorHandoffPath(handoffId), RuntimeOperatorHandoffRecordRuntimeSchema);
  }

  async list(): Promise<RuntimeOperatorHandoffRecord[]> {
    return this.journal.list(this.paths.operatorHandoffsDir, RuntimeOperatorHandoffRecordRuntimeSchema);
  }

  async listOpen(): Promise<RuntimeOperatorHandoffRecord[]> {
    return (await this.list()).filter((record) => record.status === "open");
  }

  async create(input: RuntimeOperatorHandoffInput): Promise<RuntimeOperatorHandoffRecord> {
    const now = input.created_at ?? this.nowIso();
    const handoffId = input.handoff_id ?? deterministicHandoffId(input);
    const existing = await this.load(handoffId);
    const record = RuntimeOperatorHandoffRecordSchema.parse({
      ...existing,
      ...input,
      schema_version: "runtime-operator-handoff-v1",
      handoff_id: handoffId,
      status: existing?.status ?? input.status ?? "open",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      resolved_at: existing?.resolved_at ?? null,
    });
    return this.journal.save(this.paths.operatorHandoffPath(handoffId), RuntimeOperatorHandoffRecordRuntimeSchema, record);
  }

  async resolve(handoffId: string, status: Exclude<RuntimeOperatorHandoffStatus, "open">): Promise<RuntimeOperatorHandoffRecord> {
    const existing = await this.load(handoffId);
    if (!existing) throw new Error(`Runtime operator handoff not found: ${handoffId}`);
    const now = this.nowIso();
    return this.journal.save(this.paths.operatorHandoffPath(handoffId), RuntimeOperatorHandoffRecordRuntimeSchema, {
      ...existing,
      status,
      updated_at: now,
      resolved_at: now,
    });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function deterministicHandoffId(input: RuntimeOperatorHandoffInput): string {
  const scope = input.run_id ?? input.goal_id ?? "global";
  return `handoff:${scope}:${input.triggers.join("+")}:${slug(input.next_action.label)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "action";
}
