#!/usr/bin/env node
/**
 * Measure statement coverage using c8 + vitest.
 * Outputs a single number (percentage) to stdout.
 * Exits 0 always (errors → outputs "0").
 *
 * NOTE: Uses execFileSync (not exec) to avoid shell injection.
 * The command is hardcoded, no user input.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPORTS_DIR = path.join(process.cwd(), "coverage-c8");

function run() {
  // Run vitest through c8 for coverage collection
  try {
    execFileSync("npx", [
      "c8", "--reporter=json-summary", "--reports-dir=" + REPORTS_DIR,
      "npx", "vitest", "run",
    ], {
      stdio: "pipe",
      timeout: 170000,
    });
  } catch (_e) {
    // vitest exits non-zero on test failures — that's OK
  }

  // Read coverage-summary.json
  const summaryPath = path.join(REPORTS_DIR, "coverage-summary.json");
  if (fs.existsSync(summaryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      console.log(data.total.statements.pct);
      return;
    } catch (_e) { /* fall through */ }
  }

  console.log("0");
}

run();
