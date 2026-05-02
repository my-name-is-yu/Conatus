import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import {
  parseMemoryCorrectionRef,
  runUserMemoryOperation,
  UserMemoryOperationSchema,
  type UserMemoryOperation,
} from "../../../platform/corrections/user-memory-operations.js";

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasOption(argv: string[], name: string): boolean {
  return argv.indexOf(name) >= 0;
}

function printUsage(): void {
  getCliLogger().error("Usage: pulseed memory <correct|forget|retract|history> <kind:id> [--reason text] [--value text] [--replacement-ref kind:id] [--goal id] [--run id] [--task id]");
}

export async function cmdMemory(stateManager: StateManager, argv: string[]): Promise<number> {
  const operation = argv[0] as UserMemoryOperation | undefined;
  const refValue = argv[1];
  if (!operation || !UserMemoryOperationSchema.safeParse(operation).success || !refValue) {
    printUsage();
    return 1;
  }
  if (hasOption(argv, "--destructive-delete")) {
    getCliLogger().error("Destructive memory deletion requires a separate explicit approval flow; use forget/retract for the default auditable path.");
    return 1;
  }

  try {
    const targetRef = parseMemoryCorrectionRef(refValue);
    const replacementRefValue = optionValue(argv, "--replacement-ref");
    const result = await runUserMemoryOperation(stateManager, {
      operation,
      targetRef,
      reason: optionValue(argv, "--reason"),
      replacementValue: optionValue(argv, "--value"),
      replacementKey: optionValue(argv, "--replacement-key"),
      replacementRef: replacementRefValue ? parseMemoryCorrectionRef(replacementRefValue) : null,
      goalId: optionValue(argv, "--goal"),
      runId: optionValue(argv, "--run"),
      taskId: optionValue(argv, "--task"),
    });

    if (operation === "history") {
      console.log(`Correction history for ${refValue}:`);
      if (result.history.length === 0) {
        console.log("  No correction entries found.");
        return 0;
      }
      for (const entry of result.history) {
        console.log(`  ${entry.created_at} ${entry.correction_kind} ${entry.correction_id}`);
        console.log(`    reason: ${entry.reason}`);
        if (entry.replacement_ref) {
          console.log(`    replacement: ${entry.replacement_ref.kind}:${entry.replacement_ref.id}`);
        }
      }
      return 0;
    }

    console.log(`Memory ${operation} recorded: ${result.correction?.correction_id}`);
    console.log(`Target: ${result.target_ref.kind}:${result.target_ref.id}`);
    if (result.replacement) {
      console.log(`Replacement: ${result.replacement.ref.kind}:${result.replacement.ref.id}`);
    }
    return 0;
  } catch (err) {
    getCliLogger().error(formatOperationError(`memory ${operation}`, err));
    return 1;
  }
}
