/**
 * Configurator state. SECURITY INVARIANT: this state never holds secret
 * VALUES — only the NAMES of the repo secrets the workflow will reference
 * (`${{ secrets.X }}`). Enforced by tests on the generators.
 */
import { signal } from '@preact/signals';
import { HIGHLIGHT_IDS, INPUT_DEFS, inputDef } from '@schema/index';
import type { HighlightId } from '@schema/index';

export type AuthMode = 'pat' | 'app';
export type LlmChoice = 'anthropic' | 'openai' | 'none';
export type Cadence = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface ConfiguratorState {
  /** owner/repo of the published action, e.g. "acme/weekly-report" */
  actionRef: string;
  actionVersion: string;
  /** target repo (owner/repo) that will host the workflow — for quick-create links */
  targetRepo: string;
  org: string;

  auth: AuthMode;
  githubTokenSecret: string;
  appIdVar: string;
  appKeySecret: string;

  cadence: Cadence;
  dayOfWeek: number; // 1=Mon..7=Sun
  hour: number;
  minute: number;
  timezone: string;
  biweeklyAnchor: 'even' | 'odd';

  language: 'en' | 'es';
  levels: { org: boolean; repo: boolean; person: boolean };
  highlights: Record<HighlightId, boolean>;
  staleThresholdDays: number;
  reposInclude: string;
  reposExclude: string;
  excludeBots: boolean;
  peopleExclude: string;
  tone: 'professional-warm' | 'neutral' | 'playful';

  llm: LlmChoice;
  anthropicSecret: string;
  openaiSecret: string;

  slackEnabled: boolean;
  slackSecret: string;
  emailEnabled: boolean;
  resendSecret: string;
  emailTo: string;
  emailFrom: string;
}

export const DEFAULT_STATE: ConfiguratorState = {
  actionRef: 'ombustudio/weekly-report',
  actionVersion: 'v1',
  targetRepo: '',
  org: '',

  auth: 'pat',
  githubTokenSecret: inputDef('github-token').suggestedSecretName ?? 'ORG_REPORT_GITHUB_TOKEN',
  appIdVar: 'REPORT_APP_ID',
  appKeySecret: 'REPORT_APP_PRIVATE_KEY',

  cadence: 'weekly',
  dayOfWeek: 1,
  hour: 9,
  minute: 17,
  timezone: 'UTC',
  biweeklyAnchor: 'even',

  language: 'en',
  levels: { org: true, repo: true, person: true },
  highlights: Object.fromEntries(HIGHLIGHT_IDS.map((id) => [id, true])) as Record<HighlightId, boolean>,
  staleThresholdDays: 7,
  reposInclude: '',
  reposExclude: '',
  excludeBots: true,
  peopleExclude: '',
  tone: 'professional-warm',

  llm: 'anthropic',
  anthropicSecret: inputDef('anthropic-api-key').suggestedSecretName ?? 'ANTHROPIC_API_KEY',
  openaiSecret: inputDef('openai-api-key').suggestedSecretName ?? 'OPENAI_API_KEY',

  slackEnabled: true,
  slackSecret: inputDef('slack-webhook-url').suggestedSecretName ?? 'SLACK_WEBHOOK_URL',
  emailEnabled: false,
  resendSecret: inputDef('resend-api-key').suggestedSecretName ?? 'RESEND_API_KEY',
  emailTo: '',
  emailFrom: ''
};

export const state = signal<ConfiguratorState>({ ...DEFAULT_STATE });

export function update(patch: Partial<ConfiguratorState>): void {
  state.value = { ...state.value, ...patch };
}

/** All input keys the generator may emit — used by the drift test. */
export const KNOWN_INPUT_KEYS = new Set(INPUT_DEFS.map((d) => d.key));
