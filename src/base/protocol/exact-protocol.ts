export const EXACT_PROTOCOL_SURFACES = [
  "slash_command",
  "cli_flag",
  "id",
  "path",
  "url",
  "enum_schema",
  "feature_flag",
  "wire_token",
  "mention",
] as const;

export type ExactProtocolSurface = typeof EXACT_PROTOCOL_SURFACES[number];

export interface ExactProtocolSurfaceDefinition {
  surface: ExactProtocolSurface;
  allowed: string;
  boundary: string;
  examples: readonly string[];
}

export const EXACT_PROTOCOL_SURFACE_DEFINITIONS: readonly ExactProtocolSurfaceDefinition[] = [
  {
    surface: "slash_command",
    allowed: "Leading slash or exact symbol commands with command-owned arguments.",
    boundary: "Do not treat bare words or sentences that mention command words as commands.",
    examples: ["/help", "/status goal-123", "?"],
  },
  {
    surface: "cli_flag",
    allowed: "CLI flags and their command-owned values.",
    boundary: "Flags are parsed only inside an already selected CLI or command grammar.",
    examples: ["--json", "--goal goal-123", "-y"],
  },
  {
    surface: "id",
    allowed: "Exact ids for goals, tasks, sessions, runs, approvals, and persisted records.",
    boundary: "Ids select typed fields; they do not infer a freeform user intent by themselves.",
    examples: ["goal-123", "session:conversation:abc", "approval-123"],
  },
  {
    surface: "path",
    allowed: "Filesystem paths validated by the owning operation.",
    boundary: "Paths validate operation fields; they are not a fallback semantic router for ordinary text.",
    examples: ["./src/index.ts", "/tmp/report.md", "~/workspace"],
  },
  {
    surface: "url",
    allowed: "URLs parsed by URL-aware callers.",
    boundary: "URLs can be extracted as exact references, not as intent keywords.",
    examples: ["https://example.com", "file:///tmp/report.md"],
  },
  {
    surface: "enum_schema",
    allowed: "Enum values and schema literals accepted by typed APIs.",
    boundary: "Schema validation must fail closed instead of guessing from prose.",
    examples: ["approve", "reject", "read_only"],
  },
  {
    surface: "feature_flag",
    allowed: "Named feature switches and boolean-like config values at config boundaries.",
    boundary: "Feature flags are exact config fields, not natural-language routing rules.",
    examples: ["agentloop-worktree=on", "PULSEED_DEV_MODE=1"],
  },
  {
    surface: "wire_token",
    allowed: "Protocol tokens from external transports and internal event streams.",
    boundary: "Wire tokens are interpreted only within their protocol envelope.",
    examples: ["event: notification_report", "tool_call", "app_mention"],
  },
  {
    surface: "mention",
    allowed: "Exact structured mention tokens that name a target namespace and id.",
    boundary: "Do not select targets by fuzzy labels, titles, or prose references.",
    examples: ["@run:run-123", "@session:conversation:abc", "@goal:goal-123"],
  },
] as const;

export interface ExactSlashCommandDefinition<TCommand extends string = string> {
  command: TCommand;
  aliases?: readonly string[];
  allowArguments?: boolean;
}

export interface ExactSlashCommandOptions<TCommand extends string = string> {
  bareSymbolCommands?: Readonly<Record<string, TCommand>>;
}

export interface ParsedExactSlashCommand<TCommand extends string = string> {
  surface: "slash_command";
  rawInput: string;
  normalizedInput: string;
  command: TCommand;
  alias: string;
  rawArgs: string;
}

export interface ParsedExactSlashCommandToken {
  surface: "slash_command";
  rawInput: string;
  command: string;
  rawArgs: string;
}

export const EXACT_MENTION_KINDS = [
  "session",
  "run",
  "goal",
  "task",
  "file",
  "url",
  "tool",
  "skill",
  "plugin",
] as const;

export type ExactMentionKind = typeof EXACT_MENTION_KINDS[number];

export interface ParsedExactMentionToken {
  surface: "mention";
  rawInput: string;
  kind: ExactMentionKind;
  id: string;
  target: string;
}

const WHITESPACE_PATTERN = /\s+/g;
const HAS_WHITESPACE_PATTERN = /\s/;
const MENTION_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MENTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const mentionKinds = new Set<string>(EXACT_MENTION_KINDS);

export function normalizeExactProtocolText(input: string): string {
  return input.trim().toLowerCase().replace(WHITESPACE_PATTERN, " ");
}

export function isExactProtocolSurface(value: string): value is ExactProtocolSurface {
  return (EXACT_PROTOCOL_SURFACES as readonly string[]).includes(value);
}

export function parseExactSlashCommandToken(input: string): ParsedExactSlashCommandToken | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return null;
  const [rawCommand = "", ...argTokens] = trimmed.split(WHITESPACE_PATTERN);
  const command = rawCommand.toLowerCase();
  if (!command || command === "/") return null;
  return {
    surface: "slash_command",
    rawInput: input,
    command,
    rawArgs: argTokens.join(" "),
  };
}

export function isExactSlashCommandInput(input: string): boolean {
  return parseExactSlashCommandToken(input) !== null;
}

export function parseExactSlashCommand<TCommand extends string>(
  input: string,
  definitions: readonly ExactSlashCommandDefinition<TCommand>[],
  options: ExactSlashCommandOptions<TCommand> = {},
): ParsedExactSlashCommand<TCommand> | null {
  const trimmed = input.trim();
  const normalizedInput = normalizeExactProtocolText(input);
  if (!normalizedInput) return null;

  const bareCommand = options.bareSymbolCommands?.[normalizedInput];
  if (bareCommand) {
    return {
      surface: "slash_command",
      rawInput: input,
      normalizedInput,
      command: bareCommand,
      alias: normalizedInput,
      rawArgs: "",
    };
  }

  if (!normalizedInput.startsWith("/")) return null;

  const normalizedTokens = normalizedInput.split(" ");
  const rawTokens = trimmed.split(WHITESPACE_PATTERN);
  const candidates = definitions.flatMap((definition) => {
    const aliases = [definition.command, ...(definition.aliases ?? [])];
    return aliases.map((alias) => ({
      definition,
      alias: normalizeExactProtocolText(alias),
    }));
  }).sort((a, b) => b.alias.split(" ").length - a.alias.split(" ").length);

  for (const candidate of candidates) {
    const aliasTokens = candidate.alias.split(" ");
    const aliasMatches = aliasTokens.every((token, index) => normalizedTokens[index] === token);
    if (!aliasMatches) continue;

    const hasExtraArgs = normalizedTokens.length > aliasTokens.length;
    if (hasExtraArgs && !candidate.definition.allowArguments) continue;

    return {
      surface: "slash_command",
      rawInput: input,
      normalizedInput,
      command: candidate.definition.command,
      alias: candidate.alias,
      rawArgs: rawTokens.slice(aliasTokens.length).join(" ").trim(),
    };
  }

  return null;
}

export function parseExactMentionToken(input: string): ParsedExactMentionToken | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("@") || trimmed.length <= 1 || HAS_WHITESPACE_PATTERN.test(trimmed)) return null;

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 1 || separatorIndex === trimmed.length - 1) return null;

  const kind = trimmed.slice(1, separatorIndex).toLowerCase();
  const id = trimmed.slice(separatorIndex + 1);
  if (!MENTION_KIND_PATTERN.test(kind) || !mentionKinds.has(kind)) return null;
  if (!MENTION_ID_PATTERN.test(id)) return null;

  return {
    surface: "mention",
    rawInput: input,
    kind: kind as ExactMentionKind,
    id,
    target: `${kind}:${id}`,
  };
}
