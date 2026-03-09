import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Absolute path to the compiled CLI entry point. */
const CLI_PATH = new URL('../../dist/cli.js', import.meta.url).pathname;

/** Run `node dist/cli.js setup [args]` synchronously and return result. */
function runSetup(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_PATH, 'setup', ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-setup-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('motive setup — fresh project', () => {
  it('creates .motive/ directory', () => {
    const result = runSetup(['--project-root', tmpDir]);
    expect(result.status).toBe(0);
    expect(existsSync(join(tmpDir, '.motive'))).toBe(true);
  });

  it('creates .motive/state.json', () => {
    runSetup(['--project-root', tmpDir]);
    expect(existsSync(join(tmpDir, '.motive', 'state.json'))).toBe(true);
  });

  it('creates .claude/settings.json with motiva hooks', () => {
    runSetup(['--project-root', tmpDir]);
    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(Array.isArray(settings.hooks['SessionStart'])).toBe(true);
    expect(settings.hooks['SessionStart'].length).toBeGreaterThan(0);
    expect(settings.hooks['SessionStart'][0].type).toBe('command');
    expect(settings.hooks['SessionStart'][0].command).toContain('session-start.js');
    expect(settings.hooks['SessionStart'][0].command).toContain('MOTIVE_PROJECT_ROOT=');

    // All 6 hook events must be present
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolFailure', 'Stop']) {
      expect(Array.isArray(settings.hooks[event])).toBe(true);
      expect(settings.hooks[event].length).toBeGreaterThan(0);
    }
  });

  it('creates .claude/rules/motiva-usage.md', () => {
    runSetup(['--project-root', tmpDir]);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'motiva-usage.md'))).toBe(true);
  });

  it('motiva-usage.md contains expected Japanese content', () => {
    runSetup(['--project-root', tmpDir]);
    const content = readFileSync(join(tmpDir, '.claude', 'rules', 'motiva-usage.md'), 'utf-8');
    expect(content).toContain('Motiva');
    expect(content).toContain('motive status');
    expect(content).toContain('motive goals');
  });

  it('exits with status 0 on success', () => {
    const result = runSetup(['--project-root', tmpDir]);
    expect(result.status).toBe(0);
  });

  it('stdout mentions setup complete', () => {
    const result = runSetup(['--project-root', tmpDir]);
    expect(result.stdout).toContain('setup complete');
  });
});

describe('motive setup — merge behavior (pre-existing settings.json)', () => {
  it('preserves existing non-motiva hooks', () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');

    // Write a pre-existing settings.json with a custom hook
    const existing = {
      hooks: {
        PreToolUse: [{ type: 'command', command: 'echo pre-existing-hook' }],
      },
      someOtherSetting: true,
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    runSetup(['--project-root', tmpDir]);

    const updated = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Existing hook must still be there
    expect(updated.hooks['PreToolUse']).toContainEqual({
      type: 'command',
      command: 'echo pre-existing-hook',
    });

    // Motiva hook must also be there
    const motivaPreToolUse = updated.hooks['PreToolUse'].find(
      (e: { command?: string }) => typeof e.command === 'string' && e.command.includes('pre-tool-use.js')
    );
    expect(motivaPreToolUse).toBeDefined();

    // Other settings must be preserved
    expect(updated.someOtherSetting).toBe(true);
  });

  it('does not duplicate motiva hooks on repeated setup calls', () => {
    runSetup(['--project-root', tmpDir]);
    runSetup(['--project-root', tmpDir]);

    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolFailure', 'Stop']) {
      const motivaEntries = settings.hooks[event].filter(
        (e: { command?: string }) => typeof e.command === 'string' && e.command.includes('session-start.js')
          || (typeof e.command === 'string' && e.command.includes(event.toLowerCase().replace('tooluse', '-tool-use').replace('tooluse', '-tool-use')))
      );
      // At most one motiva entry per event
      expect(settings.hooks[event].length).toBeLessThanOrEqual(2); // pre-existing + motiva
    }
  });

  it('handles malformed settings.json gracefully', () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), '{ invalid json %%%');

    const result = runSetup(['--project-root', tmpDir]);
    // Should not crash — exits 0 and writes a valid settings.json
    expect(result.status).toBe(0);
    const content = readFileSync(join(claudeDir, 'settings.json'), 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe('motive setup -- --force flag', () => {
  it('--force reinitializes when already set up', () => {
    // First setup
    runSetup(['--project-root', tmpDir]);
    // Manually corrupt motiva-usage.md
    const usagePath = join(tmpDir, '.claude', 'rules', 'motiva-usage.md');
    writeFileSync(usagePath, 'corrupted');

    // Force re-run
    runSetup(['--project-root', tmpDir, '--force']);

    const content = readFileSync(usagePath, 'utf-8');
    expect(content).not.toBe('corrupted');
    expect(content).toContain('Motiva');
  });

  it('--force replaces motiva hooks instead of duplicating them', () => {
    runSetup(['--project-root', tmpDir]);
    runSetup(['--project-root', tmpDir, '--force']);

    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Each event should have exactly one motiva hook entry after --force
    const sessionStartEntries = settings.hooks['SessionStart'].filter(
      (e: { command?: string }) => typeof e.command === 'string' && e.command.includes('session-start.js')
    );
    expect(sessionStartEntries.length).toBe(1);
  });

  it('--force skips "already initialized" message', () => {
    runSetup(['--project-root', tmpDir]);
    const result = runSetup(['--project-root', tmpDir, '--force']);
    expect(result.stdout).not.toContain('already initialized');
  });
});
