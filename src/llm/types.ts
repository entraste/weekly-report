/**
 * LLM layer contract. The LLM writes narrative ONLY — every number in the
 * report is computed deterministically and the model is explicitly told to
 * never restate figures it wasn't given.
 */
import type { Narrative } from '../metrics/types.js';

export interface LlmCallRequest {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** JSON schema the response must conform to. */
  schema: Record<string, unknown>;
}

export interface LlmCallResult {
  /** Raw text the model returned (expected: JSON conforming to schema). */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmAdapter {
  readonly provider: 'anthropic' | 'openai';
  /**
   * One narrative-generation call. Implementations must:
   *  - try native structured output first,
   *  - on a 400 clearly caused by the structured-output parameter, retry once
   *    WITHOUT it (the prompt also demands JSON, so parsing still works),
   *  - throw LlmError on anything else.
   */
  call(request: LlmCallRequest): Promise<LlmCallResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** JSON schema for the narrative — shared by both providers. */
export const NARRATIVE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_summary', 'repo_notes', 'team_note'],
  properties: {
    executive_summary: {
      type: 'string',
      description: '2-4 sentence executive narrative of the period, in the requested language.'
    },
    repo_notes: {
      type: 'array',
      description: 'One short note per narrated repository, same order as provided.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'note'],
        properties: {
          repo: { type: 'string' },
          note: { type: 'string' }
        }
      }
    },
    team_note: {
      type: 'string',
      description: 'One collective, celebratory sentence about the team. Never single anyone out negatively.'
    }
  }
};

export interface NarrativeOutcome {
  narrative: Narrative | null;
  status: 'ok' | 'failed';
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Diagnostic messages for the run log. */
  notes: string[];
}
