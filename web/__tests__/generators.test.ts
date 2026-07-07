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

describe('multi-org matrix', () => {
  const multi = makeState({
    org: 'ombustudio',
    multiOrgMode: 'matrix',
    extraOrgs: [
      { org: 'cliente-x', tokenSecret: 'CLIENTEX_TOKEN', slackSecret: 'CLIENTEX_SLACK', language: 'en' }
    ]
  });

  it('emits a fail-fast:false matrix with one row per org (primary first)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parse(generateWorkflow(multi)) as any;
    const job = parsed['jobs']['report'];
    expect(job['strategy']['fail-fast']).toBe(false);
    expect(job['name']).toBe('report ${{ matrix.org }}');
    const include = job['strategy']['matrix']['include'];
    expect(include).toHaveLength(2);
    expect(include[0]).toMatchObject({ org: 'ombustudio', token_secret: 'ORG_REPORT_GITHUB_TOKEN', language: 'en' });
    expect(include[1]).toMatchObject({ org: 'cliente-x', token_secret: 'CLIENTEX_TOKEN', language: 'en' });
    const withEntries = job['steps'].at(-1)['with'];
    expect(withEntries['org']).toBe('${{ matrix.org }}');
    expect(withEntries['github-token']).toBe('${{ secrets[matrix.token_secret] }}');
    expect(withEntries['slack-webhook-url']).toBe('${{ secrets[matrix.slack_secret] }}');
    expect(withEntries['language']).toBe('${{ matrix.language }}');
  });

  it('app auth mints the token per matrix org', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parse(generateWorkflow({ ...multi, auth: 'app' })) as any;
    const steps = parsed['jobs']['report']['steps'];
    expect(steps[0]['with']['owner']).toBe('${{ matrix.org }}');
    const include = parsed['jobs']['report']['strategy']['matrix']['include'];
    expect(include[0]['token_secret']).toBeUndefined();
  });

  it('matrix with: keys stay inside the input registry (drift guard)', () => {
    for (const key of Object.keys(buildWithEntries(multi))) {
      expect(KNOWN_KEYS.has(key), `unknown input "${key}"`).toBe(true);
    }
  });

  it('single-org output is untouched when extraOrgs is empty', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parse(generateWorkflow(makeState())) as any;
    expect(parsed['jobs']['report']['strategy']).toBeUndefined();
    expect(parsed['jobs']['report']['steps'].at(-1)['with']['github-token']).toBe(
      '${{ secrets.ORG_REPORT_GITHUB_TOKEN }}'
    );
  });

  it('lint demands a primary org and valid per-row secrets', () => {
    const errors = lint({ ...multi, org: '', extraOrgs: [{ org: '', tokenSecret: '1bad name', slackSecret: 'OK_S', language: 'en' }] })
      .filter((w) => w.level === 'error')
      .map((w) => w.message)
      .join(' | ');
    expect(errors).toMatch(/first matrix entry/);
    expect(errors).toMatch(/#1: organization name is empty/);
    expect(errors).toMatch(/token secret name/);
  });

  it('secrets checklist includes each extra org', () => {
    const names = secretsChecklist(multi).map((s) => s.name);
    expect(names).toContain('CLIENTEX_TOKEN');
    expect(names).toContain('CLIENTEX_SLACK');
  });
});

describe('multi-org consolidated (default mode)', () => {
  const consolidated = makeState({
    org: 'ombustudio',
    extraOrgs: [{ org: 'cliente-x', tokenSecret: 'CLIENTEX_TOKEN', slackSecret: 'SLACK_WEBHOOK_URL', language: 'en' }]
  });

  it('emits ONE job with org list + zipped token list (no matrix)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parse(generateWorkflow(consolidated)) as any;
    const job = parsed['jobs']['report'];
    expect(job['strategy']).toBeUndefined();
    const withEntries = job['steps'].at(-1)['with'];
    expect(withEntries['org']).toBe('ombustudio, cliente-x');
    expect(withEntries['github-token']).toBe(
      '${{ secrets.ORG_REPORT_GITHUB_TOKEN }},${{ secrets.CLIENTEX_TOKEN }}'
    );
    expect(withEntries['slack-webhook-url']).toBe('${{ secrets.SLACK_WEBHOOK_URL }}');
  });

  it('drift guard: consolidated with: keys stay in the registry', () => {
    for (const key of Object.keys(buildWithEntries(consolidated))) {
      expect(KNOWN_KEYS.has(key), `unknown input "${key}"`).toBe(true);
    }
  });

  it('lint blocks GitHub App auth in consolidated mode', () => {
    const errors = lint({ ...consolidated, auth: 'app' }).filter((w) => w.level === 'error');
    expect(errors.map((w) => w.message).join(' ')).toMatch(/Consolidated mode needs one PAT per org/);
  });

  it('secrets checklist: per-org tokens yes, per-org slack no', () => {
    const names = secretsChecklist(consolidated).map((s) => s.name);
    expect(names).toContain('CLIENTEX_TOKEN');
    expect(names.filter((n) => n === 'SLACK_WEBHOOK_URL')).toHaveLength(1);
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
