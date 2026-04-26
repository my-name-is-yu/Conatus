import { z } from "zod";
import { SearchOrchestrator } from "../../../platform/code-search/orchestrator.js";
import { validateFilePath } from "../../fs/FileValidationTool/FileValidationTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const CodeSearchInputSchema = z.object({
  task: z.string().min(1),
  intent: z.enum(["bugfix", "test_failure", "feature_addition", "refactor", "explain", "api_change", "config_fix", "security_review", "unknown"]).optional(),
  queryTerms: z.array(z.string()).optional(),
  stacktrace: z.string().optional(),
  fileGlobs: z.array(z.string()).optional(),
  packageScope: z.string().optional(),
  path: z.string().optional(),
  budget: z.object({
    maxFiles: z.number().int().positive().optional(),
    maxCandidatesPerRetriever: z.number().int().positive().optional(),
    maxFusionCandidates: z.number().int().positive().optional(),
    maxRerankCandidates: z.number().int().positive().optional(),
  }).optional(),
});
export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>;

export class CodeSearchTool implements ITool<CodeSearchInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "code_search",
    aliases: ["code-search", "structured_code_search"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = CodeSearchInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: CodeSearchInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.path ? validateFilePath(input.path, context.cwd).resolved : context.cwd;
    const orchestrator = new SearchOrchestrator(cwd);
    const session = await orchestrator.searchWithState({ ...input, cwd });
    return {
      success: true,
      data: {
        queryId: session.queryId,
        candidates: session.candidates,
        trace: session.trace,
        warnings: session.trace.warnings,
      },
      summary: `Code search returned ${session.candidates.length} ranked candidates for ${input.intent ?? "inferred"} intent`,
      durationMs: Date.now() - startTime,
      artifacts: session.candidates.map((candidate) => candidate.file),
    };
  }

  async checkPermissions(input: CodeSearchInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context || !input.path) return { status: "allowed" };
    const validation = validateFilePath(input.path, context.cwd, context.executionPolicy?.protectedPaths);
    if (!validation.valid) {
      return { status: "needs_approval", reason: `Searching outside the working directory: ${validation.resolved}` };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
