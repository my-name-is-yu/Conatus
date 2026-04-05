# Write-Tool Integration Plan

## 1. Overview

PulSeed's chat interface has grown organically — read tools in one file, mutation tools split across two others, and approval logic split between programmatic guards and conversational prompts. This plan unifies the tool system under a single registry, inspired by Claude Code's declarative patterns. The goal is consistency, testability, and a clean path to CoreLoop deep integration.

Problems to solve:
- Two approval mechanisms (programmatic `checkApproval` + conversational prompt) — inconsistent behavior
- Tool results use `role: "user"` instead of `role: "tool"` — breaks standard LLM tool-call protocol
- `toggle_plugin` is a stub returning an error; `update_config` supports only `daemon_mode` key
- No unified registry — tools scattered across three files
- Only `delete_goal` has rich LLM-facing descriptions; others are bare

---

## 2. Unified ToolDefinition Type

New file: `src/interface/chat/tool-registry.ts`

```typescript
import { z } from "zod";
import type { StateManager } from "../../state-manager.js";
import type { LLMClient } from "../../llm-client.js";

export interface ToolDefinition {
  name: string;
  description: string;              // Rich, LLM-friendly description
  parameters: z.ZodSchema;          // Converted to JSON Schema for LLM calls
  isReadOnly: boolean;              // Default: false (safe side)
  approvalLevel: "none" | "conversational" | "required";
  statusVerb: string;               // e.g., "Deleting", "Updating", "Archiving"
  statusArgKey?: string;            // Parameter key to show in status (e.g., "goal_id")
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;                   // Errors returned as data, never thrown
}

export interface ToolContext {
  stateManager: StateManager;
  llmClient: LLMClient;
  approvalFn?: (description: string) => Promise<boolean>;
  onStatus?: (text: string) => void;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.tools.set(tool.name, tool); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  all(): ToolDefinition[] { return Array.from(this.tools.values()); }
  readOnly(): ToolDefinition[] { return this.all().filter(t => t.isReadOnly); }
}

export class ToolDispatcher {
  constructor(private registry: ToolRegistry) {}
  private denialCount = 0;
  private confirmationMode = false;

  async dispatch(name: string, params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}` };

    const parsed = tool.parameters.safeParse(params);
    if (!parsed.success) return { success: false, error: `Invalid params: ${parsed.error.message}` };

    if (tool.approvalLevel === "required" || this.confirmationMode) {
      const approved = await ctx.approvalFn?.(`Execute ${name}?`) ?? false;
      if (!approved) {
        this.denialCount++;
        if (this.denialCount >= 3) this.confirmationMode = true;
        return { success: false, error: "User denied" };
      }
      this.denialCount = 0;
    }

    const statusText = `${tool.statusVerb} ${tool.statusArgKey ? (params as Record<string, unknown>)[tool.statusArgKey] : tool.name}`;
    ctx.onStatus?.(statusText);

    try {
      return await tool.execute(parsed.data, ctx);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}
```

---

## 3. Three-Phase Plan

### Phase A: Tool Registry Unification

**Goal**: Single registry, fix `role: "tool"`, backward-compatible migration.

1. Create `src/interface/chat/tool-registry.ts` with types above.
2. Move read tools from `self-knowledge-tools.ts` into registry; old file re-exports.
3. Move mutation tools from `mutation-tool-defs.ts` + `self-knowledge-mutation-tools.ts` into registry.
4. In `chat-runner.ts`: use `ToolDispatcher.dispatch()`, fix role to `"tool"`.
5. Add `tool-registry.test.ts`.

**Approval mapping**:
| Tool | approvalLevel |
|------|--------------|
| get_goals, get_sessions, get_trust_state, get_config, get_plugins | none (read-only) |
| set_goal, update_goal, delete_goal, update_config | none (conversational) |
| archive_goal, reset_trust, toggle_plugin | required |

### Phase B: Mutation Tool Expansion

**Goal**: Complete stubs, expand config coverage, add rich descriptions only for irreversible/damaging operations.

1. **Complete `toggle_plugin`**: implement actual plugin enable/disable via `PluginLoader`.
2. **Expand `update_config`**: read all supported keys from `CONFIG_METADATA` (defined in `src/base/config/config-metadata.ts`, which re-exports from `tool-metadata.ts`). Validate value type per key before writing.
3. **Rich descriptions**: add `MutationToolMeta` only for irreversible or potentially damaging operations (`delete_goal`, `reset_trust`). Other mutation tools (`set_goal`, `update_goal`, `update_config`, etc.) proceed without rich descriptions to maintain execution speed.
4. **Unify approval**: remove old `checkApproval` calls; all approval via `ToolDispatcher`.
5. **PreToolUse semantic hook**: add semantic validation (e.g., reject `archive_goal` if goal is running).

### Phase C: CoreLoop Deep Integration

**Goal**: ObservationEngine and StrategyManager can use tools; results flow back into state.

This phase is **additive** — no breaking changes. See also: `docs/design/core/tool-system.md`.

1. **ObservationEngine**: inject read-only `ToolRegistry`; merge tool results with LLM observation.
2. **GapCalculator**: optional `verify` tool hook to cross-check gap measurements.
3. **StrategyManager**: include available tool names in LLM context.
4. **CoreLoop**: wire `ToolResult` objects into session state for next observation.

```typescript
// Injection pattern — no global registry
class ObservationEngine {
  constructor(private llmClient: LLMClient, private readOnlyTools: ToolDefinition[]) {}
}
```

---

## 4. Migration Strategy

| Phase | Breaking? | Backward Compat Mechanism |
|-------|-----------|--------------------------|
| A | No | Old files re-export from registry; callers unchanged |
| B | Minimal | `checkApproval` callers need one-line update to use dispatcher |
| C | No | Additive injection — existing CoreLoop callers unchanged |

Recommended order: A → B → C. Each phase is independently shippable.

---

## 5. File Impact Summary

| File | Phase | Action |
|------|-------|--------|
| `src/interface/chat/tool-registry.ts` | A | Create |
| `src/interface/chat/self-knowledge-tools.ts` | A | Refactor (re-export) |
| `src/interface/chat/mutation-tool-defs.ts` | A | Refactor (re-export) |
| `src/interface/chat/self-knowledge-mutation-tools.ts` | A | Refactor (re-export) |
| `src/interface/chat/chat-runner.ts` | A | Fix role + use dispatcher; pass onStatus callback |
| `src/interface/chat/__tests__/tool-registry.test.ts` | A | Create |
| `src/interface/tui/tool-status.tsx` | A | Create — status display component |
| `src/interface/chat/tool-metadata.ts` | B | Expand all tool descriptions |
| toggle_plugin handler | B | Implement |
| update_config handler | B | Expand keys |
| `src/observation-engine.ts` | C | Inject read-only tools |
| `src/gap-calculator.ts` | C | Optional verify hook |
| `src/strategy/strategy-manager.ts` | C | Tool-aware context |
| `src/core-loop.ts` | C | Wire tool results to state |
| `src/__tests__/integration/tool-coreloop.test.ts` | C | Create |

Total: 9 files modified, 4 files created.

---

## 6. Real-Time Tool Status Display

`statusVerb` and `statusArgKey` are part of `ToolDefinition` (Section 2). `ToolContext.onStatus` (Section 2) delivers status text to the TUI. The dispatcher emits status before each tool execution.

Tool status display is separate from spinner verbs: spinners = LLM thinking; tool status = specific action in progress.

```typescript
// src/interface/tui/tool-status.tsx (new, Phase A)
const ToolStatusLine: FC<{ status: string | null }> = ({ status }) => {
  if (!status) return null;
  return <Text dimColor>  ⚡ {status}</Text>;
};
```

| Tool | statusVerb | statusArgKey |
|------|-----------|-------------|
| get_goals | Fetching goals | — |
| get_sessions | Fetching sessions | — |
| get_trust_state | Checking trust | — |
| get_config | Reading config | — |
| get_plugins | Listing plugins | — |
| set_goal | Creating goal | description |
| update_goal | Updating goal | goal_id |
| archive_goal | Archiving goal | goal_id |
| delete_goal | Deleting goal | goal_id |
| toggle_plugin | Toggling plugin | plugin_name |
| update_config | Updating config | key |
| reset_trust | Resetting trust | — |

---

## 7. Test Strategy

**Unit tests** (Phase A — `tool-registry.test.ts`):
- Register + dispatch valid params → success
- Unknown tool → `{ success: false, error: "Unknown tool: ..." }`
- Invalid params fail at Zod parse, before approval or execution
- `approvalLevel: "required"` calls `approvalFn`; denial returns error, does not throw
- 3 consecutive denials → `confirmationMode = true`
- Exception inside `execute` caught, returned as `ToolResult`

**Mutation tool tests** (Phase B):
- `toggle_plugin` — enable/disable round-trip; verify PluginLoader called
- `update_config` — all CONFIG_METADATA keys accepted; unknown key rejected
- No tool calls `checkApproval` directly (approval via dispatcher only)

**Integration tests** (Phase C — `tool-coreloop.test.ts`):
- Chat → tool call → state mutation → next LLM turn sees updated state
- ObservationEngine with injected read-only tools produces richer observation
- CoreLoop full round-trip with tool results in session state
