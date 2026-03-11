#!/usr/bin/env node
// ─── TUI Entry Point ───
//
// Wires all Motiva dependencies (mirrors CLIRunner.buildDeps pattern) and
// renders the Ink-based TUI. Use `motiva tui` or `npm run tui` to launch.

import { render } from "ink";
import React from "react";

import { StateManager } from "../state-manager.js";
import { LLMClient } from "../llm-client.js";
import { TrustManager } from "../trust-manager.js";
import { DriveSystem } from "../drive-system.js";
import { ObservationEngine } from "../observation-engine.js";
import { StallDetector } from "../stall-detector.js";
import { SatisficingJudge } from "../satisficing-judge.js";
import { EthicsGate } from "../ethics-gate.js";
import { SessionManager } from "../session-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import { GoalNegotiator } from "../goal-negotiator.js";
import { AdapterRegistry } from "../adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "../adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "../adapters/claude-api.js";
import { TaskLifecycle } from "../task-lifecycle.js";
import { ReportingEngine } from "../reporting-engine.js";
import { CoreLoop } from "../core-loop.js";
import * as GapCalculator from "../gap-calculator.js";
import * as DriveScorer from "../drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule } from "../core-loop.js";

import { App } from "./app.js";
import { LoopController } from "./use-loop.js";
import { ActionHandler } from "./actions.js";
import { IntentRecognizer } from "./intent-recognizer.js";

// ─── Dependency Wiring ───

function buildDeps(apiKey: string) {
  const stateManager = new StateManager();
  const llmClient = new LLMClient(apiKey);
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const observationEngine = new ObservationEngine(stateManager);
  const stallDetector = new StallDetector(stateManager);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const sessionManager = new SessionManager(stateManager);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const adapterRegistry = new AdapterRegistry();

  // Register default adapters
  adapterRegistry.register(new ClaudeCodeCLIAdapter());
  adapterRegistry.register(new ClaudeAPIAdapter(llmClient));

  // TUI approval: auto-approve (user interacts via chat, not readline prompts)
  // TODO(Phase 2): Implement chat-based approval prompt that routes through Ink render loop
  const approvalFn = async () => true;

  const taskLifecycle = new TaskLifecycle(
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    { approvalFn }
  );

  const reportingEngine = new ReportingEngine(stateManager);

  // Wrap pure-function modules to satisfy GapCalculatorModule / DriveScorerModule
  const gapCalculator: GapCalculatorModule = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer: DriveScorerModule = {
    scoreAllDimensions: (gapVector, context, _config) =>
      DriveScorer.scoreAllDimensions(gapVector, context),
    rankDimensions: DriveScorer.rankDimensions,
  };

  const coreLoop = new CoreLoop({
    stateManager,
    observationEngine,
    gapCalculator,
    driveScorer,
    taskLifecycle,
    satisficingJudge,
    stallDetector,
    strategyManager,
    reportingEngine,
    driveSystem,
    adapterRegistry,
  });

  const goalNegotiator = new GoalNegotiator(
    stateManager,
    llmClient,
    ethicsGate,
    observationEngine
  );

  return { stateManager, llmClient, trustManager, coreLoop, goalNegotiator, reportingEngine };
}

// ─── TUI Entry ───

export async function startTUI(): Promise<void> {
  // 1. Require API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=<your-key>"
    );
    process.exit(1);
  }

  // 2. Wire all dependencies
  let deps: ReturnType<typeof buildDeps>;
  try {
    deps = buildDeps(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to initialise dependencies: ${message}`);
    process.exit(1);
  }

  const { stateManager, llmClient, trustManager, coreLoop, goalNegotiator, reportingEngine } = deps;

  // Issue 5: Warn about auto-approval safety
  console.warn(
    "⚠ Warning: TUI currently auto-approves all tasks. Use CLI mode for irreversible task safety."
  );

  // 3. Create TUI-specific instances
  const loopController = new LoopController(coreLoop, stateManager, trustManager);
  const actionHandler = new ActionHandler({
    stateManager,
    goalNegotiator,
    reportingEngine,
  });
  const intentRecognizer = new IntentRecognizer(llmClient);

  // 4. Handle SIGINT/SIGTERM gracefully before rendering
  const shutdown = () => {
    loopController.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 5. Render Ink app
  const { waitUntilExit } = render(
    React.createElement(App, { loopController, actionHandler, intentRecognizer })
  );

  await waitUntilExit();
}

// ─── CLI entry (when run directly as a binary) ───

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("entry.js") || process.argv[1].endsWith("entry.ts"));

if (isMain) {
  startTUI().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
