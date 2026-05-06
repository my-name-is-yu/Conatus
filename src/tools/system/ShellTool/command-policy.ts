import { isAbsolute, resolve } from "node:path";
import type { ExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import { isPathInsideProtectedRoots } from "../../../orchestrator/execution/agent-loop/self-protection.js";

export interface ShellCommandCapabilities {
  readOnly: boolean;
  localWrite: boolean;
  network: boolean;
  destructive: boolean;
  protectedTarget: boolean;
}

export interface ShellCommandAssessment {
  status: "allowed" | "needs_approval" | "denied";
  reason?: string;
  capabilities: ShellCommandCapabilities;
}

type ShellToken =
  | { kind: "word"; value: string }
  | { kind: "operator"; value: ShellOperator };

type ShellOperator =
  | "and"
  | "or"
  | "sequence"
  | "pipe"
  | "stdout_redirect"
  | "stdout_append"
  | "stderr_redirect"
  | "stderr_append"
  | "combined_redirect"
  | "stdin_redirect";

interface ShellSimpleCommand {
  executable: string;
  args: string[];
}

interface ShellCommandAnalysis {
  commands: ShellSimpleCommand[];
  pathTokens: string[];
  capabilities: ShellCommandCapabilities;
  unsupportedReason?: string;
}

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "pwd",
  "echo",
  "date",
  "hostname",
  "which",
  "type",
  "file",
  "rg",
  "find",
  "du",
  "df",
  "tree",
]);

const LOCAL_WRITE_COMMANDS = new Set([
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "tee",
  "apply_patch",
]);

const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "rsync"]);
const DESTRUCTIVE_COMMANDS = new Set(["rm", "mkfs", "dd", "shutdown", "reboot", "sudo"]);
const GIT_READ_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "rev-list", "describe"]);
const GIT_WRITE_SUBCOMMANDS = new Set(["apply", "checkout", "restore"]);
const GIT_NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "clone"]);
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set(["push", "commit", "merge", "rebase", "reset", "clean", "stash"]);
const NPM_READ_SUBCOMMANDS = new Set(["ls", "list", "view", "info", "outdated", "audit"]);
const NPM_WRITE_SUBCOMMANDS = new Set(["uninstall", "run", "exec"]);
const NPM_NETWORK_SUBCOMMANDS = new Set(["install", "publish"]);

export function assessShellCommand(
  command: string,
  policy?: ExecutionPolicy,
  _trusted = false,
  cwd?: string,
): ShellCommandAssessment {
  const analysis = analyzeShellCommand(command);
  const capabilities = { ...analysis.capabilities };

  if (analysis.unsupportedReason) {
    return {
      status: "denied",
      reason: analysis.unsupportedReason,
      capabilities,
    };
  }

  if ((capabilities.localWrite || !capabilities.readOnly) && targetsProtectedRoot(analysis.pathTokens, policy, cwd)) {
    capabilities.protectedTarget = true;
    return { status: "denied", reason: "Shell command would mutate a protected PulSeed source root", capabilities };
  }

  if (capabilities.destructive) {
    return { status: "denied", reason: "Denied destructive shell command", capabilities };
  }
  if (capabilities.protectedTarget && (capabilities.localWrite || !capabilities.readOnly)) {
    return { status: "denied", reason: "Shell command targets a protected path", capabilities };
  }
  if (capabilities.network && policy && !policy.networkAccess) {
    return { status: "denied", reason: "Network access is disabled for this session", capabilities };
  }
  if (!capabilities.localWrite && !capabilities.network && capabilities.readOnly) {
    return { status: "allowed", capabilities };
  }

  if (policy?.sandboxMode === "read_only") {
    return { status: "denied", reason: "Read-only sandbox blocks mutating shell commands", capabilities };
  }

  if (!policy) {
    return {
      status: capabilities.localWrite || capabilities.network || !capabilities.readOnly ? "needs_approval" : "allowed",
      reason: capabilities.localWrite || capabilities.network || !capabilities.readOnly ? "Shell command requires approval" : undefined,
      capabilities,
    };
  }

  const needsApproval = policy.approvalPolicy !== "never";
  if (capabilities.localWrite || capabilities.network || !capabilities.readOnly) {
    return {
      status: needsApproval ? "needs_approval" : "allowed",
      reason: needsApproval ? "Shell command requires approval under current execution policy" : undefined,
      capabilities,
    };
  }

  return { status: "allowed", capabilities };
}

export function isReadOnlyShellCommand(command: string): boolean {
  const assessment = assessShellCommand(command);
  return assessment.status === "allowed"
    && assessment.capabilities.readOnly
    && !assessment.capabilities.localWrite
    && !assessment.capabilities.network
    && !assessment.capabilities.destructive
    && !assessment.capabilities.protectedTarget;
}

export function containsShellExecutable(command: string, executable: string): boolean {
  const analysis = analyzeShellCommand(command);
  return analysis.commands.some((entry) => entry.executable === executable);
}

function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const tokenized = tokenizeShellCommand(command.trim());
  const capabilities = emptyCapabilities();
  if (tokenized.error) {
    return { commands: [], pathTokens: [], capabilities, unsupportedReason: tokenized.error };
  }

  const commands: ShellSimpleCommand[] = [];
  const pathTokens: string[] = [];
  let currentWords: string[] = [];

  const flushCommand = (): void => {
    const simpleCommand = buildSimpleCommand(currentWords);
    currentWords = [];
    if (!simpleCommand) return;
    commands.push(simpleCommand);
    const commandCapabilities = classifySimpleCommand(simpleCommand);
    mergeCapabilities(capabilities, commandCapabilities);
    pathTokens.push(...collectPotentialPathTokens(simpleCommand));
  };

  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index]!;
    if (token.kind === "word") {
      currentWords.push(token.value);
      continue;
    }

    if (isCommandBoundary(token.value)) {
      flushCommand();
      continue;
    }

    if (isOutputRedirection(token.value)) {
      capabilities.readOnly = false;
      capabilities.localWrite = true;
      const target = tokenized.tokens[index + 1];
      if (target?.kind === "word") {
        pathTokens.push(target.value);
        index += 1;
      }
      continue;
    }

    if (token.value === "stdin_redirect") {
      const target = tokenized.tokens[index + 1];
      if (target?.kind === "word") {
        pathTokens.push(target.value);
        index += 1;
      }
    }
  }

  flushCommand();

  return { commands, pathTokens, capabilities };
}

function tokenizeShellCommand(command: string): { tokens: ShellToken[]; error?: string } {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  const pushWord = (): void => {
    if (current.length === 0) return;
    tokens.push({ kind: "word", value: current });
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === "\"" && char === "`") {
        return { tokens, error: "Shell command contains unsupported command substitution syntax" };
      }
      if (quote === "\"" && char === "$" && next === "(") {
        return { tokens, error: "Shell command contains unsupported command substitution syntax" };
      }
      if (char === "\\" && next !== undefined) {
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === "\r") {
      return { tokens, error: "Shell command contains unsupported multiline syntax" };
    }
    if (char === "`") {
      return { tokens, error: "Shell command contains unsupported command substitution syntax" };
    }
    if (char === "$" && next === "(") {
      return { tokens, error: "Shell command contains unsupported command substitution syntax" };
    }
    if (char === "\\" && next !== undefined) {
      current += next;
      index += 1;
      continue;
    }
    if (isShellWhitespace(char)) {
      pushWord();
      continue;
    }
    if (char === "&" && next === "&") {
      pushWord();
      tokens.push({ kind: "operator", value: "and" });
      index += 1;
      continue;
    }
    if (char === "|" && next === "|") {
      pushWord();
      tokens.push({ kind: "operator", value: "or" });
      index += 1;
      continue;
    }
    if (char === "|") {
      pushWord();
      tokens.push({ kind: "operator", value: "pipe" });
      continue;
    }
    if (char === ";") {
      pushWord();
      tokens.push({ kind: "operator", value: "sequence" });
      continue;
    }
    if (char === ">" || char === "<") {
      const redirectedDescriptor = takeRedirectDescriptor(current);
      if (redirectedDescriptor) {
        tokens.push({ kind: "operator", value: redirectedDescriptor });
        current = "";
      } else {
        pushWord();
        tokens.push({ kind: "operator", value: redirectOperator(char, next) });
      }
      if (char === ">" && next === ">") {
        index += 1;
      }
      continue;
    }
    if (char === "&" && next === ">") {
      pushWord();
      tokens.push({ kind: "operator", value: "combined_redirect" });
      index += 1;
      continue;
    }

    current += char;
  }

  if (quote) {
    return { tokens, error: "Shell command contains unterminated quoted text" };
  }
  pushWord();
  return { tokens };
}

function redirectOperator(char: string, next: string | undefined): ShellOperator {
  if (char === "<") return "stdin_redirect";
  return next === ">" ? "stdout_append" : "stdout_redirect";
}

function takeRedirectDescriptor(current: string): ShellOperator | null {
  if (current === "1") return "stdout_redirect";
  if (current === "2") return "stderr_redirect";
  return null;
}

function isShellWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function isCommandBoundary(operator: ShellOperator): boolean {
  return operator === "and" || operator === "or" || operator === "sequence" || operator === "pipe";
}

function isOutputRedirection(operator: ShellOperator): boolean {
  return operator === "stdout_redirect"
    || operator === "stdout_append"
    || operator === "stderr_redirect"
    || operator === "stderr_append"
    || operator === "combined_redirect";
}

function buildSimpleCommand(words: string[]): ShellSimpleCommand | null {
  let executableIndex = 0;
  while (executableIndex < words.length && isEnvironmentAssignment(words[executableIndex]!)) {
    executableIndex += 1;
  }
  const executable = words[executableIndex];
  if (!executable) return null;
  return {
    executable,
    args: words.slice(executableIndex + 1),
  };
}

function isEnvironmentAssignment(value: string): boolean {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex <= 0) return false;
  const key = value.slice(0, equalsIndex);
  if (key.length === 0) return false;
  return [...key].every((char, index) =>
    char === "_" || isAsciiAlpha(char) || (index > 0 && isAsciiDigit(char))
  );
}

function classifySimpleCommand(command: ShellSimpleCommand): ShellCommandCapabilities {
  if (command.executable.indexOf("/") >= 0) return unknownCapabilities();
  if (READ_ONLY_COMMANDS.has(command.executable)) {
    if (command.executable === "find" && command.args.some(isFindMutationOption)) return localWriteCapabilities();
    return readOnlyCapabilities();
  }
  if (LOCAL_WRITE_COMMANDS.has(command.executable)) return localWriteCapabilities();
  if (NETWORK_COMMANDS.has(command.executable)) return networkCapabilities();
  if (DESTRUCTIVE_COMMANDS.has(command.executable)) return destructiveCapabilities();

  switch (command.executable) {
    case "git":
      return classifyGitCommand(command.args);
    case "npm":
      return classifyNpmCommand(command.args);
    case "npx":
      return classifyNpxCommand(command.args);
    case "pip":
    case "pip3":
      return command.args[0] === "install" ? networkCapabilities({ localWrite: true }) : unknownCapabilities();
    case "sed":
    case "perl":
      return command.args.some(isInPlaceEditOption) ? localWriteCapabilities() : unknownCapabilities();
    default:
      return unknownCapabilities();
  }
}

function classifyGitCommand(args: string[]): ShellCommandCapabilities {
  const subcommand = args[0];
  if (!subcommand) return unknownCapabilities();
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return readOnlyCapabilities();
  if (subcommand === "tag" && (args.length === 1 || args[1] === "-l" || args[1] === "--list")) return readOnlyCapabilities();
  if (GIT_WRITE_SUBCOMMANDS.has(subcommand)) return localWriteCapabilities();
  if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) return networkCapabilities();
  if (GIT_DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) {
    return destructiveCapabilities({ network: subcommand === "push" });
  }
  return unknownCapabilities();
}

function classifyNpmCommand(args: string[]): ShellCommandCapabilities {
  const subcommand = args[0];
  if (!subcommand) return unknownCapabilities();
  if (NPM_READ_SUBCOMMANDS.has(subcommand)) return readOnlyCapabilities();
  if (NPM_WRITE_SUBCOMMANDS.has(subcommand)) return localWriteCapabilities();
  if (NPM_NETWORK_SUBCOMMANDS.has(subcommand)) return networkCapabilities({ localWrite: true });
  return unknownCapabilities();
}

function classifyNpxCommand(args: string[]): ShellCommandCapabilities {
  const executable = args[0];
  const subcommand = args[1];
  if (executable === "vitest" && (subcommand === "run" || subcommand === "list" || subcommand === "--reporter")) {
    return readOnlyCapabilities();
  }
  if (executable === "tsc" && args.some(isNoEmitOption)) return readOnlyCapabilities();
  return unknownCapabilities();
}

function isFindMutationOption(arg: string): boolean {
  return arg === "-delete" || arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir";
}

function isInPlaceEditOption(arg: string): boolean {
  return arg === "-i" || arg.startsWith("-i.");
}

function isNoEmitOption(arg: string): boolean {
  return arg.toLowerCase() === "--noemit";
}

function collectPotentialPathTokens(command: ShellSimpleCommand): string[] {
  return command.args.filter((arg) => arg.length > 0 && !arg.startsWith("-"));
}

function emptyCapabilities(): ShellCommandCapabilities {
  return {
    readOnly: true,
    localWrite: false,
    network: false,
    destructive: false,
    protectedTarget: false,
  };
}

function readOnlyCapabilities(): ShellCommandCapabilities {
  return emptyCapabilities();
}

function unknownCapabilities(): ShellCommandCapabilities {
  return {
    ...emptyCapabilities(),
    readOnly: false,
  };
}

function localWriteCapabilities(overrides: Partial<ShellCommandCapabilities> = {}): ShellCommandCapabilities {
  return {
    ...unknownCapabilities(),
    localWrite: true,
    ...overrides,
  };
}

function networkCapabilities(overrides: Partial<ShellCommandCapabilities> = {}): ShellCommandCapabilities {
  return {
    ...unknownCapabilities(),
    network: true,
    ...overrides,
  };
}

function destructiveCapabilities(overrides: Partial<ShellCommandCapabilities> = {}): ShellCommandCapabilities {
  return {
    ...unknownCapabilities(),
    destructive: true,
    ...overrides,
  };
}

function mergeCapabilities(target: ShellCommandCapabilities, source: ShellCommandCapabilities): void {
  target.readOnly = target.readOnly && source.readOnly;
  target.localWrite = target.localWrite || source.localWrite;
  target.network = target.network || source.network;
  target.destructive = target.destructive || source.destructive;
  target.protectedTarget = target.protectedTarget || source.protectedTarget;
}

function targetsProtectedRoot(pathTokens: string[], policy: ExecutionPolicy | undefined, cwd: string | undefined): boolean {
  if (!policy?.protectedPaths || policy.protectedPaths.length === 0) return false;
  const effectiveCwd = cwd ?? policy.workspaceRoot;
  if (isPathInsideProtectedRoots(effectiveCwd, policy.protectedPaths)) return true;
  return pathTokens.some((token) => {
    const resolved = isAbsolute(token) ? token : resolve(effectiveCwd, token);
    return isPathInsideProtectedRoots(resolved, policy.protectedPaths);
  });
}

function isAsciiAlpha(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}
