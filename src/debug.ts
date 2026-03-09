import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ENABLED = process.env.MOTIVE_DEBUG === '1';

function getLogPath(): string {
  const root = process.env.MOTIVE_PROJECT_ROOT ?? process.cwd();
  return join(root, '.motive', 'debug.log');
}

function noop(_component: string, _message: string, _data?: Record<string, unknown>): void {
  // intentionally empty — zero overhead when disabled
}

function debugImpl(component: string, message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts}] [${component}] ${message}${dataStr}\n`;
  const logPath = getLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, 'utf-8');
  } catch {
    // best-effort: never crash the hook due to debug logging
  }
}

export const debug: (component: string, message: string, data?: Record<string, unknown>) => void =
  ENABLED ? debugImpl : noop;
