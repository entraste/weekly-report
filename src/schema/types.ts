/**
 * ResolvedConfig — the fully-merged, camelCase configuration every pipeline
 * stage consumes. Built by src/config/resolve.ts from:
 *   action inputs  >  .github/weekly-report.yml  >  built-in defaults.
 */
import type { HighlightId, HighlightParams } from './highlights.js';
import type { LANGUAGES, LLM_PROVIDERS, PERIODS, TONES } from './config-file.js';

export type Language = (typeof LANGUAGES)[number];
export type Period = (typeof PERIODS)[number];
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type Tone = (typeof TONES)[number];

export type ResolvedHighlights = {
  [K in HighlightId]: { enabled: boolean; params: HighlightParams[K] };
};

export interface ResolvedConfig {
  /** Display label — single org login, or "orgA + orgB" for consolidated reports. */
  org: string;
  /** All orgs in the report (≥1). */
  orgs: string[];
  /** First token — used for repo-local calls (config file fetch). */
  githubToken: string;
  /** One per org (same token repeated when a single token was provided). */
  githubTokens: string[];
  timezone: string;
  language: Language;
  period: Period;
  /** YYYY-MM-DD, only when period=custom */
  startDate?: string;
  /** YYYY-MM-DD inclusive, only when period=custom */
  endDate?: string;
  biweeklyAnchor: 'even' | 'odd';

  repos: {
    include: string[];
    exclude: string[];
    skipArchived: boolean;
    skipForks: boolean;
  };

  levels: { org: boolean; repo: boolean; person: boolean };

  highlights: ResolvedHighlights;

  people: {
    exclude: string[];
    excludeBots: boolean;
    botPatterns: string[];
    maxListed: number;
  };

  report: {
    /** Placeholders: {org} {period-label} */
    title: string;
    reposMax: number;
    narratedRepos: number;
    /** Detailed per-repo merged-PR list in the full report (client-ready detail). */
    listMergedPrs: boolean;
    mergedPrsPerRepo: number;
  };

  llm: {
    provider: LlmProvider;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    /** empty string = provider default model */
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    titlesPerRepo: number;
    tone: Tone;
    customInstructions: string;
  };

  slack: {
    webhookUrl?: string;
    topHighlights: number;
    /** override link target; empty = workflow run URL */
    reportUrl: string;
  };

  email: {
    resendApiKey?: string;
    to: string[];
    from: string;
    replyTo: string;
    /** Placeholders: {org} {start} {end} {period-label} */
    subject: string;
  };

  limits: { maxRepos: number; maxPrs: number };

  output: { jobSummary: boolean; artifact: boolean; artifactName: string };

  dryRun: boolean;
  configFile: string;
}

/** Built-in defaults for everything not supplied via inputs or config file. */
export interface ConfigDefaults {
  timezone: string;
  language: Language;
  period: Period;
  biweeklyAnchor: 'even' | 'odd';
  repos: ResolvedConfig['repos'];
  levels: ResolvedConfig['levels'];
  people: ResolvedConfig['people'];
  report: ResolvedConfig['report'];
  llm: Omit<ResolvedConfig['llm'], 'anthropicApiKey' | 'openaiApiKey'>;
  slack: Omit<ResolvedConfig['slack'], 'webhookUrl'>;
  email: Omit<ResolvedConfig['email'], 'resendApiKey'>;
  limits: ResolvedConfig['limits'];
  output: ResolvedConfig['output'];
}

export const CONFIG_DEFAULTS: ConfigDefaults = {
  timezone: 'UTC',
  language: 'en',
  period: 'weekly',
  biweeklyAnchor: 'even',
  repos: { include: ['*'], exclude: [], skipArchived: true, skipForks: true },
  levels: { org: true, repo: true, person: true },
  people: {
    exclude: [],
    excludeBots: true,
    botPatterns: ['*[bot]', 'dependabot*', 'renovate*'],
    maxListed: 20
  },
  report: {
    title: '{org} Engineering Report — {period-label}',
    reposMax: 25,
    narratedRepos: 5,
    listMergedPrs: true,
    mergedPrsPerRepo: 20
  },
  llm: {
    provider: 'auto',
    model: '',
    maxInputTokens: 16000,
    maxOutputTokens: 2000,
    titlesPerRepo: 10,
    tone: 'professional-warm',
    customInstructions: ''
  },
  slack: { topHighlights: 3, reportUrl: '' },
  email: { to: [], from: '', replyTo: '', subject: '{org} engineering report — {period-label}' },
  limits: { maxRepos: 200, maxPrs: 1000 },
  // {org} resolves at runtime — keeps artifact names unique in multi-org matrix runs
  output: { jobSummary: true, artifact: true, artifactName: 'weekly-report-{org}' }
};

/**
 * Default models per provider, pinned at implementation time.
 * claude-sonnet-5: native structured outputs (output_config.format) + near-Opus
 * quality at Sonnet cost. gpt-5-mini: cheap, supports strict json_schema.
 */
export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5-mini'
} as const;
