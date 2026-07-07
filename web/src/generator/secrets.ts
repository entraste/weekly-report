/**
 * Secrets checklist: what the user must create in the target repo, with
 * step-by-step pointers. Names only — values never touch this app.
 */
import type { ConfiguratorState } from '../state.js';

export interface SecretItem {
  name: string;
  kind: 'secret' | 'variable';
  what: string;
  how: string;
}

export function secretsChecklist(state: ConfiguratorState): SecretItem[] {
  const items: SecretItem[] = [];

  if (state.auth === 'pat') {
    items.push({
      name: state.githubTokenSecret,
      kind: 'secret',
      what: 'Org fine-grained PAT with read-only Metadata, Pull requests, Issues and Contents on ALL repositories.',
      how: 'GitHub → Settings → Developer settings → Fine-grained tokens. Resource owner = your ORG. Watch the expiration date.'
    });
  } else {
    items.push(
      {
        name: state.appIdVar,
        kind: 'variable',
        what: 'The GitHub App ID (numeric).',
        how: 'Org → Settings → Developer settings → GitHub Apps → your app → App ID. Store as a repository VARIABLE.'
      },
      {
        name: state.appKeySecret,
        kind: 'secret',
        what: "The App's private key (PEM).",
        how: 'Same app page → Generate a private key. Install the app on all repositories.'
      }
    );
  }

  for (const entry of state.extraOrgs) {
    if (state.auth === 'pat' && entry.tokenSecret) {
      items.push({
        name: entry.tokenSecret,
        kind: 'secret',
        what: `Org fine-grained PAT for ${entry.org || '(unnamed org)'} — read-only Metadata, Pull requests, Issues, Contents on ALL its repositories.`,
        how: `Same procedure as the main PAT, but Resource owner = ${entry.org || 'that org'}.`
      });
    }
    if (state.multiOrgMode === 'matrix' && state.slackEnabled && entry.slackSecret && !items.some((i) => i.name === entry.slackSecret)) {
      items.push({
        name: entry.slackSecret,
        kind: 'secret',
        what: `Slack incoming webhook for ${entry.org || '(unnamed org)'}'s channel.`,
        how: 'Same Slack app → Incoming Webhooks → Add new webhook → pick that org/client channel.'
      });
    }
  }

  if (state.llm === 'anthropic') {
    items.push({
      name: state.anthropicSecret,
      kind: 'secret',
      what: 'Anthropic API key for the narrative.',
      how: 'console.anthropic.com → API keys.'
    });
  }
  if (state.llm === 'openai') {
    items.push({
      name: state.openaiSecret,
      kind: 'secret',
      what: 'OpenAI API key for the narrative.',
      how: 'platform.openai.com → API keys.'
    });
  }

  if (state.slackEnabled) {
    items.push({
      name: state.slackSecret,
      kind: 'secret',
      what: 'Slack incoming webhook URL (pins the channel).',
      how: 'api.slack.com/apps → your app → Incoming Webhooks → Add new webhook to workspace.'
    });
  }

  if (state.emailEnabled) {
    items.push({
      name: state.resendSecret,
      kind: 'secret',
      what: 'Resend API key for email delivery.',
      how: 'resend.com → API keys. Verify your sending domain (or test with onboarding@resend.dev).'
    });
  }

  return items;
}
