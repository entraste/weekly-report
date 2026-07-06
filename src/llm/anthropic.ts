/**
 * Anthropic Messages API adapter — raw fetch, no SDK (keeps the bundled
 * dist small; this layer makes exactly one call shape).
 *
 * Compatibility notes (verified against current API docs):
 *  - No `thinking` param is sent: omitting it is valid on every current model
 *    (runs adaptive on Sonnet 5 / Fable 5, off on Opus 4.x) — an explicit
 *    value would 400 on some models users may pass as `model`.
 *  - No sampling params (temperature/top_p): rejected on Opus 4.7+ / Sonnet 5.
 *  - Structured output via output_config.format (json_schema). Models without
 *    support return 400 → we retry once without it (prompt still demands JSON).
 */
import { LlmError } from './types.js';
import type { LlmAdapter, LlmCallRequest, LlmCallResult } from './types.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export function createAnthropicAdapter(apiKey: string, fetchImpl: typeof fetch = fetch): LlmAdapter {
  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  return {
    provider: 'anthropic',

    async call(request: LlmCallRequest): Promise<LlmCallResult> {
      const baseBody = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }]
      };

      let response = await post({
        ...baseBody,
        output_config: { format: { type: 'json_schema', schema: request.schema } }
      });

      // Models without structured-output support reject output_config with 400.
      if (response.status === 400) {
        const errorText = await response.text();
        if (/output_config|output_format|json_schema/i.test(errorText)) {
          response = await post(baseBody);
        } else {
          throw new LlmError(`Anthropic API 400: ${truncate(errorText)}`, 400);
        }
      }

      if (response.status === 401) {
        throw new LlmError('Anthropic rejected the API key (401). Check anthropic-api-key.', 401);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new LlmError(`Anthropic API ${response.status} (retryable).`, response.status, true);
      }
      if (!response.ok) {
        throw new LlmError(`Anthropic API ${response.status}: ${truncate(await response.text())}`, response.status);
      }

      const data = (await response.json()) as AnthropicResponse;
      if (data.stop_reason === 'refusal') {
        throw new LlmError('Anthropic refused the request (stop_reason=refusal).');
      }
      const text = data.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (!text) throw new LlmError('Anthropic returned an empty response.');
      if (data.stop_reason === 'max_tokens') {
        throw new LlmError('Anthropic response truncated (max_tokens) — narrative JSON incomplete.');
      }

      return {
        text,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens
      };
    }
  };
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
