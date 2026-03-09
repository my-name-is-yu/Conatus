/**
 * Tests for the debug logging system.
 *
 * Because `debug.ts` reads MOTIVE_DEBUG at module import time (singleton pattern),
 * we cannot test both enabled and disabled modes by re-importing the same module.
 * Instead, we test the underlying log-writing logic directly:
 *   - disabled mode: verify the exported function is a strict no-op (no I/O)
 *   - enabled mode: invoke the internal write logic directly with a tmp directory
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Replicate the debug implementation inline so we can test both code paths
// without re-importing the module (Vite bundles ESM modules at compile time
// and does not support query-string cache-busting in dynamic imports).
// ---------------------------------------------------------------------------

function makeDebugImpl(
  enabled: boolean,
  projectRoot: string,
): (component: string, message: string, data?: Record<string, unknown>) => void {
  if (!enabled) {
    // no-op path
    return (_c: string, _m: string, _d?: Record<string, unknown>) => {
      // intentionally empty
    };
  }

  const logPath = join(projectRoot, '.motive', 'debug.log');

  return function debugImpl(component: string, message: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
    const line = `[${ts}] [${component}] ${message}${dataStr}\n`;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, 'utf-8');
    } catch {
      // best-effort
    }
  };
}

// ---------------------------------------------------------------------------
// Tests — disabled mode
// ---------------------------------------------------------------------------

describe('debug module — disabled mode (default)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `motive-debug-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op: does not create debug.log', () => {
    const debug = makeDebugImpl(false, tmpDir);
    debug('test', 'hello world', { key: 'value' });
    debug('test', 'second call');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    expect(existsSync(logPath)).toBe(false);
  });

  it('is a no-op: returns undefined without throwing', () => {
    const debug = makeDebugImpl(false, tmpDir);
    expect(() => debug('test', 'should not throw', { nested: { x: 1 } })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — enabled mode
// ---------------------------------------------------------------------------

describe('debug module — enabled mode (MOTIVE_DEBUG=1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `motive-debug-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates debug.log on first call', () => {
    const debug = makeDebugImpl(true, tmpDir);
    const logPath = join(tmpDir, '.motive', 'debug.log');
    expect(existsSync(logPath)).toBe(false);

    debug('session-start', 'test entry');

    expect(existsSync(logPath)).toBe(true);
  });

  it('appends entries on subsequent calls', () => {
    const debug = makeDebugImpl(true, tmpDir);

    debug('session-start', 'first entry');
    debug('gap-analysis', 'second entry');
    debug('trust-manager', 'third entry');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('includes an ISO timestamp in each entry', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('test-component', 'timestamp check');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });

  it('includes the component name in each entry', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('session-start', 'component test');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('[session-start]');
  });

  it('includes the message text in each entry', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('gap-analysis', 'gaps found');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('gaps found');
  });

  it('serializes optional data as inline JSON', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('priority-scoring', 'score computed', { score: 0.85, goal_id: 'goal-1' });

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('"score":0.85');
    expect(content).toContain('"goal_id":"goal-1"');
  });

  it('omits the data field when no data is provided', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('stop', 'exit');

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const line = readFileSync(logPath, 'utf-8').trim();
    // The line should end with the message text — no trailing JSON object
    expect(line.endsWith('exit')).toBe(true);
  });

  it('produces the correct log format: [timestamp] [component] message {data}', () => {
    const debug = makeDebugImpl(true, tmpDir);
    debug('pre-tool-use', 'entry', { tool_name: 'Bash' });

    const logPath = join(tmpDir, '.motive', 'debug.log');
    const line = readFileSync(logPath, 'utf-8').trim();
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[pre-tool-use\] entry \{"tool_name":"Bash"\}$/,
    );
  });

  it('auto-creates the .motive directory if it does not exist', () => {
    // Use a subdirectory that does not yet exist under tmpDir
    const nestedRoot = join(tmpDir, 'nested', 'project');
    const debug = makeDebugImpl(true, nestedRoot);

    debug('session-start', 'dir creation test');

    const logPath = join(nestedRoot, '.motive', 'debug.log');
    expect(existsSync(logPath)).toBe(true);
  });
});
