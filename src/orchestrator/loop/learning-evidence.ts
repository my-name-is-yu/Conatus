/**
 * learning-evidence.ts — Tool-based evidence gathering for learning pipeline.
 */
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";

export interface LearningEvidence {
  recentChanges: string;
  artifactCount: number;
  errors: string[];
}

export async function gatherLearningEvidence(
  toolExecutor: ToolExecutor,
  toolContext: ToolCallContext,
  workspacePath?: string,
): Promise<LearningEvidence> {
  const evidence: LearningEvidence = {
    recentChanges: "",
    artifactCount: 0,
    errors: [],
  };

  // Gather recent git changes
  try {
    const diffResult = await toolExecutor.execute(
      "git_diff",
      { target: "unstaged", path: workspacePath ?? "." },
      toolContext,
    );
    if (diffResult.success && diffResult.data) {
      const raw = typeof diffResult.data === "string" ? diffResult.data : String(diffResult.data);
      // Truncate to 2000 chars to avoid bloating learning prompts
      evidence.recentChanges = raw.slice(0, 2000);
    }
  } catch (err) {
    evidence.errors.push(`git_diff: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Count workspace artifacts
  try {
    const globResult = await toolExecutor.execute(
      "glob",
      { pattern: "**/*" },
      toolContext,
    );
    if (globResult.success && globResult.data) {
      if (Array.isArray(globResult.data)) {
        evidence.artifactCount = globResult.data.filter(Boolean).length;
      } else {
        const raw = String(globResult.data);
        evidence.artifactCount = raw.split("\n").filter(Boolean).length;
      }
    }
  } catch (err) {
    evidence.errors.push(`glob: ${err instanceof Error ? err.message : String(err)}`);
  }

  return evidence;
}
