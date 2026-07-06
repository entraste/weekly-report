import { describe, expect, it, vi } from 'vitest';
import { aggregate } from '../src/metrics/aggregate.js';
import { computeHighlights } from '../src/metrics/highlights.js';
import { buildReport } from '../src/metrics/report.js';
import type { Report } from '../src/metrics/types.js';
import { renderEmailHtml, mdInlineToHtml } from '../src/render/email.js';
import { buildSlackPayload, mdToMrkdwn } from '../src/render/slack.js';
import { deliverToSlack } from '../src/deliver/slack.js';
import { deliverEmail } from '../src/deliver/resend.js';
import { parseConfigFile } from '../src/config/file-config.js';
import { NOW, busyWeek, testConfig } from './fixtures.js';

function makeReport(): Report {
  const config = testConfig();
  const data = busyWeek();
  const metrics = aggregate(data, config);
  return buildReport({
    data,
    metrics,
    highlights: computeHighlights(data, metrics, config, NOW),
    config,
    narrative: {
      executiveSummary: 'Solid week.',
      repoNotes: [{ repo: 'api', note: 'Shipped rate limiting.' }],
      teamNote: 'Well done all.'
    },
    narrativeStatus: 'ok',
    llmUsage: null,
    runUrl: 'https://github.com/acme/reports/actions/runs/1'
  });
}

describe('slack renderer', () => {
  const payload = buildSlackPayload(makeReport());

  it('builds a compact block set with fallback text', () => {
    expect(payload.text).toContain('acme');
    expect(payload.blocks.length).toBeLessThanOrEqual(9);
    expect(payload.blocks[0]).toMatchObject({ type: 'header' });
  });

  it('caps key-number fields at 10 (Slack limit)', () => {
    const fieldsBlock = payload.blocks.find((b) => Array.isArray((b as { fields?: unknown[] }).fields)) as {
      fields: unknown[];
    };
    expect(fieldsBlock.fields.length).toBeLessThanOrEqual(10);
  });

  it('converts markdown links/bold to mrkdwn', () => {
    expect(mdToMrkdwn('see [api#7](https://x.y/pr/7) by **dave**')).toBe('see <https://x.y/pr/7|api#7> by *dave*');
  });

  it('shows top-3 highlights only', () => {
    const text = JSON.stringify(payload.blocks);
    expect(text).toContain('Oldest open PR');
    expect(text).not.toContain('Most active repo'); // highlight #8 must not be in top-3
  });
});

describe('slack delivery', () => {
  const payload = { text: 'hi', blocks: [] };

  it('succeeds on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const result = await deliverToSlack('https://hooks.slack.test/x', payload, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(true);
  });

  it('falls back to minimal payload on 400', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('invalid_blocks', { status: 400 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await deliverToSlack('https://hooks.slack.test/x', payload, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('fallback');
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.blocks).toBeUndefined();
  });

  it('reports failure when everything fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    const result = await deliverToSlack('https://hooks.slack.test/x', payload, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe('email renderer + delivery', () => {
  it('renders table-based HTML with escaped content', () => {
    const html = renderEmailHtml(makeReport());
    expect(html).toContain('<table');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('@alice');
    expect(html).not.toContain('<script');
  });

  it('escapes HTML in markdown conversion but keeps links', () => {
    expect(mdInlineToHtml('<img> [x](https://a.b) **y**')).toBe(
      '&lt;img&gt; <a href="https://a.b" style="color:#0969da;text-decoration:none;">x</a> <strong>y</strong>'
    );
  });

  it('batches recipients at 50 per Resend call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const to = Array.from({ length: 120 }, (_, i) => `dev${i}@acme.dev`);
    const result = await deliverEmail(
      're_key',
      { from: 'r@acme.dev', to, subject: 's', html: '<p>x</p>', text: 'x' },
      fetchMock as unknown as typeof fetch
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 50 + 50 + 20
  });
});

describe('config file parsing', () => {
  it('accepts a valid file and strips secret-looking keys with a warning', () => {
    const yaml = [
      'language: es',
      'period: monthly',
      'slack:',
      '  top-highlights: 2',
      'llm:',
      '  api-key: SHOULD-NEVER-BE-HERE',
      '  tone: neutral'
    ].join('\n');
    const result = parseConfigFile(yaml, '.github/weekly-report.yml');
    expect(result.config?.language).toBe('es');
    expect(result.config?.llm?.tone).toBe('neutral');
    expect(result.warnings.join(' ')).toMatch(/api-key/);
  });

  it('fails loudly on unknown keys (typo protection)', () => {
    expect(() => parseConfigFile('lenguage: es', 'cfg')).toThrow(/failed validation/);
    expect(() => parseConfigFile('levels:\n  orgs: true', 'cfg')).toThrow(/failed validation/);
  });

  it('handles empty files and rejects non-mapping YAML', () => {
    expect(parseConfigFile('', 'cfg').config).toBeUndefined();
    expect(() => parseConfigFile('- a\n- b', 'cfg')).toThrow(/mapping/);
  });
});
