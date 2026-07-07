import { describe, expect, it } from 'vitest';
import { enabledHighlights, resolveConfig } from '../src/config/resolve.js';
import type { ConfigFile } from '../src/schema/index.js';
import { INPUT_DEFS } from '../src/schema/index.js';
import { ActionError } from '../src/errors.js';

/** Build a getInput that returns action.yml defaults unless overridden. */
function stubInputs(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {};
  for (const def of INPUT_DEFS) {
    defaults[def.key] = def.default && !def.default.includes('${{') ? def.default : '';
  }
  return (name: string): string => overrides[name] ?? defaults[name] ?? '';
}

const BASE = { 'github-token': 'ghp_test' };

describe('resolveConfig', () => {
  it('produces full defaults from minimal inputs', () => {
    const cfg = resolveConfig({ getInput: stubInputs(BASE), repositoryOwner: 'acme' });
    expect(cfg.org).toBe('acme');
    expect(cfg.period).toBe('weekly');
    expect(cfg.language).toBe('en');
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.levels).toEqual({ org: true, repo: true, person: true });
    expect(cfg.repos.include).toEqual(['*']);
    expect(cfg.llm.provider).toBe('none'); // no keys → metrics-only
    expect(cfg.output).toEqual({ jobSummary: true, artifact: true, artifactName: 'weekly-report' });
    expect(enabledHighlights(cfg)).toHaveLength(8);
    expect(cfg.dryRun).toBe(false);
  });

  it('requires github-token', () => {
    expect(() =>
      resolveConfig({ getInput: stubInputs({ 'github-token': '' }), repositoryOwner: 'acme' })
    ).toThrowError(ActionError);
  });

  it('llm auto-selection prefers anthropic, falls back to openai', () => {
    const both = resolveConfig({
      getInput: stubInputs({ ...BASE, 'anthropic-api-key': 'sk-ant', 'openai-api-key': 'sk-oai' }),
      repositoryOwner: 'acme'
    });
    expect(both.llm.provider).toBe('anthropic');

    const onlyOpenai = resolveConfig({
      getInput: stubInputs({ ...BASE, 'openai-api-key': 'sk-oai' }),
      repositoryOwner: 'acme'
    });
    expect(onlyOpenai.llm.provider).toBe('openai');
  });

  it('explicit provider without its key fails', () => {
    expect(() =>
      resolveConfig({ getInput: stubInputs({ ...BASE, 'llm-provider': 'anthropic' }), repositoryOwner: 'acme' })
    ).toThrowError(/anthropic-api-key is not set/);
  });

  it('email config is validated only when resend key is present', () => {
    // No key → no email validation
    resolveConfig({ getInput: stubInputs(BASE), repositoryOwner: 'acme' });

    expect(() =>
      resolveConfig({ getInput: stubInputs({ ...BASE, 'resend-api-key': 're_x' }), repositoryOwner: 'acme' })
    ).toThrowError(/email-to and\/or email-from/);

    const ok = resolveConfig({
      getInput: stubInputs({
        ...BASE,
        'resend-api-key': 're_x',
        'email-to': 'a@b.co, c@d.co',
        'email-from': 'Reports <reports@acme.dev>'
      }),
      repositoryOwner: 'acme'
    });
    expect(ok.email.to).toEqual(['a@b.co', 'c@d.co']);

    expect(() =>
      resolveConfig({
        getInput: stubInputs({
          ...BASE,
          'resend-api-key': 're_x',
          'email-to': 'not-an-email',
          'email-from': 'reports@acme.dev'
        }),
        repositoryOwner: 'acme'
      })
    ).toThrowError(/Invalid recipient/);
  });

  it('report-levels input overrides file and defaults; empty set rejected', () => {
    const file: ConfigFile = { levels: { person: false } };
    const fromFile = resolveConfig({ getInput: stubInputs(BASE), configFile: file, repositoryOwner: 'acme' });
    expect(fromFile.levels).toEqual({ org: true, repo: true, person: false });

    const fromInput = resolveConfig({
      getInput: stubInputs({ ...BASE, 'report-levels': 'org' }),
      configFile: file,
      repositoryOwner: 'acme'
    });
    expect(fromInput.levels).toEqual({ org: true, repo: false, person: false });

    expect(() =>
      resolveConfig({ getInput: stubInputs({ ...BASE, 'report-levels': 'nope' }), repositoryOwner: 'acme' })
    ).toThrowError(/Unknown report level/);
  });

  it('default-valued inputs let the config file win (precedence)', () => {
    const file: ConfigFile = { period: 'monthly', language: 'es', timezone: 'America/Montevideo' };
    const cfg = resolveConfig({ getInput: stubInputs(BASE), configFile: file, repositoryOwner: 'acme' });
    expect(cfg.period).toBe('monthly');
    expect(cfg.language).toBe('es');
    expect(cfg.timezone).toBe('America/Montevideo');

    // …but an explicit input still wins over the file.
    const cfg2 = resolveConfig({
      getInput: stubInputs({ ...BASE, period: 'daily' }),
      configFile: file,
      repositoryOwner: 'acme'
    });
    expect(cfg2.period).toBe('daily');
  });

  it('highlights: file tunes params, input coarse-controls the set', () => {
    const file: ConfigFile = {
      highlights: {
        'stale-prs': { 'threshold-days': 3, 'max-listed': 2 },
        'top-merger': false
      }
    };
    const cfg = resolveConfig({ getInput: stubInputs(BASE), configFile: file, repositoryOwner: 'acme' });
    expect(cfg.highlights['stale-prs'].params).toEqual({ thresholdDays: 3, maxListed: 2 });
    expect(cfg.highlights['top-merger'].enabled).toBe(false);

    const none = resolveConfig({
      getInput: stubInputs({ ...BASE, highlights: 'none' }),
      repositoryOwner: 'acme'
    });
    expect(enabledHighlights(none)).toEqual([]);

    const some = resolveConfig({
      getInput: stubInputs({ ...BASE, highlights: 'oldest-open-pr, top-merger' }),
      repositoryOwner: 'acme'
    });
    expect(enabledHighlights(some)).toEqual(['oldest-open-pr', 'top-merger']);

    expect(() =>
      resolveConfig({ getInput: stubInputs({ ...BASE, highlights: 'oldest-open-pr, nope' }), repositoryOwner: 'acme' })
    ).toThrowError(/Unknown highlight id/);
  });

  it('custom period requires dates', () => {
    expect(() =>
      resolveConfig({ getInput: stubInputs({ ...BASE, period: 'custom' }), repositoryOwner: 'acme' })
    ).toThrowError(/start-date and end-date/);

    const ok = resolveConfig({
      getInput: stubInputs({ ...BASE, period: 'custom', 'start-date': '2026-06-01', 'end-date': '2026-06-15' }),
      repositoryOwner: 'acme'
    });
    expect(ok.startDate).toBe('2026-06-01');
    expect(ok.endDate).toBe('2026-06-15');
  });

  it('providing both dates auto-switches the window to custom', () => {
    const cfg = resolveConfig({
      getInput: stubInputs({ ...BASE, 'start-date': '2026-06-01', 'end-date': '2026-06-15' }),
      repositoryOwner: 'acme'
    });
    expect(cfg.period).toBe('custom');
    expect(cfg.startDate).toBe('2026-06-01');
  });

  it('dry-run parses as boolean', () => {
    const cfg = resolveConfig({ getInput: stubInputs({ ...BASE, 'dry-run': 'true' }), repositoryOwner: 'acme' });
    expect(cfg.dryRun).toBe(true);
  });
});
