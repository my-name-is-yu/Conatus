import { describe, expect, it } from "vitest";
import { IngressRouter, buildStandaloneIngressMessage } from "../ingress-router.js";
import type { RunSpec } from "../../../runtime/run-spec/index.js";

describe("IngressRouter", () => {
  const router = new IngressRouter();

  it("routes ordinary natural-language input to agent_loop when available", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What route should answer this?",
        channel: "plugin_gateway",
        platform: "discord",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
	      {
	        hasAgentLoop: true,
	        hasToolLoop: true,
	      }
	    );

    expect(route.kind).toBe("agent_loop");
    expect(route.replyTargetPolicy).toBe("turn_reply_target");
  });

  it("falls back to tool_loop when the native agent loop is unavailable", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What files changed?",
      }),
      {
        hasAgentLoop: false,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("tool_loop");
  });

  it("routes explicit runtime-control requests when allowed", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
	    {
	      hasAgentLoop: true,
	      hasToolLoop: true,
	      hasRuntimeControlService: true,
	      runtimeControlIntent: {
	        kind: "restart_daemon",
	        reason: "LLM classified daemon restart",
	      },
	    }
	  );

	    expect(route.kind).toBe("runtime_control");
	    expect(route.eventProjectionPolicy).toBe("latest_active_reply_target");
	  });

	  it("fails closed for runtime-control text when the service is not wired", () => {
	    const route = router.selectRoute(
	      buildStandaloneIngressMessage({
	        text: "PulSeed を再起動して",
	        channel: "tui",
	        platform: "local_tui",
	        runtimeControl: {
	          allowed: true,
	          approvalMode: "interactive",
	        },
	      }),
	      {
	        hasAgentLoop: true,
	        hasToolLoop: true,
	        hasRuntimeControlService: false,
	        runtimeControlIntent: {
	          kind: "restart_daemon",
	          reason: "LLM classified daemon restart",
	        },
	      }
	    );

	    expect(route.kind).toBe("runtime_control_blocked");
      expect(route.reason).toBe("runtime_control_unavailable");
	  });

  it("fails closed for runtime-control text when ingress policy disallows it", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
        hasRuntimeControlService: true,
        runtimeControlIntent: {
          kind: "restart_daemon",
          reason: "LLM classified daemon restart",
        },
      }
    );

    expect(route.kind).toBe("runtime_control_blocked");
    expect(route.reason).toBe("runtime_control_disallowed");
  });

  it("fails closed for explicit runtime-control metadata when intent is unclassified", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "do the protected lifecycle thing",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
        metadata: { runtime_control_explicit: true },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
        hasRuntimeControlService: true,
        runtimeControlExplicitButUnclassified: true,
      }
    );

    expect(route.kind).toBe("runtime_control_blocked");
    expect(route.reason).toBe("runtime_control_unclassified");
  });

  it("keeps long-running natural-language work on agent_loop so tools can decide handoff", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98行くまで取り組んで",
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
    expect(route.eventProjectionPolicy).toBe("turn_only");
  });

  it("does not attach keyword-derived RunSpec intent on the sync ingress route", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
    expect(route).not.toHaveProperty("runSpecIntent");
  });

  it("does not classify Japanese threshold phrasing with regex-based daemon routing", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98超えるまで色々やってほしい",
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });

  it("routes a precomputed typed RunSpec draft without keyword-derived route logic", () => {
    const draft = {
      schema_version: "run-spec-v1",
      id: "runspec-00000000-0000-4000-8000-000000000001",
      status: "draft",
      profile: "kaggle",
      source_text: "Kaggle score 0.98を超えるまで長期で回して",
      objective: "Improve Kaggle score until it exceeds 0.98",
      workspace: { path: "/repo/kaggle", source: "context", confidence: "medium" },
      execution_target: { kind: "daemon", remote_host: null, confidence: "medium" },
      metric: {
        name: "kaggle_score",
        direction: "maximize",
        target: 0.98,
        target_rank_percent: null,
        datasource: "kaggle_leaderboard",
        confidence: "high",
      },
      progress_contract: {
        kind: "metric_target",
        dimension: "kaggle_score",
        threshold: 0.98,
        semantics: "Kaggle score exceeds 0.98.",
        confidence: "high",
      },
      deadline: null,
      budget: { max_trials: null, max_wall_clock_minutes: null, resident_policy: "best_effort" },
      approval_policy: {
        submit: "approval_required",
        publish: "unspecified",
        secret: "approval_required",
        external_action: "approval_required",
        irreversible_action: "approval_required",
      },
      artifact_contract: { expected_artifacts: [], discovery_globs: [], primary_outputs: [] },
      risk_flags: ["external_submit_requires_approval"],
      missing_fields: [],
      confidence: "high",
      links: { goal_id: null, runtime_session_id: null, conversation_id: "chat-1" },
      origin: { channel: "plugin_gateway", session_id: "chat-1", reply_target: null, metadata: {} },
      created_at: "2026-05-03T00:00:00.000Z",
      updated_at: "2026-05-03T00:00:00.000Z",
    } satisfies RunSpec;
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: draft.source_text,
        channel: "plugin_gateway",
        platform: "telegram",
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
        runSpecDraft: draft,
      }
    );

    expect(route.kind).toBe("run_spec_draft");
    expect(route.reason).toBe("run_spec_draft_intent");
  });

  it("keeps long-running work on agent_loop when runtime control is disallowed", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98行くまで取り組んで",
        channel: "plugin_gateway",
        platform: "slack",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });

  it("keeps explanatory long-running-task questions on agent_loop", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "長期タスクだとどうしてエラーになるの？",
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });
});
