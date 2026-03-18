// ─── JSON IO Utilities ───
//
// Shared helpers for reading and writing JSON files.
// Sync versions use fs; async versions use fs/promises.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * Read and parse a JSON file synchronously.
 * Throws if the file does not exist or contains invalid JSON.
 */
export function readJsonFileSync<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file synchronously with 2-space indent.
 */
export function writeJsonFileSync(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read and parse a JSON file asynchronously.
 * Throws if the file does not exist or contains invalid JSON.
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file asynchronously with 2-space indent.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
