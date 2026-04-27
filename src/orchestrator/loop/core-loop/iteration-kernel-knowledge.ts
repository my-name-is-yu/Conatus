import { loadDreamActivationState } from "../../../platform/dream/dream-activation.js";
import type { Goal } from "../../../base/types/goal.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { CoreLoopDeps } from "./contracts.js";
import type { Logger } from "../../../runtime/logger.js";

async function acquireAndPersistKnowledge(
  deps: CoreLoopDeps,
  logger: Logger | undefined,
  goalId: string,
  prompt: string
): Promise<number> {
  if (!deps.knowledgeManager || !deps.toolExecutor) return 0;
  const acquired = await deps.knowledgeManager.acquireWithTools(
    prompt,
    goalId,
    deps.toolExecutor,
    {
      cwd: process.cwd(),
      goalId,
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
    }
  );
  for (const entry of acquired) {
    await deps.knowledgeManager.saveKnowledge(goalId, entry);
  }
  logger?.debug("CoreLoop: knowledge acquisition completed", { goalId, acquiredCount: acquired.length });
  return acquired.length;
}

export async function autoAcquireKnowledgeForRefresh(
  deps: CoreLoopDeps,
  logger: Logger | undefined,
  goalId: string,
  question: string
): Promise<number> {
  return acquireAndPersistKnowledge(deps, logger, goalId, question);
}

export async function autoAcquireKnowledgeForDreamStall(
  deps: CoreLoopDeps,
  logger: Logger | undefined,
  goalId: string,
  goal: Goal,
  gapVector: GapVector
): Promise<number> {
  if (!deps.knowledgeManager || !deps.toolExecutor) return 0;

  const activation = await loadDreamActivationState(deps.stateManager.getBaseDir());
  if (!activation.flags.autoAcquireKnowledge) return 0;

  const portfolio = await Promise.resolve(deps.strategyManager.getPortfolio(goalId)).catch(() => null);
  const observationContext = {
    observations: goal.dimensions.map((dimension) => ({
      name: dimension.name,
      current_value: dimension.current_value,
      confidence: dimension.confidence,
    })),
    strategies: portfolio?.strategies ?? null,
    confidence:
      gapVector.gaps.reduce((sum, gap) => sum + gap.confidence, 0) /
      Math.max(gapVector.gaps.length, 1),
  };
  const gapSignal = await deps.knowledgeManager.detectKnowledgeGap(observationContext);
  if (!gapSignal) return 0;

  return acquireAndPersistKnowledge(deps, logger, goalId, gapSignal.missing_knowledge);
}
