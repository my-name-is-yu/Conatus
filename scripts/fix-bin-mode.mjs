#!/usr/bin/env node
import { chmodSync, statSync } from "node:fs";

const executableFiles = [
  "dist/interface/cli/cli-runner.js",
];

for (const filePath of executableFiles) {
  const stat = statSync(filePath);
  chmodSync(filePath, (stat.mode & 0o777) | 0o755);
}
