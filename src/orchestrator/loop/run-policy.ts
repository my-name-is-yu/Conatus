import type { LoopConfig, LoopRunPolicy, LoopRunPolicyInput } from "./core-loop/contracts.js";

export function resolveLoopRunPolicy(input?: {
  runPolicy?: LoopRunPolicyInput;
  maxIterations?: number | null;
}): LoopRunPolicy {
  const rawPolicy = input?.runPolicy;
  const rawMaxIterations = input?.maxIterations;

  if (rawMaxIterations === null) {
    return { mode: "resident", maxIterations: null };
  }

  if (rawPolicy === "resident" || (typeof rawPolicy === "object" && rawPolicy.mode === "resident")) {
    return { mode: "resident", maxIterations: null };
  }

  if (rawPolicy === "bounded" || (typeof rawPolicy === "object" && rawPolicy.mode === "bounded")) {
    const maxIterations = rawMaxIterations ?? (typeof rawPolicy === "object" ? rawPolicy.maxIterations : undefined);
    return { mode: "bounded", maxIterations: normalizeBoundedMaxIterations(maxIterations) };
  }

  return { mode: "bounded", maxIterations: normalizeBoundedMaxIterations(rawMaxIterations) };
}

export function resolveLoopConfig(config: LoopConfig = {}): LoopConfig & { runPolicy: LoopRunPolicy; maxIterations: number | null } {
  const runPolicy = resolveLoopRunPolicy(config);
  return {
    ...config,
    maxIterations: runPolicy.maxIterations,
    runPolicy,
  };
}

function normalizeBoundedMaxIterations(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return 100;
}
