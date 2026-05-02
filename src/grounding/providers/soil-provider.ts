import type { ToolCallContext } from "../../tools/types.js";
import { SoilQueryTool } from "../../tools/query/SoilQueryTool/SoilQueryTool.js";
import { SqliteSoilRepository } from "../../platform/soil/sqlite-repository.js";
import type { GroundingProvider, GroundingSoilResult } from "../contracts.js";
import { makeSection, makeSource, soilRootFromHome, resolveHomeDir } from "./helpers.js";

function buildToolContext(cwd: string, goalId?: string): ToolCallContext {
  return {
    cwd,
    goalId: goalId ?? "grounding",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
  };
}

function shouldQuerySoil(query: string | undefined): query is string {
  return Boolean(query && query.trim().length >= 8);
}

function usageSummary(hit: { usageStats?: GroundingSoilResult["hits"][number]["usageStats"] }): string | null {
  const usage = hit.usageStats;
  if (!usage) return null;
  return `usage used=${usage.use_count} validated=${usage.validated_count} negative=${usage.negative_outcome_count}`;
}

async function recordGroundingUsage(rootDir: string, recordIds: string[]): Promise<void> {
  const ids = [...new Set(recordIds.filter((recordId) => recordId.length > 0))];
  if (ids.length === 0) return;
  const repository = await SqliteSoilRepository.create({ rootDir });
  try {
    await repository.recordUsage(ids);
  } finally {
    repository.close();
  }
}

export const soilKnowledgeProvider: GroundingProvider = {
  key: "soil_knowledge",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!shouldQuerySoil(query)) {
      return null;
    }

    let result: GroundingSoilResult | null = null;
    let defaultSqliteRootDir: string | null = null;
    if (context.request.soilQuery) {
      result = await context.request.soilQuery({
        query,
        rootDir: context.request.workspaceRoot ?? process.cwd(),
        limit: context.profile.budgets.maxKnowledgeHits,
      });
    } else {
      const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
      defaultSqliteRootDir = soilRootFromHome(homeDir);
      const tool = new SoilQueryTool();
      const toolResult = await tool.call({
        query,
        rootDir: defaultSqliteRootDir,
        limit: context.profile.budgets.maxKnowledgeHits,
      }, buildToolContext(context.request.workspaceRoot ?? process.cwd(), context.request.goalId));
      if (toolResult.success) {
        const data = toolResult.data as {
          retrievalSource: "sqlite" | "index" | "manifest";
          warnings: string[];
          hits: GroundingSoilResult["hits"];
        };
        result = {
          retrievalSource: data.retrievalSource,
          warnings: data.warnings,
          hits: data.hits,
        };
      }
    }

    const hits = result?.hits ?? [];
    context.runtime.set("soil_hit_count", hits.length);
    const admittedHits = hits.slice(0, context.profile.budgets.maxKnowledgeHits);
    if (result?.retrievalSource === "sqlite" && defaultSqliteRootDir) {
      await recordGroundingUsage(defaultSqliteRootDir, admittedHits.map((hit) => hit.recordId ?? ""));
    }
    const lines = admittedHits.map((hit) => {
      const detail = [hit.summary, hit.snippet, usageSummary(hit)].filter(Boolean).join(" | ");
      return `- ${hit.title} (${hit.soilId})${detail ? `: ${detail}` : ""}`;
    });
    const warnings = result?.warnings ?? [];
    const content = [
      lines.length > 0 ? lines.join("\n") : "No relevant Soil knowledge found.",
      warnings.length > 0 ? `Warnings: ${warnings.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    return makeSection(
      "soil_knowledge",
      content,
      [
        makeSource("soil_knowledge", "soil_query", {
          type: lines.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? `soil:${result?.retrievalSource ?? "unknown"}` : "none:soil_knowledge",
          metadata: { warnings },
        }),
      ],
    );
  },
};
