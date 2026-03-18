// ─── Motiva Path Utilities ───
//
// Centralizes ~/.motiva path construction.
// MOTIVA_HOME env var overrides the default ~/.motiva location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the Motiva base directory.
 * Defaults to ~/.motiva; can be overridden via MOTIVA_HOME env var.
 */
export function getMotivaDirPath(): string {
  return process.env["MOTIVA_HOME"] ?? path.join(os.homedir(), ".motiva");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "reports");
}
