import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  WORKFLOW_FILENAME,
  editUrl,
  quickCreateUrl,
  runWorkflowUrl
} from '../src/generator/links.js';
import { DEFAULT_STATE, sanitizeSaved } from '../src/state.js';

describe('GitHub deep links', () => {
  it('builds quick-create, edit and run URLs for a valid repo', () => {
    expect(quickCreateUrl('ombustudio/reports', WORKFLOW_FILENAME, 'name: x')).toContain(
      'github.com/ombustudio/reports/new/main?filename='
    );
    expect(editUrl('ombustudio/reports', WORKFLOW_FILENAME)).toBe(
      'https://github.com/ombustudio/reports/edit/main/.github/workflows/weekly-report.yml'
    );
    expect(editUrl('ombustudio/reports', CONFIG_FILENAME)).toBe(
      'https://github.com/ombustudio/reports/edit/main/.github/weekly-report.yml'
    );
    expect(runWorkflowUrl('ombustudio/reports')).toBe(
      'https://github.com/ombustudio/reports/actions/workflows/weekly-report.yml'
    );
  });

  it('returns null for invalid repos and oversized content', () => {
    for (const bad of ['', 'no-slash', 'a/b/c', 'owner/repo with spaces']) {
      expect(quickCreateUrl(bad, WORKFLOW_FILENAME, 'x')).toBeNull();
      expect(editUrl(bad, WORKFLOW_FILENAME)).toBeNull();
      expect(runWorkflowUrl(bad)).toBeNull();
    }
    expect(quickCreateUrl('a/b', WORKFLOW_FILENAME, 'x'.repeat(9000))).toBeNull();
  });
});

describe('sanitizeSaved (localStorage restore)', () => {
  it('keeps valid saved values and drops garbage', () => {
    const restored = sanitizeSaved({
      org: 'ombustudio',
      language: 'es',
      cadence: 'monthly',
      hour: 99, // clamped
      minute: -5, // clamped
      llm: 'skynet', // invalid enum → dropped
      levels: { org: false, bogus: true },
      highlights: { 'top-merger': false, 'made-up': true },
      injected: 'nope'
    });
    expect(restored.org).toBe('ombustudio');
    expect(restored.language).toBe('es');
    expect(restored.cadence).toBe('monthly');
    expect(restored.hour).toBe(23);
    expect(restored.minute).toBe(0);
    expect(restored.llm).toBeUndefined();
    expect(restored.levels).toEqual({ org: false, repo: true, person: true });
    expect((restored.highlights as Record<string, boolean>)['top-merger']).toBe(false);
    expect((restored.highlights as Record<string, boolean>)['made-up']).toBeUndefined();
    expect((restored as Record<string, unknown>).injected).toBeUndefined();
  });

  it('tolerates junk input entirely', () => {
    expect(sanitizeSaved(null)).toEqual({});
    expect(sanitizeSaved('corrupted')).toEqual({});
    expect(sanitizeSaved([1, 2])).toEqual(expect.any(Object));
  });

  it('a fully-restored state still generates without touching defaults', () => {
    const restored = { ...DEFAULT_STATE, ...sanitizeSaved({ language: 'es' }) };
    expect(restored.language).toBe('es');
    expect(restored.actionRef).toBe(DEFAULT_STATE.actionRef);
  });
});
