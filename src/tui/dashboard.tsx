import React from "react";
import { Box, Text } from "ink";
import type { LoopState, DimensionProgress } from "./use-loop.js";

interface DashboardProps {
  state: LoopState;
  maxIterations?: number;
}

const BAR_WIDTH = 20;

function renderBar(progress: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, progress)) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "green";
    case "completed":
      return "cyan";
    case "stalled":
    case "error":
      return "red";
    case "stopped":
      return "yellow";
    default:
      return "white";
  }
}

function progressColor(progress: number): string {
  if (progress >= 80) return "green";
  if (progress >= 40) return "yellow";
  return "red";
}

function DimensionRow({ dim }: { dim: DimensionProgress }) {
  const bar = renderBar(dim.progress);
  const pct = String(dim.progress).padStart(3, " ") + "%";
  // Truncate displayName to 16 chars for alignment, fallback to name if empty
  const label = (dim.displayName || dim.name).slice(0, 16).padEnd(16, " ");
  const color = progressColor(dim.progress);
  return (
    <Box>
      <Text>{label}  </Text>
      <Text color={color}>{bar}</Text>
      <Text>  {pct}</Text>
    </Box>
  );
}

export function Dashboard({ state }: DashboardProps) {
  if (state.status === "idle") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
        paddingY={1}
      >
        <Text bold color="magenta">
          🎯 MOTIVA
        </Text>
        <Text> </Text>
        <Text color="yellow">No active goals.</Text>
        <Text> </Text>
        <Text dimColor>Get started:</Text>
        <Text>
          {"  1. Type a goal: "}
          <Text color="cyan">"improve test coverage to 90%"</Text>
        </Text>
        <Text>
          {"  2. Then type: "}
          <Text color="green">/run</Text>
        </Text>
        <Text>{"  3. Motiva will decompose and execute automatically."}</Text>
        <Text> </Text>
        <Text dimColor>
          {"Type "}
          <Text color="white">/help</Text>
          {" for all commands."}
        </Text>
      </Box>
    );
  }

  const goalLabel = state.goalId ?? "(unknown)";

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      {/* Header */}
      <Box>
        <Text bold color="magenta">
          MOTIVA
        </Text>
        <Text>{"  goal: "}</Text>
        <Text bold>{goalLabel}</Text>
        <Text>{"  "}</Text>
        <Text color={statusColor(state.status)}>{state.status}</Text>
      </Box>

      {/* Separator */}
      <Text color="gray">{"─".repeat(Math.min(process.stdout.columns || 60, 60) - 4)}</Text>

      {/* Dimension progress bars */}
      {state.dimensions.length === 0 ? (
        <Text color="gray">Loading dimensions...</Text>
      ) : (
        state.dimensions.map((dim) => (
          <DimensionRow key={dim.name} dim={dim} />
        ))
      )}

      {/* Error message */}
      {state.status === "error" && state.lastError && (
        <Text color="red">Error: {state.lastError}</Text>
      )}
    </Box>
  );
}
