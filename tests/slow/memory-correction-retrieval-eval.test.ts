import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { projectAgentMemoryToSoil } from "../../src/platform/soil/content-projections.js";
import { compileSoilContext } from "../../src/platform/soil/context-compiler.js";
import { readSoilMarkdownFile } from "../../src/platform/soil/io.js";
import { createRuntimeDreamSidecarReview } from "../../src/runtime/dream-sidecar-review.js";
import { BackgroundRunLedger } from "../../src/runtime/store/background-run-store.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceEntry } from "../../src/runtime/store/evidence-ledger.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const EVALUATED_AT = "2026-05-02T00:00:00.000Z";
const ARTIFACT_PATH = path.join(process.cwd(), "tmp", "memory-correction-retrieval-eval.json");

interface RetrievalEvalMetrics {
  schema_version: "memory-correction-retrieval-eval-v1";
  evaluated_at: string;
  fixture_count: number;
  corrected_memory_reuse_rate: number;
  stale_false_positive_rate: number;
  precision_at_k: number;
  expected_item_recall: number;
  route_bypass_search_avoided_rate: number;
  sensitive_memory_leak_rate: number;
  cases: Array<{
    case_id: string;
    expected_refs: string[];
    retrieved_refs: string[];
    stale_refs: string[];
    sensitive_refs: string[];
    search_avoided?: boolean;
  }>;
  notes: {
    long_run_ci_lane: string;
  };
}

describe("memory correction and governance retrieval eval", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let knowledgeManager: KnowledgeManager;
  let runtimeRoot: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-memory-eval-");
    runtimeRoot = path.join(tmpDir, "runtime");
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    knowledgeManager = new KnowledgeManager(stateManager, {} as ILLMClient);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits correction, retraction, quarantine, routing, and governance retrieval metrics", async () => {
    const memoryCase = await evaluateAgentMemoryRetrieval();
    const soilCase = await evaluateSoilPlanningProjection();
    const routeCase = evaluateStaleRouteRetrieval();
    const runtimeCase = await evaluateRuntimeEvidenceAndDreamSidecar();
    const cases = [memoryCase, soilCase, routeCase, runtimeCase];
    const metrics = buildMetrics(cases);

    await fsp.mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await fsp.writeFile(ARTIFACT_PATH, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

    expect(metrics.corrected_memory_reuse_rate).toBe(0);
    expect(metrics.stale_false_positive_rate).toBe(0);
    expect(metrics.precision_at_k).toBe(1);
    expect(metrics.expected_item_recall).toBe(1);
    expect(metrics.sensitive_memory_leak_rate).toBe(0);
    expect(metrics.route_bypass_search_avoided_rate).toBe(1);

    const artifact = JSON.parse(await fsp.readFile(ARTIFACT_PATH, "utf8")) as RetrievalEvalMetrics;
    expect(artifact.schema_version).toBe("memory-correction-retrieval-eval-v1");
    expect(artifact.notes.long_run_ci_lane).toContain("#886");
    expect(artifact.cases.map((testCase) => testCase.case_id)).toEqual([
      "agent-memory-correction-governance",
      "soil-planning-projection",
      "stale-route-rejection",
      "runtime-evidence-dream-sidecar",
    ]);
  });

  async function evaluateAgentMemoryRetrieval(): Promise<RetrievalEvalMetrics["cases"][number]> {
    const stalePreference = await knowledgeManager.saveAgentMemory({
      key: "user.editor.preference",
      value: "The user prefers Atom.",
      tags: ["preference"],
      memory_type: "preference",
    });
    const supersededFact = await knowledgeManager.saveAgentMemory({
      key: "project.runtime.fact",
      value: "The runtime uses legacy unscoped evidence.",
      tags: ["runtime"],
      memory_type: "fact",
    });
    await knowledgeManager.saveAgentMemory({
      key: "project.runtime.fact.current",
      value: "The runtime uses scoped evidence summaries.",
      tags: ["runtime"],
      memory_type: "fact",
    });
    await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: stalePreference.id },
      reason: "User corrected editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "user.editor.preference.current",
      now: "2026-05-02T00:10:00.000Z",
    });
    await runUserMemoryOperation(stateManager, {
      operation: "retract",
      targetRef: { kind: "agent_memory", id: supersededFact.id },
      reason: "Superseded by scoped evidence summaries.",
      now: "2026-05-02T00:11:00.000Z",
    });
    const hallucinated = await knowledgeManager.saveAgentMemory({
      key: "hallucinated.memory",
      value: "A hallucinated unsupported fact.",
      tags: ["risk"],
      memory_type: "observation",
      verification_status: "suspicious",
      provenance: {
        source_type: "unknown",
        raw_refs: [],
        verification_status: "suspicious",
        risk_signals: ["hallucinated"],
      },
    });
    await knowledgeManager.quarantineAgentMemory({
      targetIds: [hallucinated.id],
      reason: "Synthetic hallucinated memory fixture.",
      source: "memory_lint",
      confidence: 0.95,
      inspectionRefs: ["eval:hallucinated"],
    });
    await knowledgeManager.saveAgentMemory({
      key: "user.health.private",
      value: "Sensitive detail should not leak into default planning.",
      tags: ["private"],
      memory_type: "observation",
      governance: {
        sensitivity: "secret",
        consent: {
          scope_id: "private_chat",
          allowed_contexts: ["private_chat"],
        },
      },
    });

    const retrieved = await knowledgeManager.recallAgentMemory("user", {
      max_sensitivity: "local",
      consent_scope: "local_planning",
      limit: 20,
    });
    const retrievedRefs = retrieved.map((entry) => entry.key);
    return {
      case_id: "agent-memory-correction-governance",
      expected_refs: ["user.editor.preference.current"],
      retrieved_refs: retrievedRefs,
      stale_refs: retrievedRefs.filter((ref) =>
        ref === "user.editor.preference" || ref === "project.runtime.fact" || ref === "hallucinated.memory"
      ),
      sensitive_refs: retrievedRefs.filter((ref) => ref === "user.health.private"),
    };
  }

  async function evaluateSoilPlanningProjection(): Promise<RetrievalEvalMetrics["cases"][number]> {
    const store = await knowledgeManager.loadAgentMemoryStore();
    await projectAgentMemoryToSoil({ baseDir: tmpDir, store, clock: () => new Date(EVALUATED_AT) });
    const memoryPage = await readSoilMarkdownFile(path.join(tmpDir, "soil", "memory", "index.md"));
    const body = memoryPage?.body ?? "";
    const retrievedRefs = [
      ...(body.includes("user.editor.preference.current") ? ["user.editor.preference.current"] : []),
      ...(body.includes("project.runtime.fact.current") ? ["project.runtime.fact.current"] : []),
    ];
    const staleRefs = [
      ...(body.includes("The user prefers Atom.") ? ["user.editor.preference"] : []),
      ...(body.includes("legacy unscoped evidence") ? ["project.runtime.fact"] : []),
      ...(body.includes("hallucinated.memory") ? ["hallucinated.memory"] : []),
    ];
    const sensitiveRefs = body.includes("user.health.private") ? ["user.health.private"] : [];
    return {
      case_id: "soil-planning-projection",
      expected_refs: ["user.editor.preference.current", "project.runtime.fact.current"],
      retrieved_refs: retrievedRefs,
      stale_refs: staleRefs,
      sensitive_refs: sensitiveRefs,
    };
  }

  function evaluateStaleRouteRetrieval(): RetrievalEvalMetrics["cases"][number] {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-stale-route",
      now: () => new Date(EVALUATED_AT),
      targetPaths: ["src/runtime/evidence.ts"],
      fallbackQuery: "runtime evidence",
      includeFallbackWhenRouteMatched: true,
      routes: [
        {
          route_id: "route-current-memory",
          status: "active",
          path_globs: ["src/runtime/*"],
          soil_ids: ["memory/current-preference"],
          reason: "Current memory route fixture.",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        },
        {
          route_id: "route-old-memory",
          status: "active",
          path_globs: ["src/runtime/*"],
          soil_ids: ["memory/old-preference"],
          reason: "Old memory route fixture.",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      routeTargetStates: [
        {
          soilId: "memory/current-preference",
          isActive: true,
          status: "active",
          lifecycleState: "active",
        },
        {
          soilId: "memory/old-preference",
          isActive: false,
          status: "retracted",
          lifecycleState: "tombstoned",
        },
      ],
      fallbackCandidates: [{
        chunk_id: "fallback-old",
        record_id: "record-old",
        soil_id: "memory/old-preference",
        page_id: null,
        lane: "lexical",
        rank: 1,
        score: 0.99,
        snippet: "old stale preference",
        metadata_json: { lifecycle_state: "tombstoned", exact_source_match: true },
      }],
    });
    const retrievedRefs = compiled.items.map((item) => item.soilId ?? item.recordId ?? "");
    return {
      case_id: "stale-route-rejection",
      expected_refs: ["memory/current-preference"],
      retrieved_refs: retrievedRefs,
      stale_refs: retrievedRefs.filter((ref) => ref === "memory/old-preference"),
      sensitive_refs: [],
      search_avoided: compiled.trace.decisions.every((decision) =>
        !decision.candidate_id.startsWith("candidate:") || decision.decision === "rejected"
      ),
    };
  }

  async function evaluateRuntimeEvidenceAndDreamSidecar(): Promise<RetrievalEvalMetrics["cases"][number]> {
    const runId = `run:memory-eval:${randomUUID()}`;
    await new BackgroundRunLedger(runtimeRoot).create({
      id: runId,
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      child_session_id: `session:${runId}`,
      title: "Memory correction eval run",
      workspace: tmpDir,
      status: "running",
      started_at: EVALUATED_AT,
      updated_at: EVALUATED_AT,
    });
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append(evidenceEntry({
      id: `${runId}:old-best`,
      occurred_at: "2026-05-02T00:01:00.000Z",
      kind: "metric",
      scope: { run_id: runId },
      metrics: [{ label: "quality", value: 0.99, direction: "maximize", confidence: 0.9 }],
      summary: "Old best evidence that is later retracted.",
      outcome: "improved",
    }));
    await ledger.append(evidenceEntry({
      id: `${runId}:current-best`,
      occurred_at: "2026-05-02T00:02:00.000Z",
      kind: "metric",
      scope: { run_id: runId },
      metrics: [{ label: "quality", value: 0.91, direction: "maximize", confidence: 0.9 }],
      summary: "Current admissible evidence after retraction.",
      outcome: "improved",
    }));
    await ledger.append(evidenceEntry({
      id: `${runId}:checkpoint`,
      occurred_at: "2026-05-02T00:03:00.000Z",
      kind: "dream_checkpoint",
      scope: { run_id: runId },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Checkpoint with stale and current memories.",
        current_goal: "Evaluate correction retrieval quality",
        active_dimensions: ["quality"],
        best_evidence_so_far: `${runId}:current-best`,
        recent_strategy_families: ["memory_eval"],
        relevant_memories: [
          {
            source_type: "runtime_evidence",
            ref: "checkpoint://old-memory",
            summary: "Old retracted checkpoint memory.",
            relevance_score: 0.99,
            source_reliability: 0.99,
            prior_success_contribution: 1,
            retrieval: { kind: "checkpoint", confidence: 0.99 },
          },
          {
            source_type: "runtime_evidence",
            ref: "checkpoint://current-memory",
            summary: "Current checkpoint memory.",
            relevance_score: 0.9,
            source_reliability: 0.92,
            prior_success_contribution: 0.8,
            retrieval: { kind: "checkpoint", confidence: 0.92 },
          },
        ],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Use current memory",
          rationale: "Current memory survived correction filters.",
          target_dimensions: ["quality"],
        }],
        guidance: "Prefer current memory.",
        uncertainty: [],
        confidence: 0.88,
      }],
      summary: "Dream checkpoint for memory correction eval.",
      outcome: "continued",
    }));
    await ledger.appendCorrection({
      correction_id: `${runId}:old-best:retract`,
      target_ref: { kind: "runtime_evidence", id: `${runId}:old-best`, scope: { run_id: runId } },
      correction_kind: "retracted",
      replacement_ref: { kind: "runtime_evidence", id: `${runId}:current-best`, scope: { run_id: runId } },
      actor: "runtime_verification",
      reason: "Synthetic tombstoned evidence fixture.",
      created_at: "2026-05-02T00:04:00.000Z",
      provenance: { source: "runtime_verification", confidence: 1 },
      scope: { run_id: runId },
    });
    await ledger.appendCorrection({
      correction_id: `${runId}:old-memory:retract`,
      target_ref: { kind: "dream_checkpoint", id: "checkpoint://old-memory", scope: { run_id: runId } },
      correction_kind: "retracted",
      replacement_ref: { kind: "dream_checkpoint", id: "checkpoint://current-memory", scope: { run_id: runId } },
      actor: "runtime_verification",
      reason: "Synthetic stale Dream memory fixture.",
      created_at: "2026-05-02T00:05:00.000Z",
      provenance: { source: "runtime_verification", confidence: 1 },
      scope: { run_id: runId },
    });

    const summary = await ledger.summarizeRun(runId);
    const review = await createRuntimeDreamSidecarReview({ stateManager, runId });
    const retrievedRefs = [
      ...(summary.best_evidence?.id ? [summary.best_evidence.id] : []),
      ...review.advisory_memories.map((memory) => memory.ref).filter((ref): ref is string => Boolean(ref)),
    ];
    const staleRefs = retrievedRefs.filter((ref) =>
      ref === `${runId}:old-best` || ref === "checkpoint://old-memory"
    );
    return {
      case_id: "runtime-evidence-dream-sidecar",
      expected_refs: [`${runId}:current-best`, "checkpoint://current-memory"],
      retrieved_refs: retrievedRefs,
      stale_refs: staleRefs,
      sensitive_refs: [],
    };
  }
});

function buildMetrics(cases: RetrievalEvalMetrics["cases"]): RetrievalEvalMetrics {
  const expectedTotal = cases.reduce((sum, testCase) => sum + testCase.expected_refs.length, 0);
  const retrievedRelevant = cases.reduce((sum, testCase) =>
    sum + testCase.expected_refs.filter((ref) => testCase.retrieved_refs.includes(ref)).length,
  0);
  const retrievedTotal = cases.reduce((sum, testCase) => sum + testCase.retrieved_refs.length, 0);
  const staleTotal = cases.reduce((sum, testCase) => sum + testCase.stale_refs.length, 0);
  const sensitiveTotal = cases.reduce((sum, testCase) => sum + testCase.sensitive_refs.length, 0);
  const routeCases = cases.filter((testCase) => testCase.search_avoided !== undefined);
  return {
    schema_version: "memory-correction-retrieval-eval-v1",
    evaluated_at: EVALUATED_AT,
    fixture_count: cases.length,
    corrected_memory_reuse_rate: rate(staleTotal, retrievedTotal),
    stale_false_positive_rate: rate(staleTotal, retrievedTotal),
    precision_at_k: rate(retrievedRelevant, retrievedTotal),
    expected_item_recall: rate(retrievedRelevant, expectedTotal),
    route_bypass_search_avoided_rate: rate(routeCases.filter((testCase) => testCase.search_avoided).length, routeCases.length),
    sensitive_memory_leak_rate: rate(sensitiveTotal, retrievedTotal),
    cases,
    notes: {
      long_run_ci_lane: "#886 tracks adding the long-run/manual lane to CI; this suite runs through test:memory-correction-eval and test:runtime-long-run.",
    },
  };
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function evidenceEntry(
  input: Partial<RuntimeEvidenceEntry> & Pick<RuntimeEvidenceEntry, "id" | "occurred_at" | "kind" | "scope">
): RuntimeEvidenceEntry {
  return {
    schema_version: "runtime-evidence-entry-v1",
    metrics: [],
    evaluators: [],
    research: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    artifacts: [],
    raw_refs: [],
    ...input,
  };
}
