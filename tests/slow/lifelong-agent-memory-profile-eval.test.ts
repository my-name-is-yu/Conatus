import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { AgentMemoryEntrySchema } from "../../src/platform/knowledge/types/agent-memory.js";
import {
  formatRelationshipProfilePromptBlock,
  loadRelationshipProfile,
  selectActiveRelationshipProfileItems,
  upsertRelationshipProfileItem,
} from "../../src/platform/profile/relationship-profile.js";
import { ProactiveInterventionStore } from "../../src/runtime/store/proactive-intervention-store.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const EVALUATED_AT = "2026-05-02T00:00:00.000Z";
const DEFAULT_ARTIFACT_PATH = path.join(process.cwd(), "tmp", "lifelong-agent-memory-profile-eval.json");

interface LifelongEvalScenario {
  scenario_id: string;
  expected_refs: string[];
  retrieved_refs: string[];
  stale_refs: string[];
  corrected_expected_refs?: string[];
  corrected_retrieved_refs?: string[];
  sensitive_refs: string[];
}

interface LifelongAgentEvalMetrics {
  schema_version: "lifelong-agent-memory-profile-eval-v1";
  evaluated_at: string;
  scenario_count: number;
  memory_retrieval_hit_rate: number;
  precision_at_k: number;
  expected_item_recall: number;
  stale_memory_false_positive_rate: number;
  corrected_memory_reuse_rate: number;
  sensitive_memory_leak_rate: number;
  active_profile_latest_rate: number;
  profile_stale_reuse_rate: number;
  proactive_intervention_quality: {
    response_rate: number | null;
    accepted_rate: number | null;
    ignored_suggestion_rate: number | null;
    correction_rate: number | null;
    overreach_rate: number | null;
    policy_recommendation: string | null;
  };
  scenarios: LifelongEvalScenario[];
  artifact_paths: {
    json_path: string;
  };
}

describe("lifelong-agent memory and relationship profile simulation eval", () => {
  let tmpDir: string;
  let runtimeRoot: string;
  let stateManager: StateManager;
  let knowledgeManager: KnowledgeManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-lifelong-agent-eval-");
    runtimeRoot = path.join(tmpDir, "runtime");
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    knowledgeManager = new KnowledgeManager(stateManager, {} as ILLMClient);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits lifelong memory/profile/proactive quality metrics as a comparison artifact", async () => {
    const scenarios = [
      await evaluatePreferenceChanges(),
      await evaluateCorrectedMemoryReuse(),
      await evaluateSensitiveScope(),
      await evaluateStaleProfileReconfirmation(),
      await evaluateLongHorizonRetrieval(),
    ];
    const proactiveQuality = await evaluateProactiveInterventionPolicy();
    const artifactPath = process.env["PULSEED_LIFELONG_EVAL_ARTIFACT"] ?? DEFAULT_ARTIFACT_PATH;
    const metrics = buildMetrics(scenarios, proactiveQuality, artifactPath);

    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    await fsp.writeFile(artifactPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

    expect(metrics.memory_retrieval_hit_rate).toBe(1);
    expect(metrics.precision_at_k).toBeGreaterThanOrEqual(0.95);
    expect(metrics.expected_item_recall).toBe(1);
    expect(metrics.stale_memory_false_positive_rate).toBe(0);
    expect(metrics.corrected_memory_reuse_rate).toBe(1);
    expect(metrics.sensitive_memory_leak_rate).toBe(0);
    expect(metrics.active_profile_latest_rate).toBe(1);
    expect(metrics.profile_stale_reuse_rate).toBe(0);
    expect(metrics.proactive_intervention_quality.ignored_suggestion_rate).toBe(0.25);
    expect(metrics.proactive_intervention_quality.correction_rate).toBe(0.25);
    expect(metrics.proactive_intervention_quality.overreach_rate).toBe(0.25);
    expect(metrics.proactive_intervention_quality.policy_recommendation).toBe("reduce_frequency");

    const artifact = JSON.parse(await fsp.readFile(artifactPath, "utf8")) as LifelongAgentEvalMetrics;
    expect(artifact.schema_version).toBe("lifelong-agent-memory-profile-eval-v1");
    expect(artifact.scenarios.map((scenario) => scenario.scenario_id)).toEqual([
      "profile-preference-changes",
      "corrected-memory-reuse",
      "sensitive-scope-filtering",
      "stale-profile-reconfirmation",
      "long-horizon-retrieval",
    ]);
  });

  async function evaluatePreferenceChanges(): Promise<LifelongEvalScenario> {
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.planning_window",
      kind: "preference",
      value: "Prefer planning on Monday morning.",
      source: "cli_update",
      allowedScopes: ["local_planning", "resident_behavior"],
      now: "2026-01-01T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.planning_window",
      kind: "preference",
      value: "Prefer planning on Friday afternoon.",
      source: "user_correction",
      allowedScopes: ["local_planning", "resident_behavior"],
      now: "2026-03-01T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.planning_window",
      kind: "preference",
      value: "Prefer planning on Sunday evening.",
      source: "user_correction",
      allowedScopes: ["local_planning", "resident_behavior"],
      now: "2026-05-01T00:00:00.000Z",
    });

    const store = await loadRelationshipProfile(tmpDir);
    const active = selectActiveRelationshipProfileItems(store, "local_planning");
    const promptBlock = formatRelationshipProfilePromptBlock(store, "local_planning");
    const retrievedRefs = active.map((item) => `${item.stable_key}:v${item.version}`);
    return {
      scenario_id: "profile-preference-changes",
      expected_refs: ["user.preference.planning_window:v3"],
      retrieved_refs: retrievedRefs,
      stale_refs: retrievedRefs.filter((ref) =>
        ref === "user.preference.planning_window:v1" || ref === "user.preference.planning_window:v2"
      ),
      sensitive_refs: [],
      ...(promptBlock.includes("Sunday evening") ? {} : { stale_refs: ["missing-current-profile"] }),
    };
  }

  async function evaluateCorrectedMemoryReuse(): Promise<LifelongEvalScenario> {
    const stale = await knowledgeManager.saveAgentMemory({
      key: "user.travel.window",
      value: "The user prefers trips in August.",
      tags: ["travel", "preference"],
      memory_type: "preference",
    });
    await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: stale.id },
      reason: "User corrected their travel availability.",
      replacementKey: "user.travel.window.current",
      replacementValue: "The user prefers trips in October.",
      now: "2026-04-01T00:00:00.000Z",
    });

    const retrieved = await knowledgeManager.recallAgentMemory("travel", {
      consent_scope: "local_planning",
      max_sensitivity: "local",
      limit: 20,
    });
    const retrievedRefs = retrieved.map((entry) => entry.key);
    return {
      scenario_id: "corrected-memory-reuse",
      expected_refs: ["user.travel.window.current"],
      retrieved_refs: retrievedRefs,
      corrected_expected_refs: ["user.travel.window.current"],
      corrected_retrieved_refs: retrievedRefs.filter((ref) => ref === "user.travel.window.current"),
      stale_refs: retrievedRefs.filter((ref) => ref === "user.travel.window"),
      sensitive_refs: [],
    };
  }

  async function evaluateSensitiveScope(): Promise<LifelongEvalScenario> {
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.boundary.health",
      kind: "boundary",
      value: "Do not expose health context outside explicit review.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["local_planning", "user_facing_review"],
      now: "2026-02-01T00:00:00.000Z",
    });
    await knowledgeManager.saveAgentMemory({
      key: "user.health.private",
      value: "Secret health context.",
      tags: ["health"],
      memory_type: "observation",
      governance: {
        sensitivity: "secret",
        consent: {
          scope_id: "private_review",
          allowed_contexts: ["private_review"],
        },
      },
    });

    const store = await loadRelationshipProfile(tmpDir);
    const promptBlock = formatRelationshipProfilePromptBlock(store, "local_planning");
    const profileRefs = selectActiveRelationshipProfileItems(store, "local_planning")
      .filter((item) => item.stable_key === "user.boundary.health")
      .map((item) => item.stable_key);
    const memories = await knowledgeManager.recallAgentMemory("health", {
      consent_scope: "local_planning",
      max_sensitivity: "local",
      limit: 20,
    });
    const retrievedRefs = [...profileRefs, ...memories.map((entry) => entry.key)];
    return {
      scenario_id: "sensitive-scope-filtering",
      expected_refs: [],
      retrieved_refs: retrievedRefs,
      stale_refs: [],
      sensitive_refs: [
        ...retrievedRefs.filter((ref) => ref === "user.boundary.health" || ref === "user.health.private"),
        ...(promptBlock.includes("health context") ? ["user.boundary.health"] : []),
      ],
    };
  }

  async function evaluateStaleProfileReconfirmation(): Promise<LifelongEvalScenario> {
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.intervention.proactivity",
      kind: "intervention_policy",
      value: "Proactive suggestions are welcome without confirmation.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      now: "2026-01-15T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.intervention.proactivity",
      kind: "intervention_policy",
      value: "Ask before frequent proactive suggestions.",
      source: "user_correction",
      allowedScopes: ["resident_behavior"],
      now: "2026-05-01T00:00:00.000Z",
    });

    const store = await loadRelationshipProfile(tmpDir);
    const active = selectActiveRelationshipProfileItems(store, "resident_behavior")
      .filter((item) => item.stable_key === "user.intervention.proactivity");
    const retrievedRefs = active.map((item) => `${item.stable_key}:v${item.version}`);
    return {
      scenario_id: "stale-profile-reconfirmation",
      expected_refs: ["user.intervention.proactivity:v2"],
      retrieved_refs: retrievedRefs,
      stale_refs: retrievedRefs.filter((ref) => ref === "user.intervention.proactivity:v1"),
      sensitive_refs: [],
    };
  }

  async function evaluateLongHorizonRetrieval(): Promise<LifelongEvalScenario> {
    await knowledgeManager.saveAgentMemory({
      key: "user.travel.required_documents.current",
      value: "For travel planning, remember passport renewal and visa status.",
      tags: ["travel", "planning"],
      memory_type: "fact",
    });
    await knowledgeManager.saveAgentMemory({
      key: "user.travel.budget.current",
      value: "For travel planning, keep a flexible budget buffer.",
      tags: ["travel", "planning"],
      memory_type: "preference",
    });
    const memoryStore = await knowledgeManager.loadAgentMemoryStore();
    for (let month = 1; month <= 12; month += 1) {
      for (let index = 0; index < 84; index += 1) {
        memoryStore.entries.push(AgentMemoryEntrySchema.parse({
          id: randomUUID(),
          key: `daily.note.${month}.${index}`,
          value: `Routine daily note ${month}-${index}.`,
          tags: ["daily"],
          memory_type: "observation",
          created_at: EVALUATED_AT,
          updated_at: EVALUATED_AT,
        }));
      }
    }
    await knowledgeManager.saveAgentMemoryStore(memoryStore);

    const retrieved = await knowledgeManager.recallAgentMemory("travel", {
      consent_scope: "local_planning",
      max_sensitivity: "local",
      limit: 10,
    });
    const retrievedRefs = retrieved.map((entry) => entry.key);
    return {
      scenario_id: "long-horizon-retrieval",
      expected_refs: [
        "user.travel.window.current",
        "user.travel.required_documents.current",
        "user.travel.budget.current",
      ],
      retrieved_refs: retrievedRefs,
      stale_refs: retrievedRefs.filter((ref) => ref.startsWith("daily.note.")),
      sensitive_refs: [],
    };
  }

  async function evaluateProactiveInterventionPolicy(): Promise<LifelongAgentEvalMetrics["proactive_intervention_quality"]> {
    const store = new ProactiveInterventionStore(runtimeRoot);
    const interventions = [
      { id: "proactive-accepted", at: "2026-05-02T00:00:00.000Z", outcome: "accepted" as const },
      { id: "proactive-ignored", at: "2026-05-02T01:00:00.000Z", outcome: "ignored" as const },
      { id: "proactive-corrected", at: "2026-05-02T02:00:00.000Z", outcome: "corrected" as const },
      { id: "proactive-overreach", at: "2026-05-02T03:00:00.000Z", outcome: "overreach" as const },
    ];
    for (const intervention of interventions) {
      await store.appendIntervention({
        activity: {
          intervention_id: intervention.id,
          kind: "suggestion",
          trigger: "proactive_tick",
          summary: `Synthetic proactive intervention ${intervention.id}.`,
          recorded_at: intervention.at,
        },
      });
      await store.appendFeedback({
        interventionId: intervention.id,
        outcome: intervention.outcome,
        overreachIndicators: intervention.outcome === "overreach" ? ["too_frequent"] : [],
        reason: intervention.outcome === "overreach" ? "User said this is too frequent." : undefined,
        recordedAt: new Date(new Date(intervention.at).getTime() + 60_000).toISOString(),
      });
    }
    const summary = await store.summarize();
    return {
      response_rate: summary.response_rate,
      accepted_rate: summary.accepted_rate,
      ignored_suggestion_rate: summary.ignored_rate,
      correction_rate: summary.correction_rate,
      overreach_rate: summary.overreach_rate,
      policy_recommendation: summary.policy_adjustment_recommendation?.suggested_action ?? null,
    };
  }
});

function buildMetrics(
  scenarios: LifelongEvalScenario[],
  proactiveQuality: LifelongAgentEvalMetrics["proactive_intervention_quality"],
  artifactPath: string,
): LifelongAgentEvalMetrics {
  const expectedTotal = scenarios.reduce((sum, scenario) => sum + scenario.expected_refs.length, 0);
  const retrievedTotal = scenarios.reduce((sum, scenario) => sum + scenario.retrieved_refs.length, 0);
  const relevantRetrieved = scenarios.reduce((sum, scenario) =>
    sum + scenario.expected_refs.filter((ref) => scenario.retrieved_refs.includes(ref)).length,
  0);
  const completeHits = scenarios.filter((scenario) =>
    scenario.expected_refs.every((ref) => scenario.retrieved_refs.includes(ref))
  ).length;
  const staleTotal = scenarios.reduce((sum, scenario) => sum + scenario.stale_refs.length, 0);
  const sensitiveTotal = scenarios.reduce((sum, scenario) => sum + scenario.sensitive_refs.length, 0);
  const correctedExpectedTotal = scenarios.reduce((sum, scenario) => sum + (scenario.corrected_expected_refs?.length ?? 0), 0);
  const correctedRetrievedTotal = scenarios.reduce((sum, scenario) =>
    sum + (scenario.corrected_expected_refs ?? []).filter((ref) => scenario.corrected_retrieved_refs?.includes(ref)).length,
  0);

  return {
    schema_version: "lifelong-agent-memory-profile-eval-v1",
    evaluated_at: EVALUATED_AT,
    scenario_count: scenarios.length,
    memory_retrieval_hit_rate: rate(completeHits, scenarios.length),
    precision_at_k: rate(relevantRetrieved, retrievedTotal),
    expected_item_recall: rate(relevantRetrieved, expectedTotal),
    stale_memory_false_positive_rate: rate(staleTotal, retrievedTotal),
    corrected_memory_reuse_rate: rate(correctedRetrievedTotal, correctedExpectedTotal),
    sensitive_memory_leak_rate: rate(sensitiveTotal, Math.max(1, retrievedTotal + sensitiveTotal)),
    active_profile_latest_rate: rate(
      scenarios.filter((scenario) =>
        scenario.scenario_id.includes("profile") && scenario.expected_refs.every((ref) => scenario.retrieved_refs.includes(ref))
      ).length,
      scenarios.filter((scenario) => scenario.scenario_id.includes("profile")).length,
    ),
    profile_stale_reuse_rate: rate(
      scenarios.filter((scenario) => scenario.scenario_id.includes("profile")).reduce((sum, scenario) => sum + scenario.stale_refs.length, 0),
      scenarios.filter((scenario) => scenario.scenario_id.includes("profile")).reduce((sum, scenario) => sum + scenario.retrieved_refs.length, 0),
    ),
    proactive_intervention_quality: proactiveQuality,
    scenarios,
    artifact_paths: {
      json_path: artifactPath,
    },
  };
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}
