/**
 * Workflow YAML generator. Uses eemeli's `yaml` Document API so we get
 * deterministic ordering and guidance comments in the output.
 *
 * SECURITY: only `${{ secrets.NAME }}` / `${{ vars.NAME }}` references are
 * ever emitted — never secret values.
 */
import { Document } from 'yaml';
import type { ConfiguratorState } from '../state.js';

function cronFor(state: ConfiguratorState): string {
  const m = state.minute;
  const h = state.hour;
  switch (state.cadence) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'monthly':
      return `${m} ${h} 1 * *`;
    default:
      // weekly + biweekly share a weekly cron (the action gates parity)
      return `${m} ${h} * * ${state.dayOfWeek % 7}`; // cron: 0=Sun
  }
}

export function periodFor(state: ConfiguratorState): string {
  return state.cadence;
}

export function isMultiOrg(state: ConfiguratorState): boolean {
  return state.extraOrgs.length > 0;
}

export function isMatrixMode(state: ConfiguratorState): boolean {
  return isMultiOrg(state) && state.multiOrgMode === 'matrix';
}

export function isConsolidated(state: ConfiguratorState): boolean {
  return isMultiOrg(state) && state.multiOrgMode === 'consolidated';
}

function allOrgs(state: ConfiguratorState): Array<{ org: string; tokenSecret: string }> {
  return [
    { org: state.org.trim(), tokenSecret: state.githubTokenSecret },
    ...state.extraOrgs.map((e) => ({ org: e.org.trim(), tokenSecret: e.tokenSecret }))
  ];
}

/** Matrix rows: primary org first, then each extra org. */
export function matrixInclude(state: ConfiguratorState): Array<Record<string, string>> {
  const entries = [
    { org: state.org.trim(), tokenSecret: state.githubTokenSecret, slackSecret: state.slackSecret, language: state.language },
    ...state.extraOrgs.map((e) => ({
      org: e.org.trim(),
      tokenSecret: e.tokenSecret,
      slackSecret: e.slackSecret,
      language: e.language
    }))
  ];
  return entries.map((e) => {
    const row: Record<string, string> = { org: e.org };
    if (state.auth === 'pat') row.token_secret = e.tokenSecret;
    if (state.slackEnabled) row.slack_secret = e.slackSecret;
    row.language = e.language;
    return row;
  });
}

/** `with:` entries, only for values that differ from action defaults. */
export function buildWithEntries(state: ConfiguratorState): Record<string, string> {
  const entries: Record<string, string> = {};
  const matrixMode = isMatrixMode(state);
  const consolidated = isConsolidated(state);

  if (state.auth !== 'pat') {
    entries['github-token'] = '${{ steps.app-token.outputs.token }}';
  } else if (matrixMode) {
    entries['github-token'] = '${{ secrets[matrix.token_secret] }}';
  } else if (consolidated) {
    // One token per org, same order as `org` — the action zips them.
    entries['github-token'] = allOrgs(state)
      .map((e) => `\${{ secrets.${e.tokenSecret} }}`)
      .join(',');
  } else {
    entries['github-token'] = `\${{ secrets.${state.githubTokenSecret} }}`;
  }

  if (matrixMode) entries['org'] = '${{ matrix.org }}';
  else if (consolidated) entries['org'] = allOrgs(state).map((e) => e.org).join(', ');
  else if (state.org.trim()) entries['org'] = state.org.trim();

  // Explicit provider pinning: a missing repo secret then fails loudly with
  // E_LLM_CONFIG instead of silently degrading to a metrics-only report.
  if (state.llm === 'anthropic') {
    entries['anthropic-api-key'] = `\${{ secrets.${state.anthropicSecret} }}`;
    entries['llm-provider'] = 'anthropic';
  }
  if (state.llm === 'openai') {
    entries['openai-api-key'] = `\${{ secrets.${state.openaiSecret} }}`;
    entries['llm-provider'] = 'openai';
  }
  if (state.llm === 'none') entries['llm-provider'] = 'none';

  if (matrixMode) entries['language'] = '${{ matrix.language }}';
  else if (state.language !== 'en') entries['language'] = state.language;

  const levels = ['org', 'repo', 'person'].filter((l) => state.levels[l as keyof typeof state.levels]);
  // Zero levels is a lint error; emitting '' would silently mean "all levels".
  if (levels.length > 0 && levels.length < 3) entries['report-levels'] = levels.join(',');

  const enabled = Object.entries(state.highlights).filter(([, on]) => on).map(([id]) => id);
  if (enabled.length === 0) entries['highlights'] = 'none';
  else if (enabled.length < Object.keys(state.highlights).length) entries['highlights'] = enabled.join(',');

  if (state.cadence !== 'weekly') entries['period'] = periodFor(state);
  if (state.timezone !== 'UTC') entries['timezone'] = state.timezone;

  if (state.reposInclude.trim()) entries['repos-include'] = state.reposInclude.trim();
  if (state.reposExclude.trim()) entries['repos-exclude'] = state.reposExclude.trim();

  if (state.slackEnabled) {
    entries['slack-webhook-url'] = matrixMode
      ? '${{ secrets[matrix.slack_secret] }}'
      : `\${{ secrets.${state.slackSecret} }}`;
  }
  if (state.emailEnabled) {
    entries['resend-api-key'] = `\${{ secrets.${state.resendSecret} }}`;
    if (state.emailTo.trim()) entries['email-to'] = state.emailTo.trim();
    if (state.emailFrom.trim()) entries['email-from'] = state.emailFrom.trim();
  }

  // Manual runs with a custom window
  entries['start-date'] = '${{ inputs.start-date }}';
  entries['end-date'] = '${{ inputs.end-date }}';

  return entries;
}

export function generateWorkflow(state: ConfiguratorState): string {
  const uses = `${state.actionRef || 'OWNER/weekly-report'}@${state.actionVersion || 'v1'}`;
  const matrixMode = isMatrixMode(state);

  const steps: Array<Record<string, unknown>> = [];
  if (state.auth === 'app') {
    steps.push({
      name: 'Mint an org-wide GitHub App token',
      id: 'app-token',
      uses: 'actions/create-github-app-token@v3',
      with: {
        'app-id': `\${{ vars.${state.appIdVar} }}`,
        'private-key': `\${{ secrets.${state.appKeySecret} }}`,
        // Matrix mode: the same App must be installed on every org listed.
        owner: matrixMode ? '${{ matrix.org }}' : '${{ github.repository_owner }}'
      }
    });
  }
  steps.push({ uses, with: buildWithEntries(state) });

  const reportJob: Record<string, unknown> = {};
  if (matrixMode) {
    reportJob.name = 'report ${{ matrix.org }}';
    // One org failing must never cancel the others.
    reportJob.strategy = { 'fail-fast': false, matrix: { include: matrixInclude(state) } };
  }
  reportJob['runs-on'] = 'ubuntu-latest';
  reportJob.steps = steps;

  const doc = new Document({
    name: 'Weekly report',
    on: {
      schedule: [{ cron: cronFor(state) }],
      workflow_dispatch: {
        inputs: {
          'start-date': { description: 'Custom window start (YYYY-MM-DD, optional)', required: false },
          'end-date': { description: 'Custom window end (YYYY-MM-DD, optional)', required: false }
        }
      }
    },
    permissions: { contents: 'read' },
    jobs: { report: reportJob }
  });

  // Guidance comments
  const cronNode = doc.getIn(['on', 'schedule', 0, 'cron'], true);
  if (cronNode && typeof cronNode === 'object') {
    (cronNode as { comment?: string }).comment =
      ' GitHub cron runs in UTC and is best-effort (5-30 min delays are normal)';
  }

  return doc.toString({ lineWidth: 120 });
}
