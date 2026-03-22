// ─── Moxen Path Utilities ───
//
// Centralizes ~/.moxen path construction.
// MOXEN_HOME env var overrides the default ~/.moxen location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the Moxen base directory.
 * Defaults to ~/.moxen; can be overridden via MOXEN_HOME env var.
 */
export function getMoxenDirPath(): string {
  return process.env["MOXEN_HOME"] ?? path.join(os.homedir(), ".moxen");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getMoxenDirPath(), "reports");
}
