/**
 * Config resolution: action inputs > .github/weekly-report.yml > defaults.
 *
 * "Input wins" means an input whose value differs from its action.yml default —
 * the runner always feeds defaults back to us, so a default-valued input is
 * treated as "not explicitly set" and the config file may override it.
 * (Documented in the README; same precedence model as release-drafter.)
 */
import { ActionError } from '../errors.js';
import {
  CONFIG_DEFAULTS,
  HIGHLIGHT_DEFAULTS,
  HIGHLIGHT_IDS,
  INPUT_DEFS,
  LANGUAGES,
  LLM_PROVIDERS,
  PERIODS,
  REPORT_LEVELS,
  isHighlightId
} from '../schema/index.js';
import type {
  ConfigFile,
  HighlightId,
  Language,
  LlmProvider,
  Period,
  ResolvedConfig,
  ResolvedHighlights
} from '../schema/index.js';
import { parseList } from '../util/globs.js';
import { assertValidTimezone } from '../util/time.js';

/** Injectable for tests; production passes @actions/core's getInput. */
export type GetInput = (name: string) => string;

interface RawInputs {
  /** raw value for every registered input key */
  values: Record<string, string>;
  /** true when the value differs from the action.yml default (explicitly set) */
  explicit: Record<string, boolean>;
}

export function readRawInputs(getInput: GetInput): RawInputs {
  const values: Record<string, string> = {};
  const explicit: Record<string, boolean> = {};
  for (const def of INPUT_DEFS) {
    const value = getInput(def.key).trim();
    values[def.key] = value;
    const defaultValue = def.default ?? '';
    // Expression defaults (e.g. ${{ github.repository_owner }}) resolve at runtime,
    // so any non-empty value counts as explicit for those.
    const hasExpressionDefault = defaultValue.includes('${{');
    explicit[def.key] = hasExpressionDefault ? value !== '' : value !== '' && value !== defaultValue;
  }
  return { values, explicit };
}

function pick<T>(inputValue: T | undefined, fileValue: T | undefined, defaultValue: T): T {
  if (inputValue !== undefined) return inputValue;
  if (fileValue !== undefined) return fileValue;
  return defaultValue;
}

function parseEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  inputName: string
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ActionError(
    'E_BAD_INPUT',
    `Invalid ${inputName}: "${value}". Allowed: ${allowed.join(' | ')}.`
  );
}

function resolveHighlights(
  inputRaw: string | undefined,
  file: ConfigFile['highlights']
): ResolvedHighlights {
  const resolved = structuredClone(HIGHLIGHT_DEFAULTS) as ResolvedHighlights;

  // Config file first (fine-grained: enabled flags + params).
  if (file) {
    for (const [id, entry] of Object.entries(file)) {
      if (entry === undefined || !isHighlightId(id)) continue;
      const target = resolved[id] as { enabled: boolean; params: Record<string, unknown> };
      if (typeof entry === 'boolean') {
        target.enabled = entry;
        continue;
      }
      if (entry.enabled !== undefined) target.enabled = entry.enabled;
      const paramMap: Record<string, keyof typeof entry> = {
        minAgeDays: 'min-age-days',
        ignoreDrafts: 'ignore-drafts',
        podium: 'podium',
        thresholdDays: 'threshold-days',
        maxListed: 'max-listed',
        excludeBots: 'exclude-bots',
        minMinutes: 'min-minutes'
      };
      for (const [camel, kebab] of Object.entries(paramMap)) {
        const value = entry[kebab];
        if (value !== undefined && camel in target.params) target.params[camel] = value;
      }
    }
  }

  // Input second (coarse: which ids are on), only when explicitly set.
  if (inputRaw !== undefined) {
    if (inputRaw === 'all') {
      for (const id of HIGHLIGHT_IDS) resolved[id].enabled = true;
    } else if (inputRaw === 'none') {
      for (const id of HIGHLIGHT_IDS) resolved[id].enabled = false;
    } else {
      const ids = parseList(inputRaw);
      const unknown = ids.filter((id) => !isHighlightId(id));
      if (unknown.length > 0) {
        throw new ActionError(
          'E_BAD_INPUT',
          `Unknown highlight id(s): ${unknown.join(', ')}.`,
          [`Valid ids: ${HIGHLIGHT_IDS.join(', ')}`]
        );
      }
      for (const id of HIGHLIGHT_IDS) resolved[id].enabled = ids.includes(id);
    }
  }

  return resolved;
}

export interface ResolveOptions {
  getInput: GetInput;
  /** Parsed + schema-validated config file, or undefined when absent. */
  configFile?: ConfigFile;
  /** From the workflow context: repository owner fallback for `org`. */
  repositoryOwner: string;
}

export function resolveConfig(opts: ResolveOptions): ResolvedConfig {
  const { values, explicit } = readRawInputs(opts.getInput);
  const file = opts.configFile ?? {};
  const d = CONFIG_DEFAULTS;

  const githubTokensRaw = parseList(values['github-token']);
  if (githubTokensRaw.length === 0) {
    throw new ActionError('E_BAD_INPUT', 'github-token is required.', [
      'For org-wide reports use an org fine-grained PAT or a GitHub App token — the default GITHUB_TOKEN only sees this repository.'
    ]);
  }

  const orgs = parseList(values['org'] || opts.repositoryOwner);
  if (orgs.length === 0) throw new ActionError('E_BAD_INPUT', 'Could not determine the organization to report on.');
  // Token↔org alignment: 1 token for all orgs, or exactly one per org.
  let githubTokens: string[];
  if (githubTokensRaw.length === 1) {
    githubTokens = orgs.map(() => githubTokensRaw[0]!);
  } else if (githubTokensRaw.length === orgs.length) {
    githubTokens = githubTokensRaw;
  } else {
    throw new ActionError(
      'E_BAD_INPUT',
      `github-token has ${githubTokensRaw.length} tokens but org lists ${orgs.length} organizations.`,
      ['Pass ONE token that can read every org, or exactly one token per org in the same order.']
    );
  }
  const org = orgs.join(' + ');

  const language = parseEnum<Language>(
    pick(explicit['language'] ? values['language'] : undefined, file.language, d.language),
    LANGUAGES,
    'language'
  );

  let period = parseEnum<Period>(
    pick(explicit['period'] ? values['period'] : undefined, file.period, d.period),
    PERIODS,
    'period'
  );

  const timezone = pick(explicit['timezone'] ? values['timezone'] : undefined, file.timezone, d.timezone);
  assertValidTimezone(timezone);

  const startDate = values['start-date'] || file['start-date'] || undefined;
  const endDate = values['end-date'] || file['end-date'] || undefined;
  // Explicit dates win: supplying BOTH switches the window to that custom
  // range — this is what makes workflow_dispatch date inputs work without
  // also having to flip `period`.
  if (startDate && endDate) period = 'custom';
  if (period === 'custom' && (!startDate || !endDate)) {
    throw new ActionError('E_CUSTOM_DATES', 'period=custom requires both start-date and end-date.', [
      'Wire them to workflow_dispatch inputs for on-demand reports.'
    ]);
  }

  // --- Report levels ---
  const levelsRaw = explicit['report-levels'] ? parseList(values['report-levels']) : undefined;
  let levels = { ...pick(undefined, file.levels && {
    org: file.levels.org ?? d.levels.org,
    repo: file.levels.repo ?? d.levels.repo,
    person: file.levels.person ?? d.levels.person
  }, d.levels) };
  if (levelsRaw) {
    const unknown = levelsRaw.filter((l) => !(REPORT_LEVELS as readonly string[]).includes(l));
    if (unknown.length > 0) {
      throw new ActionError('E_BAD_INPUT', `Unknown report level(s): ${unknown.join(', ')}.`, [
        `Valid levels: ${REPORT_LEVELS.join(', ')}`
      ]);
    }
    levels = {
      org: levelsRaw.includes('org'),
      repo: levelsRaw.includes('repo'),
      person: levelsRaw.includes('person')
    };
  }
  if (!levels.org && !levels.repo && !levels.person) {
    throw new ActionError('E_BAD_INPUT', 'At least one report level must be enabled.');
  }

  // --- LLM ---
  const anthropicApiKey = values['anthropic-api-key'] || undefined;
  const openaiApiKey = values['openai-api-key'] || undefined;
  let provider = parseEnum<LlmProvider>(
    pick(explicit['llm-provider'] ? values['llm-provider'] : undefined, file.llm?.provider, d.llm.provider),
    LLM_PROVIDERS,
    'llm-provider'
  );
  if (provider === 'anthropic' && !anthropicApiKey) {
    throw new ActionError('E_LLM_CONFIG', 'llm-provider=anthropic but anthropic-api-key is not set.');
  }
  if (provider === 'openai' && !openaiApiKey) {
    throw new ActionError('E_LLM_CONFIG', 'llm-provider=openai but openai-api-key is not set.');
  }
  if (provider === 'auto') {
    provider = anthropicApiKey ? 'anthropic' : openaiApiKey ? 'openai' : 'none';
  }

  // --- Email ---
  const resendApiKey = values['resend-api-key'] || undefined;
  const emailTo = explicit['email-to'] ? parseList(values['email-to']) : (file.email?.to ?? d.email.to);
  const emailFrom = pick(explicit['email-from'] ? values['email-from'] : undefined, file.email?.from, d.email.from);
  if (resendApiKey) {
    if (emailTo.length === 0 || !emailFrom) {
      throw new ActionError('E_EMAIL_CONFIG', 'resend-api-key is set but email-to and/or email-from are missing.', [
        "email-from must be a Resend-verified sender, e.g. 'Reports <reports@yourdomain.com>'.",
        'Use onboarding@resend.dev while testing, before verifying your domain.'
      ]);
    }
    const bareEmail = /<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$|^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
    if (!bareEmail.test(emailFrom.trim())) {
      throw new ActionError('E_EMAIL_CONFIG', `email-from "${emailFrom}" is not a valid address.`, [
        "Accepted forms: reports@yourdomain.com or 'Reports <reports@yourdomain.com>'."
      ]);
    }
    for (const to of emailTo) {
      if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(to)) {
        throw new ActionError('E_EMAIL_CONFIG', `Invalid recipient address: "${to}".`);
      }
    }
  }

  return {
    org,
    orgs,
    githubToken: githubTokens[0]!,
    githubTokens,
    timezone,
    language,
    period,
    startDate,
    endDate,
    biweeklyAnchor: file['biweekly-anchor'] ?? d.biweeklyAnchor,

    repos: {
      include: explicit['repos-include']
        ? parseList(values['repos-include'])
        : (file.repos?.include ?? d.repos.include),
      exclude: explicit['repos-exclude']
        ? parseList(values['repos-exclude'])
        : (file.repos?.exclude ?? d.repos.exclude),
      skipArchived: file.repos?.['skip-archived'] ?? d.repos.skipArchived,
      skipForks: file.repos?.['skip-forks'] ?? d.repos.skipForks
    },

    levels,

    highlights: resolveHighlights(explicit['highlights'] ? values['highlights'] : undefined, file.highlights),

    people: {
      exclude: file.people?.exclude ?? d.people.exclude,
      excludeBots: file.people?.['exclude-bots'] ?? d.people.excludeBots,
      botPatterns: file.people?.['bot-patterns'] ?? d.people.botPatterns,
      maxListed: file.people?.['max-listed'] ?? d.people.maxListed
    },

    report: {
      title: file.report?.title ?? d.report.title,
      reposMax: file.report?.['repos-max'] ?? d.report.reposMax,
      narratedRepos: file.report?.['narrated-repos'] ?? d.report.narratedRepos,
      listMergedPrs: file.report?.['list-merged-prs'] ?? d.report.listMergedPrs,
      mergedPrsPerRepo: file.report?.['merged-prs-per-repo'] ?? d.report.mergedPrsPerRepo
    },

    llm: {
      provider,
      anthropicApiKey,
      openaiApiKey,
      model: pick(explicit['model'] ? values['model'] : undefined, file.llm?.model, d.llm.model),
      maxInputTokens: file.llm?.['max-input-tokens'] ?? d.llm.maxInputTokens,
      maxOutputTokens: file.llm?.['max-output-tokens'] ?? d.llm.maxOutputTokens,
      titlesPerRepo: file.llm?.['titles-per-repo'] ?? d.llm.titlesPerRepo,
      tone: file.llm?.tone ?? d.llm.tone,
      customInstructions: file.llm?.['custom-instructions'] ?? d.llm.customInstructions
    },

    slack: {
      webhookUrl: values['slack-webhook-url'] || undefined,
      topHighlights: file.slack?.['top-highlights'] ?? d.slack.topHighlights,
      reportUrl: file.slack?.['report-url'] ?? d.slack.reportUrl
    },

    email: {
      resendApiKey,
      to: emailTo,
      from: emailFrom,
      replyTo: file.email?.['reply-to'] ?? d.email.replyTo,
      subject: pick(
        explicit['email-subject'] ? values['email-subject'] : undefined,
        file.email?.subject,
        d.email.subject
      )
    },

    limits: {
      maxRepos: file.limits?.['max-repos'] ?? d.limits.maxRepos,
      maxPrs: file.limits?.['max-prs'] ?? d.limits.maxPrs
    },

    output: {
      jobSummary: file.output?.['job-summary'] ?? d.output.jobSummary,
      artifact: file.output?.artifact ?? d.output.artifact,
      artifactName: file.output?.['artifact-name'] ?? d.output.artifactName
    },

    dryRun: values['dry-run'] === 'true',
    configFile: values['config-file'] || '.github/weekly-report.yml'
  };
}

/** Convenience: which highlight ids are enabled after resolution. */
export function enabledHighlights(config: ResolvedConfig): HighlightId[] {
  return HIGHLIGHT_IDS.filter((id) => config.highlights[id].enabled);
}
