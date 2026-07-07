/**
 * Live validation of the configurator state — warnings shown above the output.
 */
import type { ConfiguratorState } from '../state.js';

const VALID_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function usedSecretNames(state: ConfiguratorState): Array<[string, string]> {
  const names: Array<[string, string]> = [];
  if (state.auth === 'pat') names.push(['GitHub token secret', state.githubTokenSecret]);
  else names.push(['App ID variable', state.appIdVar], ['App key secret', state.appKeySecret]);
  if (state.llm === 'anthropic') names.push(['Anthropic secret', state.anthropicSecret]);
  if (state.llm === 'openai') names.push(['OpenAI secret', state.openaiSecret]);
  if (state.slackEnabled) names.push(['Slack secret', state.slackSecret]);
  if (state.emailEnabled) names.push(['Resend secret', state.resendSecret]);
  return names;
}

export interface Warning {
  level: 'error' | 'warn' | 'info';
  message: string;
}

export function lint(state: ConfiguratorState): Warning[] {
  const warnings: Warning[] = [];

  if (!state.actionRef || state.actionRef.startsWith('OWNER/')) {
    warnings.push({
      level: 'warn',
      message: 'Replace the OWNER/... placeholder with the published action reference (e.g. ombustudio/weekly-report).'
    });
  }

  if (!state.slackEnabled && !state.emailEnabled) {
    warnings.push({
      level: 'warn',
      message: 'No Slack or email delivery configured — the report will only appear in the job summary and artifact.'
    });
  }

  if (state.emailEnabled) {
    if (!state.emailTo.trim()) warnings.push({ level: 'error', message: 'Email delivery needs at least one recipient (email-to).' });
    if (!state.emailFrom.trim()) {
      warnings.push({
        level: 'error',
        message: 'Email delivery needs a Resend-verified sender (email-from). Use onboarding@resend.dev while testing.'
      });
    }
  }

  if (state.llm === 'none') {
    warnings.push({ level: 'info', message: 'Metrics-only mode: no LLM narrative will be generated.' });
  }

  if (state.cadence === 'biweekly') {
    warnings.push({
      level: 'info',
      message:
        'Biweekly runs use a weekly cron; the action skips alternate weeks (fortnight parity). Manual runs always produce a report.'
    });
  }

  for (const [label, name] of usedSecretNames(state)) {
    if (!VALID_SECRET_NAME.test(name)) {
      warnings.push({
        level: 'error',
        message: `${label} "${name}" is not a valid GitHub secret/variable name (letters, digits, underscores; cannot start with a digit).`
      });
    } else if (name.toUpperCase().startsWith('GITHUB_')) {
      warnings.push({ level: 'error', message: `${label} "${name}": the GITHUB_ prefix is reserved by GitHub.` });
    }
  }

  if (state.timezone !== 'UTC') {
    warnings.push({
      level: 'info',
      message: `Cron fires in UTC; with report timezone ${state.timezone} pick an hour that lands on the intended local day.`
    });
  }

  const noLevels = !state.levels.org && !state.levels.repo && !state.levels.person;
  if (noLevels) warnings.push({ level: 'error', message: 'Enable at least one report level.' });

  if (state.minute % 30 === 0) {
    warnings.push({
      level: 'info',
      message: 'Tip: crons at :00/:30 are the most congested on GitHub — an odd minute like :17 fires more punctually.'
    });
  }

  return warnings;
}
