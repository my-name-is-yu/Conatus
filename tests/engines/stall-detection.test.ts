import { describe, it, expect, beforeEach } from 'vitest';
import { StallDetectionEngine } from '../../src/engines/stall-detection.js';
import type { StallResult } from '../../src/engines/stall-detection.js';

describe('StallDetectionEngine', () => {
  let engine: StallDetectionEngine;

  beforeEach(() => {
    engine = new StallDetectionEngine();
  });

  // ---------------------------------------------------------------------------
  // onFailure — threshold behaviour
  // ---------------------------------------------------------------------------

  describe('onFailure', () => {
    it('returns null on the 1st failure (below default threshold of 3)', () => {
      expect(engine.onFailure('Read')).toBeNull();
    });

    it('returns null on the 2nd failure (still below threshold)', () => {
      engine.onFailure('Read');
      expect(engine.onFailure('Read')).toBeNull();
    });

    it('returns a StallResult on the 3rd failure (default threshold reached)', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      const result = engine.onFailure('Read');
      expect(result).not.toBeNull();
      expect(result).toMatchObject<Partial<StallResult>>({
        tool_name: 'Read',
        failure_count: 3,
      });
    });

    it('continues returning StallResult on subsequent failures past the threshold', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      engine.onFailure('Read'); // threshold hit
      const result = engine.onFailure('Read'); // 4th
      expect(result).not.toBeNull();
      expect(result?.failure_count).toBe(4);
    });

    it('increments counter correctly across calls', () => {
      engine.onFailure('Bash');
      engine.onFailure('Bash');
      expect(engine.getFailureCount('Bash')).toBe(2);
      engine.onFailure('Bash');
      expect(engine.getFailureCount('Bash')).toBe(3);
    });

    it('tracks failures independently per tool', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      engine.onFailure('Write');
      expect(engine.getFailureCount('Read')).toBe(2);
      expect(engine.getFailureCount('Write')).toBe(1);
    });

    it('respects a custom threshold of 5', () => {
      const custom = new StallDetectionEngine(5);
      for (let i = 0; i < 4; i++) {
        expect(custom.onFailure('Glob')).toBeNull();
      }
      const result = custom.onFailure('Glob');
      expect(result).not.toBeNull();
      expect(result?.failure_count).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // onSuccess
  // ---------------------------------------------------------------------------

  describe('onSuccess', () => {
    it('resets the failure counter to 0', () => {
      engine.onFailure('Bash');
      engine.onFailure('Bash');
      engine.onSuccess('Bash');
      expect(engine.getFailureCount('Bash')).toBe(0);
    });

    it('does not affect counters for other tools', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      engine.onSuccess('Bash');
      expect(engine.getFailureCount('Read')).toBe(2);
    });

    it('after a success reset, the tool needs threshold failures again to trigger', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      engine.onFailure('Read'); // threshold hit
      engine.onSuccess('Read'); // reset
      engine.onFailure('Read');
      engine.onFailure('Read');
      expect(engine.onFailure('Read')).not.toBeNull(); // threshold hit again
    });

    it('calling onSuccess on an unseen tool sets counter to 0 without error', () => {
      expect(() => engine.onSuccess('UnknownTool')).not.toThrow();
      expect(engine.getFailureCount('UnknownTool')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getFailureCount
  // ---------------------------------------------------------------------------

  describe('getFailureCount', () => {
    it('returns 0 for an unknown tool', () => {
      expect(engine.getFailureCount('NonExistentTool')).toBe(0);
    });

    it('returns the correct count after failures', () => {
      engine.onFailure('Grep');
      engine.onFailure('Grep');
      expect(engine.getFailureCount('Grep')).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // isStalled
  // ---------------------------------------------------------------------------

  describe('isStalled', () => {
    it('returns false when below threshold', () => {
      engine.onFailure('Write');
      engine.onFailure('Write');
      expect(engine.isStalled('Write')).toBe(false);
    });

    it('returns true when at threshold', () => {
      engine.onFailure('Write');
      engine.onFailure('Write');
      engine.onFailure('Write');
      expect(engine.isStalled('Write')).toBe(true);
    });

    it('returns true when above threshold', () => {
      engine.onFailure('Write');
      engine.onFailure('Write');
      engine.onFailure('Write');
      engine.onFailure('Write');
      expect(engine.isStalled('Write')).toBe(true);
    });

    it('returns false for an unknown tool', () => {
      expect(engine.isStalled('UnknownTool')).toBe(false);
    });

    it('returns false after a success resets the counter', () => {
      engine.onFailure('Edit');
      engine.onFailure('Edit');
      engine.onFailure('Edit');
      engine.onSuccess('Edit');
      expect(engine.isStalled('Edit')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // classifyCause (tested via onFailure results)
  // ---------------------------------------------------------------------------

  describe('classifyCause', () => {
    function triggerStall(
      e: StallDetectionEngine,
      toolName: string,
      errorMessage?: string,
    ): StallResult {
      e.onFailure(toolName, errorMessage);
      e.onFailure(toolName, errorMessage);
      const result = e.onFailure(toolName, errorMessage);
      if (!result) throw new Error('Expected StallResult but got null');
      return result;
    }

    it('Read failures → information_deficit', () => {
      const result = triggerStall(engine, 'Read');
      expect(result.cause).toBe('information_deficit');
    });

    it('Grep failures → information_deficit', () => {
      const result = triggerStall(engine, 'Grep');
      expect(result.cause).toBe('information_deficit');
    });

    it('Glob failures → information_deficit', () => {
      const result = triggerStall(engine, 'Glob');
      expect(result.cause).toBe('information_deficit');
    });

    it('WebSearch failures → information_deficit', () => {
      const result = triggerStall(engine, 'WebSearch');
      expect(result.cause).toBe('information_deficit');
    });

    it('WebFetch failures → information_deficit', () => {
      const result = triggerStall(engine, 'WebFetch');
      expect(result.cause).toBe('information_deficit');
    });

    it('Bash with "permission denied" error → permission_deficit', () => {
      const result = triggerStall(engine, 'Bash', 'permission denied');
      expect(result.cause).toBe('permission_deficit');
    });

    it('Bash with "EACCES" error → permission_deficit', () => {
      const result = triggerStall(engine, 'Bash', 'EACCES: operation not permitted');
      expect(result.cause).toBe('permission_deficit');
    });

    it('Write failures → capability_deficit', () => {
      const result = triggerStall(engine, 'Write');
      expect(result.cause).toBe('capability_deficit');
    });

    it('Edit failures → capability_deficit', () => {
      const result = triggerStall(engine, 'Edit');
      expect(result.cause).toBe('capability_deficit');
    });

    it('NotebookEdit failures → capability_deficit', () => {
      const result = triggerStall(engine, 'NotebookEdit');
      expect(result.cause).toBe('capability_deficit');
    });

    it('Unknown tool with "timeout" error → external_dependency', () => {
      const result = triggerStall(engine, 'SomeTool', 'connection timeout');
      expect(result.cause).toBe('external_dependency');
    });

    it('Unknown tool with "ECONNREFUSED" error → external_dependency', () => {
      const result = triggerStall(engine, 'SomeTool', 'connect ECONNREFUSED 127.0.0.1:3000');
      expect(result.cause).toBe('external_dependency');
    });

    it('Unknown tool with "network" error → external_dependency', () => {
      const result = triggerStall(engine, 'SomeTool', 'network error');
      expect(result.cause).toBe('external_dependency');
    });

    it('Bash with "not found" error → information_deficit', () => {
      const result = triggerStall(engine, 'Bash', 'command not found: foo');
      expect(result.cause).toBe('information_deficit');
    });

    it('Bash with "no such file" error → information_deficit', () => {
      const result = triggerStall(engine, 'Bash', 'no such file or directory');
      expect(result.cause).toBe('information_deficit');
    });

    it('Bash with unrecognised error → capability_deficit', () => {
      const result = triggerStall(engine, 'Bash', 'exit status 1');
      expect(result.cause).toBe('capability_deficit');
    });

    it('completely unknown tool with no error message → external_dependency', () => {
      const result = triggerStall(engine, 'MyCustomTool');
      expect(result.cause).toBe('external_dependency');
    });

    it('permission keyword takes precedence over tool-name heuristic (Read + permission error)', () => {
      const result = triggerStall(engine, 'Read', 'forbidden: access denied');
      expect(result.cause).toBe('permission_deficit');
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery strategies
  // ---------------------------------------------------------------------------

  describe('recovery strategies', () => {
    function triggerStall(
      e: StallDetectionEngine,
      toolName: string,
      errorMessage?: string,
    ): StallResult {
      e.onFailure(toolName, errorMessage);
      e.onFailure(toolName, errorMessage);
      const result = e.onFailure(toolName, errorMessage);
      if (!result) throw new Error('Expected StallResult but got null');
      return result;
    }

    it('information_deficit → investigate strategy', () => {
      const result = triggerStall(engine, 'Read');
      expect(result.recovery.type).toBe('investigate');
      expect(result.recovery.description).toContain('Read');
    });

    it('permission_deficit → escalate strategy', () => {
      const result = triggerStall(engine, 'Bash', 'permission denied');
      expect(result.recovery.type).toBe('escalate');
      expect(result.recovery.description).toContain('Bash');
    });

    it('capability_deficit → redefine_goal strategy', () => {
      const result = triggerStall(engine, 'Write');
      expect(result.recovery.type).toBe('redefine_goal');
      expect(result.recovery.description).toContain('Write');
    });

    it('external_dependency → switch_task strategy', () => {
      const result = triggerStall(engine, 'SomeTool', 'timeout');
      expect(result.recovery.type).toBe('switch_task');
      expect(result.recovery.description).toContain('SomeTool');
    });
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  describe('reset', () => {
    it('clears all counters', () => {
      engine.onFailure('Read');
      engine.onFailure('Read');
      engine.onFailure('Write');
      engine.reset();
      expect(engine.getFailureCount('Read')).toBe(0);
      expect(engine.getFailureCount('Write')).toBe(0);
    });

    it('after reset, isStalled returns false for previously stalled tools', () => {
      engine.onFailure('Bash');
      engine.onFailure('Bash');
      engine.onFailure('Bash');
      expect(engine.isStalled('Bash')).toBe(true);
      engine.reset();
      expect(engine.isStalled('Bash')).toBe(false);
    });

    it('after reset, threshold failures are needed again to trigger', () => {
      engine.onFailure('Grep');
      engine.onFailure('Grep');
      engine.onFailure('Grep');
      engine.reset();
      engine.onFailure('Grep');
      engine.onFailure('Grep');
      expect(engine.onFailure('Grep')).not.toBeNull();
    });

    it('calling reset on a fresh engine does not throw', () => {
      expect(() => engine.reset()).not.toThrow();
    });
  });
});
