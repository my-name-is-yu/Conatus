import * as fsp from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import { PluginManifestSchema } from "../../types/plugin.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPluginsDir } from "../../utils/paths.js";

function defaultPluginsDir(): string {
  return getPluginsDir();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(pluginDir: string) {
  const yamlPath = path.join(pluginDir, "plugin.yaml");
  const jsonPath = path.join(pluginDir, "plugin.json");

  let raw: unknown;
  if (await pathExists(yamlPath)) {
    const content = await fsp.readFile(yamlPath, "utf-8");
    raw = yaml.load(content);
  } else if (await pathExists(jsonPath)) {
    const content = await fsp.readFile(jsonPath, "utf-8");
    raw = JSON.parse(content);
  } else {
    return null;
  }

  return PluginManifestSchema.safeParse(raw);
}

export async function cmdPluginList(pluginsDir?: string): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();

  if (!(await pathExists(dir))) {
    console.log("No plugins installed. Use `motiva plugin install <path>` to install one.");
    return 0;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    logger.error(formatOperationError("read plugins directory", err));
    return 1;
  }

  const rows: { name: string; version: string; type: string; description: string }[] = [];

  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>> | undefined;
    try {
      stat = await fsp.stat(pluginDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const result = await readManifest(pluginDir);
    if (!result || !result.success) continue;

    const m = result.data;
    rows.push({
      name: m.name,
      version: m.version,
      type: m.type,
      description: m.description.length > 40 ? m.description.slice(0, 37) + "..." : m.description,
    });
  }

  if (rows.length === 0) {
    console.log("No plugins installed. Use `motiva plugin install <path>` to install one.");
    return 0;
  }

  console.log(`Found ${rows.length} plugin(s):\n`);
  console.log(`${"NAME".padEnd(24)} ${"VERSION".padEnd(10)} ${"TYPE".padEnd(14)} DESCRIPTION`);
  console.log("─".repeat(80));
  for (const r of rows) {
    console.log(`${r.name.padEnd(24)} ${r.version.padEnd(10)} ${r.type.padEnd(14)} ${r.description}`);
  }

  return 0;
}

export async function cmdPluginInstall(pluginsDir: string | undefined, argv: string[]): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const sourcePath = argv[0];
  const force = argv.includes("--force");

  if (!sourcePath) {
    logger.error("Error: source path is required. Usage: motiva plugin install <path> [--force]");
    return 1;
  }

  if (!(await pathExists(sourcePath))) {
    logger.error(`Error: source path "${sourcePath}" does not exist.`);
    return 1;
  }

  const result = await readManifest(sourcePath);
  if (!result) {
    logger.error(`Error: plugin manifest not found in "${sourcePath}". Expected plugin.yaml or plugin.json.`);
    return 1;
  }
  if (!result.success) {
    logger.error(`Error: invalid plugin manifest — ${result.error.message}`);
    return 1;
  }

  const manifest = result.data;
  const destDir = path.join(dir, manifest.name);

  if ((await pathExists(destDir)) && !force) {
    logger.error(`Error: plugin "${manifest.name}" is already installed. Use --force to overwrite.`);
    return 1;
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(sourcePath, destDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("copy plugin", err));
    return 1;
  }

  // Verify after copy
  const verify = await readManifest(destDir);
  if (!verify || !verify.success) {
    logger.error(`Error: plugin copy failed — manifest unreadable after install.`);
    return 1;
  }

  if (manifest.permissions.shell) {
    getCliLogger().warn(`Plugin "${manifest.name}" requests shell execution permission.`);
  }

  console.log(`Plugin "${manifest.name}" v${manifest.version} installed.`);
  return 0;
}

export async function cmdPluginRemove(pluginsDir: string | undefined, argv: string[]): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const name = argv[0];

  if (!name) {
    logger.error("Error: plugin name is required. Usage: motiva plugin remove <name>");
    return 1;
  }

  const pluginDir = path.join(dir, name);

  if (!(await pathExists(pluginDir))) {
    logger.error(`Error: plugin "${name}" not found.`);
    return 1;
  }

  try {
    await fsp.rm(pluginDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("remove plugin", err));
    return 1;
  }

  console.log(`Plugin "${name}" removed.`);
  return 0;
}
