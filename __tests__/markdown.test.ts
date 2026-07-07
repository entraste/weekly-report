import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/metrics/aggregate.js';
import { computeHighlights } from '../src/metrics/highlights.js';
import { buildReport } from '../src/metrics/report.js';
import type { Report } from '../src/metrics/types.js';
import { renderMarkdown } from '../src/render/markdown.js';
import type { Language } from '../src/schema/index.js';
import { NOW, busyWeek, collectedData, testConfig } from './fixtures.js';

function makeReport(language: Language, narrative = false): Report {
  const config = testConfig({ language });
  const data = busyWeek();
  const metrics = aggregate(data, config);
  return buildReport({
    data,
    metrics,
    highlights: computeHighlights(data, metrics, config, NOW),
    config,
    narrative: narrative
      ? {
          executiveSummary: 'A strong week focused on the API: rate limiting landed and review flow stayed healthy.',
          repoNotes: [{ repo: 'api', note: 'Rate limiter + N+1 fix merged; billing refactor still waiting.' }],
          teamNote: 'Bob carried reviews this week; dave landed his first contribution.'
        }
      : null,
    narrativeStatus: narrative ? 'ok' : 'skipped-no-key',
    llmUsage: narrative
      ? { provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 6200, outputTokens: 1400, estimatedCostUsd: 0.04 }
      : null,
    runUrl: 'https://github.com/acme/reports/actions/runs/123'
  });
}

describe('renderMarkdown', () => {
  it('renders the full English report (snapshot)', () => {
    expect(renderMarkdown(makeReport('en', true))).toMatchSnapshot();
  });

  it('renders the full Spanish report (snapshot)', () => {
    expect(renderMarkdown(makeReport('es', true))).toMatchSnapshot();
  });

  it('shows a metrics-only notice when the narrative is missing', () => {
    const md = renderMarkdown(makeReport('en', false));
    expect(md).toContain('metrics-only');
    expect(md).not.toContain('A strong week');
  });

  it('localizes deterministic templates to Spanish', () => {
    const md = renderMarkdown(makeReport('es', true));
    expect(md).toContain('## Números Clave');
    expect(md).toContain('PR abierto más antiguo');
    expect(md).toContain('Semana del');
    expect(md).toContain('¡bienvenidos!');
  });

  it('every number in Key Numbers comes from deterministic metrics', () => {
    const report = makeReport('en', true);
    const md = renderMarkdown(report);
    expect(md).toContain('| PRs merged | 4 |');
    expect(md).toContain('| PRs opened | 3 |');
    expect(md).toContain('| Commits (default branches) | 76 |');
  });

  it('handles a totally empty window without crashing', () => {
    const config = testConfig();
    const data = collectedData();
    const metrics = aggregate(data, config);
    const report = buildReport({
      data,
      metrics,
      highlights: [],
      config,
      narrative: null,
      narrativeStatus: 'skipped-no-key',
      llmUsage: null,
      runUrl: 'https://example.com/run'
    });
    const md = renderMarkdown(report);
    expect(md).toContain('No tracked activity');
  });

  it('includes the collapsible per-repo merged-PR detail', () => {
    const md = renderMarkdown(makeReport('en', true));
    expect(md).toContain('<details>');
    expect(md).toContain('View all 4 merged PRs');
    expect(md).toContain('**api** (2)');
    expect(md).toContain('[api#1](https://github.com/acme/api/pull/1)');
    expect(md).toContain('“Add rate limiter” — @alice');
  });

  it('respects disabled report levels', () => {
    const config = testConfig({ 'report-levels': 'org' });
    const data = busyWeek();
    const metrics = aggregate(data, config);
    const report = buildReport({
      data,
      metrics,
      highlights: [],
      config,
      narrative: null,
      narrativeStatus: 'skipped-no-key',
      llmUsage: null,
      runUrl: 'https://example.com/run'
    });
    const md = renderMarkdown(report);
    expect(md).not.toContain('## Repository Activity');
    expect(md).not.toContain('## Contributors');
  });
});
