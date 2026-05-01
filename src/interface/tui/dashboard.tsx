import React from "react";
import { Box, Text } from "ink";
import { CheckerboardSpinner } from "./checkerboard-spinner.js";
import type { LoopState, DimensionProgress } from "./use-loop.js";
import { theme, statusColor, progressColor } from "./theme.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
} from "../../runtime/session-registry/types.js";

interface DashboardProps {
  state: LoopState;
  maxIterations?: number;
  runtimeSessions?: RuntimeSessionRegistrySnapshot | null;
}

const BAR_WIDTH = 20;
const CURRENT_STALE_MS = 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkDashboardRowKind = "session" | "run";
export type WorkDashboardRowGroup = "active" | "recent";

export interface WorkDashboardRow {
  kind: WorkDashboardRowKind;
  group: WorkDashboardRowGroup;
  id: string;
  title: string;
  status: string;
  summary: string;
  updatedAt: string | null;
  workspace: string | null;
  attention: boolean;
  stale: boolean;
}

function renderBar(progress: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, progress)) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestSessionTime(session: RuntimeSession): string | null {
  return session.last_event_at ?? session.updated_at ?? session.created_at;
}

function latestRunTime(run: BackgroundRun): string | null {
  return run.completed_at ?? run.updated_at ?? run.started_at ?? run.created_at;
}

function isStaleCurrent(updatedAt: string | null, now: Date): boolean {
  const ms = timestampMs(updatedAt);
  if (ms === null) return true;
  return now.getTime() - ms > CURRENT_STALE_MS;
}

function isRecent(updatedAt: string | null, now: Date): boolean {
  const ms = timestampMs(updatedAt);
  if (ms === null) return false;
  return now.getTime() - ms <= RECENT_WINDOW_MS;
}

function sessionAttention(session: RuntimeSession, stale: boolean): boolean {
  const attentionText = [
    session.title,
    session.id,
    session.reply_target ? JSON.stringify(session.reply_target) : null,
    ...session.source_refs.flatMap((ref) => [ref.id, ref.relative_path]),
  ].filter(Boolean).join(" ");
  return stale
    || session.status === "lost"
    || session.status === "unknown"
    || /approval[-_ ]required|blocked|waiting/i.test(attentionText);
}

function runAttention(run: BackgroundRun): boolean {
  return run.status === "failed"
    || run.status === "timed_out"
    || run.status === "lost"
    || run.status === "unknown"
    || /approval[-_ ]required|blocked|waiting/i.test(`${run.summary ?? ""} ${run.error ?? ""}`);
}

function compact(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildWorkDashboardRows(
  snapshot: RuntimeSessionRegistrySnapshot | null | undefined,
  now: Date = new Date(),
): WorkDashboardRow[] {
  if (!snapshot) return [];
  const rows: WorkDashboardRow[] = [];

  for (const session of snapshot.sessions) {
    const updatedAt = latestSessionTime(session);
    const stale = isStaleCurrent(updatedAt, now);
    const activeState = (session.status === "active" || session.status === "idle") && !stale;
    const recentState = !activeState && isRecent(updatedAt, now);
    if (!activeState && !recentState) continue;
    rows.push({
      kind: "session",
      group: activeState ? "active" : "recent",
      id: session.id,
      title: compact(session.title, session.id),
      status: stale ? "stale" : session.status,
      summary: session.attachable ? "attachable runtime session" : "runtime session",
      updatedAt,
      workspace: session.workspace,
      attention: sessionAttention(session, stale),
      stale,
    });
  }

  for (const run of snapshot.background_runs) {
    const updatedAt = latestRunTime(run);
    const stale = isStaleCurrent(updatedAt, now);
    const activeState = (run.status === "queued" || run.status === "running") && !stale;
    const terminalState = ["succeeded", "failed", "timed_out", "cancelled", "lost", "unknown"].includes(run.status);
    const recentState = !activeState && (terminalState || stale) && isRecent(updatedAt, now);
    if (!activeState && !recentState) continue;
    rows.push({
      kind: "run",
      group: activeState ? "active" : "recent",
      id: run.id,
      title: compact(run.title, run.id),
      status: stale ? "stale" : run.status,
      summary: compact(run.error ?? run.summary, run.kind),
      updatedAt,
      workspace: run.workspace,
      attention: runAttention(run) || stale,
      stale,
    });
  }

  return rows.sort((a, b) => {
    if (a.group !== b.group) return a.group === "active" ? -1 : 1;
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return (timestampMs(b.updatedAt) ?? 0) - (timestampMs(a.updatedAt) ?? 0);
  });
}

export function statusLabel(status: string): string {
  switch (status) {
    case "idle":          return "Idle";
    case "running":       return "Running";
    case "completed":     return "Completed";
    case "stalled":       return "Stalled";
    case "max_iterations": return "Max iterations reached";
    case "error":         return "Error";
    case "stopped":       return "Stopped";
    default:              return status;
  }
}


function formatElapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function DimensionRow({ dim }: { dim: DimensionProgress }) {
  const bar = renderBar(dim.progress);
  const pct = String(dim.progress).padStart(3, " ") + "%";
  // bar(20) + "  "(2) + "  "(2) + pct(4) + border/padding(4) = 32 fixed chars
  const termWidth = process.stdout.columns || 80;
  const labelWidth = Math.max(8, Math.min(32, termWidth - 32));
  const rawLabel = dim.displayName || dim.name;
  const truncated = rawLabel.length > labelWidth;
  const label = (truncated ? rawLabel.slice(0, labelWidth - 1) + "…" : rawLabel).padEnd(labelWidth, " ");
  const color = progressColor(dim.progress);
  return (
    <Box>
      <Text>{label}  </Text>
      <Text color={color}>{bar}</Text>
      <Text>  {pct}</Text>
    </Box>
  );
}

function formatUpdated(value: string | null): string {
  if (!value) return "unknown";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function WorkRow({ row }: { row: WorkDashboardRow }) {
  const marker = row.attention ? "!" : row.group === "active" ? ">" : "-";
  const color = row.attention ? theme.warning : row.group === "active" ? theme.success : theme.text;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>
        {marker} {row.title} <Text dimColor>({row.kind}:{row.id})</Text>
      </Text>
      <Text>
        <Text dimColor>{"  "}{row.group} / </Text>
        <Text color={color}>{row.status}</Text>
        <Text dimColor>{" / updated "}{formatUpdated(row.updatedAt)}</Text>
      </Text>
      <Text dimColor>{"  "}{row.summary}</Text>
      {row.workspace && <Text dimColor>{"  "}{row.workspace}</Text>}
    </Box>
  );
}

function WorkDashboard({ rows }: { rows: WorkDashboardRow[] }) {
  const activeRows = rows.filter((row) => row.group === "active");
  const recentRows = rows.filter((row) => row.group === "recent").slice(0, 6);
  const attentionRows = rows.filter((row) => row.attention);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} overflow="hidden">
      <Text bold color={theme.brand}>Work Dashboard</Text>
      <Text dimColor>
        Active {activeRows.length}  Recent {recentRows.length}  Attention {attentionRows.length}
      </Text>
      <Text> </Text>
      {attentionRows.length > 0 && (
        <>
          <Text color={theme.warning}>Attention needed</Text>
          {attentionRows.slice(0, 4).map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)}
        </>
      )}
      <Text color={theme.success}>Active work</Text>
      {activeRows.length === 0 ? (
        <Text dimColor>{"  No active background work."}</Text>
      ) : (
        activeRows.slice(0, 6).map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)
      )}
      <Text> </Text>
      <Text dimColor>Recent work</Text>
      {recentRows.length === 0 ? (
        <Text dimColor>{"  No recent background work."}</Text>
      ) : (
        recentRows.map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)
      )}
    </Box>
  );
}

export function Dashboard({ state, runtimeSessions }: DashboardProps) {
  const workRows = buildWorkDashboardRows(runtimeSessions);
  if (workRows.length > 0) {
    return <WorkDashboard rows={workRows} />;
  }

  if (state.status === "idle") {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        <Text bold color={theme.brand}>
          🎯 PULSEED
        </Text>
        <Text> </Text>
        <Text color={theme.warning}>No active goals.</Text>
        <Text> </Text>
        <Text dimColor>Get started:</Text>
        <Text>
          {"  1. Type a goal: "}
          <Text color={theme.userPrefix}>"improve test coverage to 90%"</Text>
        </Text>
        <Text>
          {"  2. Then type: "}
          <Text color={theme.command}>/run</Text>
        </Text>
        <Text>{"  3. PulSeed will decompose and execute automatically."}</Text>
        <Text> </Text>
        <Text dimColor>
          {"Type "}
          <Text color={theme.text}>/help</Text>
          {" for all commands."}
        </Text>
      </Box>
    );
  }

  const goalLabel = state.goalId ?? "(unknown)";

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {/* Header */}
      <Box>
        <Text bold color={theme.brand}>
          PULSEED
        </Text>
        <Text>{"  goal: "}</Text>
        <Text bold>{goalLabel}</Text>
        <Text>{"  "}</Text>
        {state.status === "running" ? (
          <Text color={theme.success}>
            <CheckerboardSpinner />
            {" " + statusLabel("running")}
          </Text>
        ) : (
          <Text color={statusColor(state.status)}>{statusLabel(state.status)}</Text>
        )}
      </Box>

      {/* Separator */}
      <Box borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} />

      {/* Stats row: iter, elapsed, last result */}
      {(state.running || state.iteration > 0) && (
        <Box>
          <Text dimColor>{"Iter: "}</Text>
          <Text>{state.iteration}</Text>
          {state.startedAt && (
            <>
              <Text dimColor>{" │ Elapsed: "}</Text>
              <Text>{formatElapsed(state.startedAt)}</Text>
            </>
          )}
          {state.lastResult && (
            <>
              <Text dimColor>{" │ Last: "}</Text>
              <Text>{statusLabel(state.lastResult.finalStatus)}</Text>
            </>
          )}
        </Box>
      )}

      {/* Dimension progress bars */}
      {state.dimensions.length === 0 ? (
        <Text color={theme.border}>Loading dimensions...</Text>
      ) : (
        state.dimensions.map((dim) => (
          <DimensionRow key={dim.name} dim={dim} />
        ))
      )}

      {/* Error message */}
      {state.status === "error" && state.lastError && (
        <Text color={theme.error}>Error: {state.lastError}</Text>
      )}
    </Box>
  );
}
