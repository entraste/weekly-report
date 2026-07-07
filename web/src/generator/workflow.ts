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

/** `with:` entries, only for values that differ from action defaults. */
export function buildWithEntries(state: ConfiguratorState): Record<string, string> {
  const entries: Record<string, string> = {};

  entries['github-token'] =
    state.auth === 'pat' ? `\${{ secrets.${state.githubTokenSecret} }}` : '${{ steps.app-token.outputs.token }}';

  if (state.org.trim()) entries['org'] = state.org.trim();

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

  if (state.language !== 'en') entries['language'] = state.language;

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

  if (state.slackEnabled) entries['slack-webhook-url'] = `\${{ secrets.${state.slackSecret} }}`;
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

  const steps: Array<Record<string, unknown>> = [];
  if (state.auth === 'app') {
    steps.push({
      name: 'Mint an org-wide GitHub App token',
      id: 'app-token',
      uses: 'actions/create-github-app-token@v3',
      with: {
        'app-id': `\${{ vars.${state.appIdVar} }}`,
        'private-key': `\${{ secrets.${state.appKeySecret} }}`,
        owner: '${{ github.repository_owner }}'
      }
    });
  }
  steps.push({ uses, with: buildWithEntries(state) });

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
    jobs: {
      report: {
        'runs-on': 'ubuntu-latest',
        steps
      }
    }
  });

  // Guidance comments
  const cronNode = doc.getIn(['on', 'schedule', 0, 'cron'], true);
  if (cronNode && typeof cronNode === 'object') {
    (cronNode as { comment?: string }).comment =
      ' GitHub cron runs in UTC and is best-effort (5-30 min delays are normal)';
  }

  return doc.toString({ lineWidth: 120 });
}
