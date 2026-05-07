import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadGlobalConfigSync } from "../config/global-config.js";
import { getDefaultPulseedWorkspaceRootPath, getPulseedDirPath } from "./paths.js";

export function getPulseedWorkspaceRootPath(): string {
  if (process.env["PULSEED_WORKSPACE_ROOT"]) {
    return path.resolve(process.env["PULSEED_WORKSPACE_ROOT"]);
  }
  const configured = loadGlobalConfigSync().workspace_root;
  return path.resolve(configured || getDefaultPulseedWorkspaceRootPath());
}

export function workspaceRootRelativePath(absolutePath: string): string {
  const root = path.resolve(getPulseedWorkspaceRootPath());
  const relativePath = path.relative(root, path.resolve(absolutePath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("path must stay within the PulSeed workspace root");
  }
  return relativePath.split(path.sep).join("/");
}

export function assertOutsidePulSeedStateRoot(candidate: string, label: string): void {
  const stateRoot = path.resolve(getPulseedDirPath());
  const resolved = path.resolve(candidate);
  const relativePath = path.relative(stateRoot, resolved);
  if (resolved === stateRoot || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    throw new Error(`${label} must be outside the protected PulSeed state root`);
  }
}

export async function ensureDirectoryWithinWorkspaceRoot(dirPath: string): Promise<void> {
  const workspaceRoot = path.resolve(getPulseedWorkspaceRootPath());
  assertOutsidePulSeedStateRoot(workspaceRoot, "workspace_root");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  assertWithin(workspaceRoot, dirPath, "directory");

  const relativeParts = path.relative(workspaceRoot, path.resolve(dirPath)).split(path.sep).filter(Boolean);
  let current = workspaceRoot;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const existingRealPath = await realpathOrNull(current);
    if (existingRealPath) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace path component must not be a symlink: ${workspaceRootRelativePath(current)}`);
      }
      assertWithin(realWorkspaceRoot, existingRealPath, "directory realpath");
      if (!stat.isDirectory()) {
        throw new Error(`workspace path component is not a directory: ${workspaceRootRelativePath(current)}`);
      }
      continue;
    }
    await fs.mkdir(current);
    const createdRealPath = await fs.realpath(current);
    assertWithin(realWorkspaceRoot, createdRealPath, "created directory");
  }
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`${label} must stay within ${parent}`);
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function isPathInsidePulSeedStateRoot(candidate: string): boolean {
  const stateRoot = canonicalPath(getPulseedDirPath());
  const resolved = canonicalPath(candidate);
  const relativePath = path.relative(stateRoot, resolved);
  return resolved === stateRoot || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function canonicalPath(value: string): string {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
