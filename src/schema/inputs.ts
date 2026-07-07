/**
 * Canonical registry of every action input — the single source of truth.
 *
 * Consumed by:
 *  - src/config/resolve.ts  (runtime input parsing)
 *  - __tests__/action-yml-drift.test.ts  (asserts action.yml matches this registry)
 *  - web/ configurator  (renders the form and generates `with:` blocks)
 *
 * action.yml is hand-written; the drift test keeps it honest.
 */

export type InputGroup =
  | 'auth'
  | 'llm'
  | 'shape'
  | 'period'
  | 'repos'
  | 'delivery'
  | 'misc';

export interface InputDef {
  /** kebab-case id exactly as it appears in action.yml and `with:` */
  key: string;
  description: string;
  required: boolean;
  /** Literal default string as written in action.yml (may be a ${{ }} expression). */
  default?: string;
  /** Secrets travel ONLY through inputs, never through the config file. */
  secret: boolean;
  /** Suggested repo-secret name shown by docs and the configurator. */
  suggestedSecretName?: string;
  group: InputGroup;
}

export const INPUT_DEFS: readonly InputDef[] = [
  // --- Auth / scope ---
  {
    key: 'github-token',
    description:
      'Token with org-wide read access. The default GITHUB_TOKEN only sees the current repo — ' +
      'for org-wide reports pass an org fine-grained PAT (All repositories: Metadata, Pull requests, ' +
      'Issues, Contents — read-only) or a GitHub App token from actions/create-github-app-token.',
    required: true,
    secret: true,
    suggestedSecretName: 'ORG_REPORT_GITHUB_TOKEN',
    group: 'auth'
  },
  {
    key: 'org',
    description:
      'Organization login to report on. Defaults to the owner of the repository running the workflow.',
    required: false,
    default: '${{ github.repository_owner }}',
    secret: false,
    group: 'auth'
  },

  // --- LLM ---
  {
    key: 'anthropic-api-key',
    description:
      'Anthropic API key. Provide this OR openai-api-key. With neither, the report is metrics-only (with a warning).',
    required: false,
    secret: true,
    suggestedSecretName: 'ANTHROPIC_API_KEY',
    group: 'llm'
  },
  {
    key: 'openai-api-key',
    description: 'OpenAI API key. Provide this OR anthropic-api-key.',
    required: false,
    secret: true,
    suggestedSecretName: 'OPENAI_API_KEY',
    group: 'llm'
  },
  {
    key: 'llm-provider',
    description:
      "auto | anthropic | openai | none. 'auto' picks whichever key is present (Anthropic wins ties). 'none' forces metrics-only.",
    required: false,
    default: 'auto',
    secret: false,
    group: 'llm'
  },
  {
    key: 'model',
    description:
      'Model override for the selected provider. Defaults: claude-sonnet-5 (Anthropic), gpt-5-mini (OpenAI).',
    required: false,
    secret: false,
    group: 'llm'
  },

  // --- Report shape ---
  {
    key: 'language',
    description: 'Report language: en | es',
    required: false,
    default: 'en',
    secret: false,
    group: 'shape'
  },
  {
    key: 'report-levels',
    description: 'Comma-separated cuts to include: org, repo, person. Default: all three.',
    required: false,
    default: 'org,repo,person',
    secret: false,
    group: 'shape'
  },
  {
    key: 'highlights',
    description:
      "'all', 'none', or comma-separated highlight ids: oldest-open-pr, top-merger, top-reviewer, " +
      'stale-prs, biggest-pr, fastest-review, first-time-contributors, most-active-repo. ' +
      'Thresholds tunable in the config file.',
    required: false,
    default: 'all',
    secret: false,
    group: 'shape'
  },

  // --- Period ---
  {
    key: 'period',
    description:
      'daily | weekly | biweekly | monthly | custom. The reporting window is the previous COMPLETE ' +
      'calendar period in `timezone` — never inferred from the cron.',
    required: false,
    default: 'weekly',
    secret: false,
    group: 'period'
  },
  {
    key: 'start-date',
    description:
      'ISO date (YYYY-MM-DD), interpreted in `timezone`. Providing BOTH start-date and end-date switches the window to that custom range (period becomes custom).',
    required: false,
    secret: false,
    group: 'period'
  },
  {
    key: 'end-date',
    description: 'ISO date (YYYY-MM-DD), inclusive. See start-date.',
    required: false,
    secret: false,
    group: 'period'
  },
  {
    key: 'timezone',
    description: 'IANA timezone for window boundaries and displayed dates.',
    required: false,
    default: 'UTC',
    secret: false,
    group: 'period'
  },

  // --- Repo selection ---
  {
    key: 'repos-include',
    description: "Comma/newline-separated repo name globs (e.g. 'api-*, web'). Default: all org repos.",
    required: false,
    default: '*',
    secret: false,
    group: 'repos'
  },
  {
    key: 'repos-exclude',
    description: "Comma/newline-separated repo name globs to exclude (e.g. '*-archive, sandbox-*').",
    required: false,
    default: '',
    secret: false,
    group: 'repos'
  },

  // --- Delivery ---
  {
    key: 'slack-webhook-url',
    description:
      'Slack incoming webhook URL. Receives a condensed Block Kit summary linking to the full report.',
    required: false,
    secret: true,
    suggestedSecretName: 'SLACK_WEBHOOK_URL',
    group: 'delivery'
  },
  {
    key: 'resend-api-key',
    description: 'Resend API key for email delivery of the full HTML report.',
    required: false,
    secret: true,
    suggestedSecretName: 'RESEND_API_KEY',
    group: 'delivery'
  },
  {
    key: 'email-to',
    description: 'Comma-separated recipient addresses (required if resend-api-key is set).',
    required: false,
    secret: false,
    group: 'delivery'
  },
  {
    key: 'email-from',
    description:
      "Verified sender, e.g. 'Reports <reports@yourdomain.com>' (required if resend-api-key is set).",
    required: false,
    secret: false,
    group: 'delivery'
  },
  {
    key: 'email-subject',
    description: 'Subject template. Placeholders: {org} {start} {end} {period-label}.',
    required: false,
    default: '{org} engineering report — {period-label}',
    secret: false,
    group: 'delivery'
  },

  // --- Misc ---
  {
    key: 'config-file',
    description:
      'Path (in this repo) of the optional rich config file, fetched via the Contents API at runtime — no checkout needed.',
    required: false,
    default: '.github/weekly-report.yml',
    secret: false,
    group: 'misc'
  },
  {
    key: 'dry-run',
    description:
      'Collect, aggregate and render, write job summary + artifact, but skip Slack/email delivery AND the LLM call.',
    required: false,
    default: 'false',
    secret: false,
    group: 'misc'
  }
] as const;

export interface OutputDef {
  key: string;
  description: string;
}

export const OUTPUT_DEFS: readonly OutputDef[] = [
  { key: 'report-markdown-path', description: 'Absolute path of the rendered markdown report file.' },
  { key: 'report-html-path', description: 'Absolute path of the rendered HTML report file.' },
  { key: 'metrics-json-path', description: 'Absolute path of the raw metrics JSON (for downstream steps).' },
  {
    key: 'delivery-status',
    description: 'JSON per channel, e.g. {"slack":"ok","email":"failed","summary":"ok","artifact":"ok"}'
  },
  {
    key: 'llm-usage',
    description:
      'JSON: {"provider":"anthropic","model":"claude-sonnet-5","inputTokens":6200,"outputTokens":1400,"estimatedCostUsd":0.04}'
  }
] as const;

export function inputDef(key: string): InputDef {
  const def = INPUT_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown input key: ${key}`);
  return def;
}
