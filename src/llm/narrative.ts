/**
 * Narrative orchestration: pick adapter → call → validate + tripwires →
 * one retry → graceful no-LLM fallback. A failed LLM call NEVER fails the
 * action — the deterministic report ships regardless.
 */
import type { CollectedData } from '../github/types.js';
import type { AggregatedMetrics } from '../metrics/aggregate.js';
import type { HighlightData, LlmUsage, Narrative } from '../metrics/types.js';
import { DEFAULT_MODELS } from '../schema/index.js';
import type { ResolvedConfig } from '../schema/index.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAiAdapter } from './openai.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { NARRATIVE_SCHEMA } from './types.js';
import type { LlmAdapter, NarrativeOutcome } from './types.js';

/** USD per 1M tokens [input, output] — estimates for the cost line only. */
const PRICING: Record<string, [number, number]> = {
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-haiku-4-5': [1, 5],
  'gpt-5-mini': [0.25, 2],
  'gpt-5': [1.25, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'gpt-4.1-mini': [0.4, 1.6]
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

export function resolveModel(config: ResolvedConfig): string {
  if (config.llm.model) return config.llm.model;
  return config.llm.provider === 'openai' ? DEFAULT_MODELS.openai : DEFAULT_MODELS.anthropic;
}

function createAdapter(config: ResolvedConfig, fetchImpl?: typeof fetch): LlmAdapter | null {
  if (config.llm.provider === 'anthropic' && config.llm.anthropicApiKey) {
    return createAnthropicAdapter(config.llm.anthropicApiKey, fetchImpl);
  }
  if (config.llm.provider === 'openai' && config.llm.openaiApiKey) {
    return createOpenAiAdapter(config.llm.openaiApiKey, fetchImpl);
  }
  return null;
}

/** Extract the first JSON object from a possibly fenced/prefixed response. */
export function parseNarrativeJson(text: string): Narrative | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.executive_summary !== 'string' || typeof obj.team_note !== 'string') return null;
  if (!Array.isArray(obj.repo_notes)) return null;
  const repoNotes: Array<{ repo: string; note: string }> = [];
  for (const entry of obj.repo_notes) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).repo === 'string' &&
      typeof (entry as Record<string, unknown>).note === 'string'
    ) {
      repoNotes.push({ repo: (entry as { repo: string }).repo, note: (entry as { note: string }).note });
    }
  }
  return { executiveSummary: obj.executive_summary, repoNotes, teamNote: obj.team_note };
}

/**
 * Output tripwires: reject narratives that contain URLs or @mentions of
 * logins outside the known contributor set — the fingerprints of a prompt
 * injection that slipped through.
 */
export function tripwire(narrative: Narrative, knownLogins: Set<string>, knownRepos: Set<string>): string | null {
  const allText = [
    narrative.executiveSummary,
    narrative.teamNote,
    ...narrative.repoNotes.map((n) => `${n.repo} ${n.note}`)
  ].join('\n');

  if (/https?:\/\//i.test(allText)) return 'narrative contains a URL';

  const mentions = allText.match(/@([A-Za-z0-9-]+)/g) ?? [];
  for (const mention of mentions) {
    const login = mention.slice(1).toLowerCase();
    if (![...knownLogins].some((l) => l.toLowerCase() === login)) {
      return `narrative mentions unknown user ${mention}`;
    }
  }

  for (const note of narrative.repoNotes) {
    if (![...knownRepos].some((r) => r.toLowerCase() === note.repo.toLowerCase())) {
      return `repo_notes references unknown repo "${note.repo}"`;
    }
  }
  return null;
}

export interface GenerateNarrativeOptions {
  data: CollectedData;
  metrics: AggregatedMetrics;
  highlights: HighlightData[];
  config: ResolvedConfig;
  fetchImpl?: typeof fetch;
}

export async function generateNarrative(opts: GenerateNarrativeOptions): Promise<NarrativeOutcome & { llmUsage: LlmUsage | null }> {
  const { config } = opts;
  const notes: string[] = [];
  const adapter = createAdapter(config, opts.fetchImpl);
  if (!adapter) {
    return { narrative: null, status: 'failed', usage: null, notes: ['No LLM adapter available.'], llmUsage: null };
  }

  const model = resolveModel(config);
  const system = buildSystemPrompt(config);
  const { prompt, truncationNotes } = buildUserPrompt(opts.data, opts.metrics, opts.highlights, config);
  notes.push(...truncationNotes);

  const knownLogins = new Set(opts.metrics.byPerson.map((p) => p.login));
  const knownRepos = new Set(opts.data.repos.map((r) => r.name));

  let totalInput = 0;
  let totalOutput = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await adapter.call({
        model,
        system,
        user: prompt,
        maxOutputTokens: config.llm.maxOutputTokens,
        schema: NARRATIVE_SCHEMA
      });
      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;

      const narrative = parseNarrativeJson(result.text);
      if (!narrative) {
        notes.push(`Attempt ${attempt}: response was not valid narrative JSON.`);
        continue;
      }
      const tripped = tripwire(narrative, knownLogins, knownRepos);
      if (tripped) {
        notes.push(`Attempt ${attempt}: tripwire rejected the narrative (${tripped}).`);
        continue;
      }

      const llmUsage: LlmUsage = {
        provider: adapter.provider,
        model,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        estimatedCostUsd: estimateCostUsd(model, totalInput, totalOutput)
      };
      return { narrative, status: 'ok', usage: { inputTokens: totalInput, outputTokens: totalOutput }, notes, llmUsage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Attempt ${attempt}: ${message}`);
      // 401 will not fix itself on retry.
      if (message.includes('401')) break;
    }
  }

  const llmUsage: LlmUsage | null =
    totalInput + totalOutput > 0
      ? {
          provider: adapter.provider,
          model,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          estimatedCostUsd: estimateCostUsd(model, totalInput, totalOutput)
        }
      : null;
  return { narrative: null, status: 'failed', usage: null, notes, llmUsage };
}
