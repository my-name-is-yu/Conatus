import { extractBashCommand } from "./bash-mode.js";

export type FreeformInputRoute = "daemon_goal_chat" | "chat_runner" | "unavailable";

export type TuiInputAction =
  | { kind: "interrupt_redirect"; input: string }
  | { kind: "ignore_processing"; input: string }
  | { kind: "shell"; input: string; command: string }
  | { kind: "shell_missing_command"; input: string }
  | { kind: "chat_runner_slash"; input: string }
  | { kind: "pending_run_spec_confirmation"; input: string }
  | { kind: "standalone_slash"; input: string; trimmedInput: string }
  | { kind: "daemon_slash"; input: string; trimmedInput: string }
  | { kind: "freeform"; input: string; route: FreeformInputRoute };

export interface TuiInputActionContext {
  isProcessing: boolean;
  hasChatRunner: boolean;
  hasPendingRunSpec: boolean;
  hasStandaloneSlashHandlers: boolean;
  isDaemonMode: boolean;
  daemonGoalId: string | null;
  isChatRunnerOwnedSlashCommand: (input: string) => boolean;
}

export function resolveFreeformInputRoute({
  isDaemonMode,
  daemonGoalId,
  hasChatRunner,
}: {
  isDaemonMode: boolean;
  daemonGoalId: string | null;
  hasChatRunner: boolean;
}): FreeformInputRoute {
  if (hasChatRunner) {
    return "chat_runner";
  }
  if (isDaemonMode && daemonGoalId) {
    return "daemon_goal_chat";
  }
  return "unavailable";
}

export function resolveTuiInputAction(input: string, context: TuiInputActionContext): TuiInputAction {
  if (context.isProcessing) {
    return context.hasChatRunner
      ? { kind: "interrupt_redirect", input }
      : { kind: "ignore_processing", input };
  }

  const trimmedInput = input.trim().toLowerCase();
  const bashCommand = extractBashCommand(input);
  if (bashCommand !== null) {
    return bashCommand
      ? { kind: "shell", input, command: bashCommand }
      : { kind: "shell_missing_command", input };
  }

  if (context.hasChatRunner && context.isChatRunnerOwnedSlashCommand(input)) {
    return { kind: "chat_runner_slash", input };
  }

  if (context.hasPendingRunSpec && context.hasChatRunner) {
    return { kind: "pending_run_spec_confirmation", input };
  }

  if (input.startsWith("/") && context.hasStandaloneSlashHandlers) {
    return { kind: "standalone_slash", input, trimmedInput };
  }

  if (input.startsWith("/") && context.isDaemonMode) {
    return { kind: "daemon_slash", input, trimmedInput };
  }

  return {
    kind: "freeform",
    input,
    route: resolveFreeformInputRoute({
      isDaemonMode: context.isDaemonMode,
      daemonGoalId: context.daemonGoalId,
      hasChatRunner: context.hasChatRunner,
    }),
  };
}
