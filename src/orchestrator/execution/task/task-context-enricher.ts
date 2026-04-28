import type { Logger } from "../../../runtime/logger.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { loadDreamActivationState } from "../../../platform/dream/dream-activation.js";
import { getFailureReflectionsForGoal, formatReflectionsForPrompt } from "../reflection-generator.js";

interface BuildEnrichedKnowledgeContextParams {
  goalId: string;
  knowledgeContext?: string;
  knowledgeTransfer?: KnowledgeTransfer;
  knowledgeManager?: KnowledgeManager;
  stateManager: StateManager;
  logger?: Logger;
}

export async function buildEnrichedKnowledgeContext(
  params: BuildEnrichedKnowledgeContextParams
): Promise<string | undefined> {
  const {
    goalId,
    knowledgeContext,
    knowledgeTransfer,
    knowledgeManager,
    stateManager,
    logger,
  } = params;

  let enrichedKnowledgeContext = knowledgeContext;
  const dreamActivation = await loadDreamActivationState(stateManager.getBaseDir()).catch(() => null);
  const verifiedPlannerHintsOnly = dreamActivation?.flags.verifiedPlannerHintsOnly ?? true;

  if (knowledgeTransfer && !verifiedPlannerHintsOnly) {
    try {
      const { contextSnippets } = await knowledgeTransfer.detectCandidatesRealtime(goalId);
      if (contextSnippets.length > 0) {
        const snippetText = contextSnippets.join("\n");
        enrichedKnowledgeContext = knowledgeContext
          ? `${knowledgeContext}\n${snippetText}`
          : snippetText;
      }
    } catch (err) {
      logger?.warn(
        `[TaskLifecycle] Knowledge transfer candidate detection failed (proceeding without enrichment): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!knowledgeManager) return enrichedKnowledgeContext;

  try {
    const pastReflections = await getFailureReflectionsForGoal(knowledgeManager, goalId, 5, logger);
    if (pastReflections.length > 0) {
      const reflectionText = formatReflectionsForPrompt(pastReflections);
      enrichedKnowledgeContext = enrichedKnowledgeContext
        ? `${enrichedKnowledgeContext}\n${reflectionText}`
        : reflectionText;
    }
  } catch (err) {
    logger?.warn(
      `[TaskLifecycle] Failed to load past reflections (proceeding without): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return enrichedKnowledgeContext;
}
