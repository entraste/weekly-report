/**
 * Zod schema for the optional rich config file: `.github/weekly-report.yml`.
 *
 * Keys are kebab-case (release-drafter convention). Everything is optional —
 * precedence is: action inputs > config file > built-in defaults.
 *
 * SECURITY: secrets travel ONLY through action inputs. Any config-file key
 * matching SECRET_KEY_PATTERN is rejected with a warning and ignored.
 */
import { z } from 'zod';
import { HIGHLIGHT_IDS } from './highlights.js';

/** Config-file keys that look like secrets are refused (warn + ignore). */
export const SECRET_KEY_PATTERN = /key|webhook|token|secret|password/i;

export const LANGUAGES = ['en', 'es'] as const;
export const PERIODS = ['daily', 'weekly', 'biweekly', 'monthly', 'custom'] as const;
export const LLM_PROVIDERS = ['auto', 'anthropic', 'openai', 'none'] as const;
export const TONES = ['professional-warm', 'neutral', 'playful'] as const;
export const REPORT_LEVELS = ['org', 'repo', 'person'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Highlight entry: boolean shorthand or an object with `enabled` + params. */
const highlightEntry = z.union([
  z.boolean(),
  z
    .object({
      enabled: z.boolean().optional(),
      'min-age-days': z.number().int().positive().optional(),
      'ignore-drafts': z.boolean().optional(),
      podium: z.number().int().min(1).max(3).optional(),
      'threshold-days': z.number().int().positive().optional(),
      'max-listed': z.number().int().positive().optional(),
      'exclude-bots': z.boolean().optional(),
      'min-minutes': z.number().int().nonnegative().optional()
    })
    .strict()
]);

export const configFileSchema = z
  .object({
    timezone: z.string().optional(),
    language: z.enum(LANGUAGES).optional(),
    period: z.enum(PERIODS).optional(),
    'start-date': isoDate.optional(),
    'end-date': isoDate.optional(),
    'biweekly-anchor': z.enum(['even', 'odd']).optional(),

    repos: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        'skip-archived': z.boolean().optional(),
        'skip-forks': z.boolean().optional()
      })
      .strict()
      .optional(),

    levels: z
      .object({
        org: z.boolean().optional(),
        repo: z.boolean().optional(),
        person: z.boolean().optional()
      })
      .strict()
      .optional(),

    highlights: z
      .object(Object.fromEntries(HIGHLIGHT_IDS.map((id) => [id, highlightEntry.optional()])))
      .strict()
      .optional(),

    people: z
      .object({
        exclude: z.array(z.string()).optional(),
        'exclude-bots': z.boolean().optional(),
        'bot-patterns': z.array(z.string()).optional(),
        'max-listed': z.number().int().positive().optional()
      })
      .strict()
      .optional(),

    report: z
      .object({
        title: z.string().optional(),
        'repos-max': z.number().int().positive().optional(),
        'narrated-repos': z.number().int().nonnegative().optional(),
        'list-merged-prs': z.boolean().optional(),
        'merged-prs-per-repo': z.number().int().positive().optional()
      })
      .strict()
      .optional(),

    llm: z
      .object({
        provider: z.enum(LLM_PROVIDERS).optional(),
        model: z.string().optional(),
        'max-input-tokens': z.number().int().positive().optional(),
        'max-output-tokens': z.number().int().positive().optional(),
        'titles-per-repo': z.number().int().nonnegative().optional(),
        tone: z.enum(TONES).optional(),
        'custom-instructions': z.string().max(2000).optional()
      })
      .strict()
      .optional(),

    slack: z
      .object({
        'top-highlights': z.number().int().min(0).max(8).optional(),
        'report-url': z.string().optional()
      })
      .strict()
      .optional(),

    email: z
      .object({
        to: z.array(z.string()).optional(),
        from: z.string().optional(),
        'reply-to': z.string().optional(),
        subject: z.string().optional()
      })
      .strict()
      .optional(),

    limits: z
      .object({
        'max-repos': z.number().int().positive().optional(),
        'max-prs': z.number().int().positive().optional()
      })
      .strict()
      .optional(),

    output: z
      .object({
        'job-summary': z.boolean().optional(),
        artifact: z.boolean().optional(),
        'artifact-name': z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
