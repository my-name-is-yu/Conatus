import type {
  RuntimeArtifactRetentionClass,
  RuntimeEvidenceArtifactRef,
  RuntimeEvidenceCandidateRecord,
  RuntimeEvidenceEntry,
} from "./evidence-types.js";

interface RuntimeArtifactRetentionManifest {
  artifacts?: Array<{
    label: string;
    path?: string;
    state_relative_path?: string;
    url?: string;
  }>;
}

export type RuntimeArtifactCleanupActionKind =
  | "protect"
  | "retain"
  | "compress_or_summarize"
  | "delete_candidate"
  | "review";

export interface RuntimeArtifactRetentionDecision {
  key: string;
  label: string;
  path?: string;
  state_relative_path?: string;
  url?: string;
  kind: RuntimeEvidenceArtifactRef["kind"];
  retention_class: RuntimeArtifactRetentionClass;
  protected: boolean;
  protection_reasons: string[];
  size_bytes?: number;
  source?: string;
  dependency_refs: string[];
  evidence_entry_ids: string[];
  candidate_ids: string[];
  cleanup_action: RuntimeArtifactCleanupActionKind;
  destructive: boolean;
  approval_required: boolean;
  reason: string;
}

export interface RuntimeArtifactCleanupPlan {
  mode: "plan_only";
  destructive_actions_default: "approval_required";
  actions: RuntimeArtifactRetentionDecision[];
}

export interface RuntimeArtifactRetentionSummary {
  schema_version: "runtime-artifact-retention-summary-v1";
  total_artifacts: number;
  total_size_bytes: number;
  unknown_size_count: number;
  protected_count: number;
  by_retention_class: Record<RuntimeArtifactRetentionClass, number>;
  cleanup_plan: RuntimeArtifactCleanupPlan;
}

interface ArtifactRecord {
  artifact: RuntimeEvidenceArtifactRef;
  entry: RuntimeEvidenceEntry;
  candidate?: RuntimeEvidenceCandidateRecord;
  candidateRole?: "raw_best" | "robust_best" | "safe" | "aggressive" | "diverse" | "near_miss";
  manifestCritical?: boolean;
}

export function summarizeArtifactRetention(
  entries: RuntimeEvidenceEntry[],
  options: { manifests?: RuntimeArtifactRetentionManifest[] } = {}
): RuntimeArtifactRetentionSummary {
  const records = collectArtifactRecords(entries, options.manifests ?? []);
  const decisions = [...records.values()].map(classifyArtifactRecord);
  const byRetentionClass = emptyRetentionClassCounts();
  let totalSizeBytes = 0;
  let unknownSizeCount = 0;
  let protectedCount = 0;

  for (const decision of decisions) {
    byRetentionClass[decision.retention_class] += 1;
    if (decision.size_bytes === undefined) unknownSizeCount += 1;
    else totalSizeBytes += decision.size_bytes;
    if (decision.protected) protectedCount += 1;
  }

  return {
    schema_version: "runtime-artifact-retention-summary-v1",
    total_artifacts: decisions.length,
    total_size_bytes: totalSizeBytes,
    unknown_size_count: unknownSizeCount,
    protected_count: protectedCount,
    by_retention_class: byRetentionClass,
    cleanup_plan: {
      mode: "plan_only",
      destructive_actions_default: "approval_required",
      actions: decisions,
    },
  };
}

function collectArtifactRecords(
  entries: RuntimeEvidenceEntry[],
  manifests: RuntimeArtifactRetentionManifest[]
): Map<string, ArtifactRecord> {
  const candidateRoles = candidateRoleMap(entries);
  const manifestArtifactKeys = new Set<string>();
  for (const manifest of manifests) {
    for (const artifact of manifest.artifacts ?? []) {
      manifestArtifactKeys.add(artifactKey(artifact));
    }
  }

  const records = new Map<string, ArtifactRecord>();
  for (const entry of entries) {
    for (const artifact of entry.artifacts) {
      addRecord(records, {
        artifact,
        entry,
        manifestCritical: manifestArtifactKeys.has(artifactKey(artifact)),
      });
    }
    for (const candidate of entry.candidates ?? []) {
      for (const artifact of candidate.artifacts) {
        addRecord(records, {
          artifact,
          entry,
          candidate,
          candidateRole: candidateRoles.get(candidate.candidate_id),
          manifestCritical: manifestArtifactKeys.has(artifactKey(artifact)),
        });
      }
    }
  }
  return records;
}

function addRecord(records: Map<string, ArtifactRecord>, incoming: ArtifactRecord): void {
  const key = artifactKey(incoming.artifact);
  const existing = records.get(key);
  if (!existing) {
    records.set(key, incoming);
    return;
  }
  records.set(key, mergeArtifactRecords(existing, incoming));
}

function mergeArtifactRecords(existing: ArtifactRecord, incoming: ArtifactRecord): ArtifactRecord {
  const artifact: RuntimeEvidenceArtifactRef = {
    ...existing.artifact,
    ...incoming.artifact,
    dependency_refs: unique([
      ...(existing.artifact.dependency_refs ?? []),
      ...(incoming.artifact.dependency_refs ?? []),
    ]),
  };
  return {
    artifact,
    entry: newerEntry(existing.entry, incoming.entry),
    candidate: incoming.candidate ?? existing.candidate,
    candidateRole: strongerCandidateRole(existing.candidateRole, incoming.candidateRole),
    manifestCritical: Boolean(existing.manifestCritical || incoming.manifestCritical),
  };
}

function classifyArtifactRecord(record: ArtifactRecord): RuntimeArtifactRetentionDecision {
  const retentionClass = inferRetentionClass(record);
  const protectionReasons = protectionReasonsFor(retentionClass, record);
  const cleanupAction = cleanupActionFor(retentionClass, protectionReasons.length > 0);
  const destructive = cleanupAction === "delete_candidate";
  return {
    key: artifactKey(record.artifact),
    label: record.artifact.label,
    ...(record.artifact.path ? { path: record.artifact.path } : {}),
    ...(record.artifact.state_relative_path ? { state_relative_path: record.artifact.state_relative_path } : {}),
    ...(record.artifact.url ? { url: record.artifact.url } : {}),
    kind: record.artifact.kind,
    retention_class: retentionClass,
    protected: protectionReasons.length > 0,
    protection_reasons: protectionReasons,
    ...(record.artifact.size_bytes !== undefined ? { size_bytes: record.artifact.size_bytes } : {}),
    ...(record.artifact.source ? { source: record.artifact.source } : {}),
    dependency_refs: record.artifact.dependency_refs ?? [],
    evidence_entry_ids: [record.entry.id],
    candidate_ids: record.candidate ? [record.candidate.candidate_id] : [],
    cleanup_action: cleanupAction,
    destructive,
    approval_required: destructive,
    reason: cleanupReasonFor(retentionClass, cleanupAction, protectionReasons),
  };
}

function inferRetentionClass(record: ArtifactRecord): RuntimeArtifactRetentionClass {
  if (record.manifestCritical) return "reproducibility_critical";
  if (record.candidate?.near_miss) return "near_miss";
  if (record.candidateRole === "robust_best" || record.candidateRole === "safe") return "robust_candidate";
  if (record.candidateRole === "raw_best" || record.candidateRole === "aggressive") return "best_candidate";
  if (record.entry.kind === "artifact" && record.entry.outcome === "improved") return "final_deliverable";
  if (record.artifact.retention_class) return record.artifact.retention_class;
  if (record.artifact.kind === "report" || record.artifact.kind === "metrics" || record.entry.kind === "verification") {
    return "evidence_report";
  }
  const haystack = `${record.artifact.label} ${record.artifact.path ?? ""} ${record.artifact.state_relative_path ?? ""}`.toLowerCase();
  if (haystack.includes("smoke")) return "low_value_smoke";
  if (haystack.includes("cache") || haystack.includes("tmp/") || haystack.includes("intermediate")) return "cache_intermediate";
  return "other";
}

function protectionReasonsFor(
  retentionClass: RuntimeArtifactRetentionClass,
  record: ArtifactRecord
): string[] {
  const reasons: string[] = [];
  if (record.manifestCritical) reasons.push("reproducibility_manifest");
  if (retentionClass === "final_deliverable") reasons.push("final_deliverable");
  if (retentionClass === "best_candidate") reasons.push("best_candidate");
  if (retentionClass === "robust_candidate") reasons.push("robust_candidate");
  if (retentionClass === "near_miss") reasons.push("near_miss");
  if (retentionClass === "reproducibility_critical") reasons.push("reproducibility_critical");
  return unique(reasons);
}

function cleanupActionFor(
  retentionClass: RuntimeArtifactRetentionClass,
  isProtected: boolean
): RuntimeArtifactCleanupActionKind {
  if (isProtected) return "protect";
  if (retentionClass === "low_value_smoke") return "delete_candidate";
  if (retentionClass === "cache_intermediate" || retentionClass === "duplicate_superseded") return "delete_candidate";
  if (retentionClass === "evidence_report") return "retain";
  return "review";
}

function cleanupReasonFor(
  retentionClass: RuntimeArtifactRetentionClass,
  cleanupAction: RuntimeArtifactCleanupActionKind,
  protectionReasons: string[]
): string {
  if (cleanupAction === "protect") return `Protected: ${protectionReasons.join(", ")}`;
  if (cleanupAction === "delete_candidate") return `${retentionClass} may be deleted only after operator approval.`;
  if (cleanupAction === "retain") return `${retentionClass} retained for status and reporting.`;
  return `${retentionClass} requires operator review before cleanup.`;
}

function candidateRoleMap(entries: RuntimeEvidenceEntry[]): Map<string, ArtifactRecord["candidateRole"]> {
  const contexts = [...entries]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .flatMap((entry) => (entry.candidates ?? []).map((candidate) => ({ entry, candidate })));
  const roles = new Map<string, ArtifactRecord["candidateRole"]>();
  const latestCandidates = new Map<string, RuntimeEvidenceCandidateRecord>();
  for (const context of contexts) latestCandidates.set(context.candidate.candidate_id, context.candidate);
  for (const candidate of latestCandidates.values()) {
    if (candidate.near_miss) roles.set(candidate.candidate_id, "near_miss");
  }
  const scored = [...contexts].flatMap(({ candidate }) => {
    const metric = candidate.metrics.find((item) => typeof item.value === "number");
    return metric && typeof metric.value === "number" ? [{ candidate, metric: { value: metric.value, direction: metric.direction } }] : [];
  });
  if (scored.length === 0) return roles;
  const ranked = scored.sort((a, b) => {
    const direction = a.metric.direction ?? "maximize";
    return direction === "minimize" ? a.metric.value - b.metric.value : b.metric.value - a.metric.value;
  });
  const rawBest = ranked[0]?.candidate;
  if (rawBest) roles.set(rawBest.candidate_id, "raw_best");
  const robust = ranked
    .filter(({ candidate }) => candidate.robustness?.stability_score !== undefined || candidate.robustness?.robust_score !== undefined)
    .sort((a, b) => robustnessScore(b.candidate) - robustnessScore(a.candidate))[0]?.candidate;
  if (robust) roles.set(robust.candidate_id, "robust_best");
  return roles;
}

function robustnessScore(candidate: RuntimeEvidenceCandidateRecord): number {
  const robustness = candidate.robustness;
  if (!robustness) return 0;
  return robustness.robust_score
    ?? ((robustness.stability_score ?? 0) + (robustness.diversity_score ?? 0) + (robustness.evidence_confidence ?? 0)) / 3;
}

function artifactKey(artifact: {
  label?: string;
  path?: string;
  state_relative_path?: string;
  url?: string;
}): string {
  return artifact.path ?? artifact.state_relative_path ?? artifact.url ?? artifact.label ?? "unknown";
}

function newerEntry(a: RuntimeEvidenceEntry, b: RuntimeEvidenceEntry): RuntimeEvidenceEntry {
  return a.occurred_at >= b.occurred_at ? a : b;
}

function strongerCandidateRole(
  a: ArtifactRecord["candidateRole"],
  b: ArtifactRecord["candidateRole"]
): ArtifactRecord["candidateRole"] {
  const rank: Record<NonNullable<ArtifactRecord["candidateRole"]>, number> = {
    robust_best: 6,
    safe: 5,
    raw_best: 4,
    aggressive: 3,
    near_miss: 2,
    diverse: 1,
  };
  if (!a) return b;
  if (!b) return a;
  return rank[b] > rank[a] ? b : a;
}

function emptyRetentionClassCounts(): Record<RuntimeArtifactRetentionClass, number> {
  return {
    final_deliverable: 0,
    best_candidate: 0,
    robust_candidate: 0,
    near_miss: 0,
    reproducibility_critical: 0,
    evidence_report: 0,
    low_value_smoke: 0,
    cache_intermediate: 0,
    duplicate_superseded: 0,
    other: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
