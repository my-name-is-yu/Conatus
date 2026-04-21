import { loadDreamPlaybooks, setDreamPlaybookStatus, deleteDreamPlaybook } from "../../../platform/dream/playbook-memory.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { formatOperationError } from "../utils.js";

export async function cmdPlaybook(argv: string[], stateManager: StateManager): Promise<number> {
  const subcommand = argv[0] ?? "list";
  const baseDir = stateManager.getBaseDir();

  if (subcommand === "list") {
    try {
      const playbooks = await loadDreamPlaybooks(baseDir);
      if (playbooks.length === 0) {
        console.log("No playbooks found.");
        return 0;
      }
      console.log(`${"ID".padEnd(32)} ${"STATUS".padEnd(10)} ${"PROVEN".padEnd(8)} TITLE`);
      console.log("-".repeat(96));
      for (const playbook of playbooks) {
        const provenCount = playbook.usage.verified_success_count + playbook.usage.successful_reuse_count;
        console.log(
          `${playbook.playbook_id.padEnd(32)} ${playbook.status.padEnd(10)} ${String(provenCount).padEnd(8)} ${playbook.title}`
        );
      }
      return 0;
    } catch (error) {
      console.error(formatOperationError("list playbooks", error));
      return 1;
    }
  }

  if (subcommand === "show") {
    const playbookId = argv[1];
    if (!playbookId) {
      console.error("Error: playbook id is required. Usage: pulseed playbook show <id>");
      return 1;
    }
    try {
      const playbooks = await loadDreamPlaybooks(baseDir);
      const match = playbooks.find((playbook) => playbook.playbook_id === playbookId);
      if (!match) {
        console.error(`Error: playbook "${playbookId}" not found.`);
        return 1;
      }
      console.log(JSON.stringify(match, null, 2));
      return 0;
    } catch (error) {
      console.error(formatOperationError("show playbook", error));
      return 1;
    }
  }

  if (subcommand === "promote" || subcommand === "demote" || subcommand === "disable") {
    const playbookId = argv[1];
    if (!playbookId) {
      console.error(`Error: playbook id is required. Usage: pulseed playbook ${subcommand} <id>`);
      return 1;
    }
    const nextStatus =
      subcommand === "promote"
        ? "promoted"
        : subcommand === "demote"
          ? "candidate"
          : "disabled";
    try {
      const updated = await setDreamPlaybookStatus(baseDir, playbookId, nextStatus);
      if (!updated) {
        console.error(`Error: playbook "${playbookId}" not found.`);
        return 1;
      }
      console.log(`Playbook "${playbookId}" set to ${nextStatus}.`);
      return 0;
    } catch (error) {
      console.error(formatOperationError(`${subcommand} playbook`, error));
      return 1;
    }
  }

  if (subcommand === "delete") {
    const playbookId = argv[1];
    if (!playbookId) {
      console.error("Error: playbook id is required. Usage: pulseed playbook delete <id>");
      return 1;
    }
    try {
      const deleted = await deleteDreamPlaybook(baseDir, playbookId);
      if (!deleted) {
        console.error(`Error: playbook "${playbookId}" not found.`);
        return 1;
      }
      console.log(`Playbook "${playbookId}" deleted.`);
      return 0;
    } catch (error) {
      console.error(formatOperationError("delete playbook", error));
      return 1;
    }
  }

  console.error(`Unknown playbook subcommand: "${subcommand}"`);
  console.error("Available: playbook list, playbook show, playbook promote, playbook demote, playbook disable, playbook delete");
  return 1;
}
