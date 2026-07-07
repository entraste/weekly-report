import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { configFileSchema } from '../../src/schema/config-file.js';
import { INPUT_DEFS } from '../../src/schema/inputs.js';
import { buildConfigObject, generateConfigFile, needsConfigFile } from '../src/generator/config-file.js';
import { lint } from '../src/generator/lint.js';
import { secretsChecklist } from '../src/generator/secrets.js';
import { buildWithEntries, generateWorkflow } from '../src/generator/workflow.js';
import { DEFAULT_STATE } from '../src/state.js';
import type { ConfiguratorState } from '../src/state.js';

const KNOWN_KEYS = new Set(INPUT_DEFS.map((d) => d.key));

function makeState(patch: Partial<ConfiguratorState> = {}): ConfiguratorState {
  return { ...DEFAULT_STATE, actionRef: 'acme/weekly-report', ...patch };
}

describe('generateWorkflow', () => {
  it('produces parseable YAML with schedule + dispatch + least privilege', () => {
    const yaml = generateWorkflow(makeState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parse(yaml) as any;
    expect(parsed['on']['schedule'][0]['cron']).toBe('17 9 * * 1');
    expect(parsed['on']['workflow_dispatch']['inputs']['start-date']).toBeDefined();
    expect(parsed['permissions']).toEqual({ contents: 'read' });
    expect(parsed['jobs']['report']['steps'].at(-1)['uses']).toBe('acme/weekly-report@v1');
  });

  it('every with: key exists in the action input registry (drift guard)', () => {
    const matrix: Array<Partial<ConfiguratorState>> = [
      {},
      { auth: 'app', llm: 'openai', emailEnabled: true, emailTo: 'a@b.co', emailFrom: 'r@b.co' },
      { llm: 'none', slackEnabled: false, cadence: 'monthly', language: 'es', timezone: 'America/Montevideo' },
      { cadence: 'biweekly', levels: { org: true, repo: false, person: false }, reposInclude: 'api-*' }
    ];
    for (const patch of matrix) {
      const entries = buildWithEntries(makeState(patch));
      for (const key of Object.keys(entries)) {
        expect(KNOWN_KEYS.has(key), `unknown input "${key}"`).toBe(true);
      }
    }
  });

  it('NEVER emits anything that is not a secrets/vars/steps reference for secret inputs', () => {
    const secretInputs = new Set(INPUT_DEFS.filter((d) => d.secret).map((d) => d.key));
    const entries = buildWithEntries(
      makeState({ auth: 'app', emailEnabled: true, emailTo: 'a@b.co', emailFrom: 'r@b.co', llm: 'anthropic' })
    );
    for (const [key, value] of Object.entries(entries)) {
      if (secretInputs.has(key)) {
        expect(value, `${key} must be a runtime reference`).toMatch(/^\$\{\{ (secrets|vars|steps)\./);
      }
    }
  });

  it('cron shapes match the cadence', () => {
    expect(parse(generateWorkflow(makeState({ cadence: 'daily' })))['on']['schedule'][0]['cron']).toBe('17 9 * * *');
    expect(parse(generateWorkflow(makeState({ cadence: 'monthly' })))['on']['schedule'][0]['cron']).toBe('17 9 1 * *');
    expect(parse(generateWorkflow(makeState({ cadence: 'weekly', dayOfWeek: 7 })))['on']['schedule'][0]['cron']).toBe(
      '17 9 * * 0' // Sunday → cron 0
    );
  });

  it('app auth adds the create-github-app-token step before the action', () => {
    const parsed = parse(generateWorkflow(makeState({ auth: 'app' })));
    const steps = parsed['jobs']['report']['steps'];
    expect(steps).toHaveLength(2);
    expect(steps[0]['uses']).toContain('actions/create-github-app-token');
    expect(steps[1]['with']['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('defaults are omitted from with: (lean output)', () => {
    const entries = buildWithEntries(makeState());
    expect(entries['language']).toBeUndefined(); // en = default
    expect(entries['period']).toBeUndefined(); // weekly = default
    expect(entries['timezone']).toBeUndefined(); // UTC = default
    expect(entries['report-levels']).toBeUndefined(); // all three = default
    expect(entries['highlights']).toBeUndefined(); // all = default
  });

  it('snapshot: full-featured Spanish workflow', () => {
    expect(
      generateWorkflow(
        makeState({
          org: 'acme',
          language: 'es',
          timezone: 'America/Montevideo',
          cadence: 'biweekly',
          emailEnabled: true,
          emailTo: 'equipo@acme.dev',
          emailFrom: 'Reportes <reportes@acme.dev>'
        })
      )
    ).toMatchSnapshot();
  });
});

describe('generateConfigFile', () => {
  it('is only needed when non-input settings differ from defaults', () => {
    expect(needsConfigFile(makeState())).toBe(false);
    expect(needsConfigFile(makeState({ tone: 'neutral' }))).toBe(true);
    expect(needsConfigFile(makeState({ staleThresholdDays: 3 }))).toBe(true);
    expect(needsConfigFile(makeState({ peopleExclude: 'octocat' }))).toBe(true);
    expect(needsConfigFile(makeState({ cadence: 'biweekly', biweeklyAnchor: 'odd' }))).toBe(true);
  });

  it('round-trips through the action config schema (no drift possible)', () => {
    const state = makeState({
      tone: 'playful',
      staleThresholdDays: 3,
      peopleExclude: 'octocat, hubot',
      excludeBots: false,
      cadence: 'biweekly',
      biweeklyAnchor: 'odd'
    });
    const yamlText = generateConfigFile(state);
    const parsed = parse(yamlText);
    const result = configFileSchema.safeParse(parsed);
    expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
    expect(buildConfigObject(state)['biweekly-anchor']).toBe('odd');
  });
});

describe('lint', () => {
  it('flags missing delivery, bad email config, empty levels', () => {
    const messages = (s: ConfiguratorState) => lint(s).map((w) => w.message).join(' | ');
    expect(messages(makeState({ slackEnabled: false }))).toMatch(/No Slack or email/);
    expect(messages(makeState({ emailEnabled: true }))).toMatch(/recipient/);
    expect(lint(makeState({ levels: { org: false, repo: false, person: false } })).some((w) => w.level === 'error')).toBe(
      true
    );
    expect(messages(makeState({ actionRef: 'OWNER/ombupulse' }))).toMatch(/Replace the OWNER/);
  });
});

describe('secretsChecklist', () => {
  it('lists exactly the secrets the generated workflow references', () => {
    const state = makeState({ auth: 'app', llm: 'openai', emailEnabled: true, emailTo: 'a@b.c', emailFrom: 'r@b.c' });
    const names = secretsChecklist(state).map((s) => s.name);
    expect(names).toEqual(['REPORT_APP_ID', 'REPORT_APP_PRIVATE_KEY', 'OPENAI_API_KEY', 'SLACK_WEBHOOK_URL', 'RESEND_API_KEY']);

    const yaml = generateWorkflow(state);
    for (const name of names) {
      expect(yaml).toContain(name);
    }
  });
});
