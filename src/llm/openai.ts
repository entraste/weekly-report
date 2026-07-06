/**
 * OpenAI Chat Completions adapter — raw fetch, no SDK.
 *
 * Compatibility notes:
 *  - max_completion_tokens (not max_tokens): required by gpt-5/o-series,
 *    accepted by gpt-4o family.
 *  - No temperature: gpt-5 family rejects non-default sampling params.
 *  - Structured output via response_format json_schema (strict). Models
 *    without support return 400 → retry once without it.
 */
import { LlmError } from './types.js';
import type { LlmAdapter, LlmCallRequest, LlmCallResult } from './types.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAiResponse {
  choices: Array<{
    message: { content: string | null; refusal?: string | null };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export function createOpenAiAdapter(apiKey: string, fetchImpl: typeof fetch = fetch): LlmAdapter {
  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  return {
    provider: 'openai',

    async call(request: LlmCallRequest): Promise<LlmCallResult> {
      const baseBody = {
        model: request.model,
        max_completion_tokens: request.maxOutputTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user }
        ]
      };

      let response = await post({
        ...baseBody,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'narrative', strict: true, schema: request.schema }
        }
      });

      if (response.status === 400) {
        const errorText = await response.text();
        if (/response_format|json_schema/i.test(errorText)) {
          response = await post(baseBody);
        } else {
          throw new LlmError(`OpenAI API 400: ${truncate(errorText)}`, 400);
        }
      }

      if (response.status === 401) {
        throw new LlmError('OpenAI rejected the API key (401). Check openai-api-key.', 401);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new LlmError(`OpenAI API ${response.status} (retryable).`, response.status, true);
      }
      if (!response.ok) {
        throw new LlmError(`OpenAI API ${response.status}: ${truncate(await response.text())}`, response.status);
      }

      const data = (await response.json()) as OpenAiResponse;
      const choice = data.choices[0];
      if (!choice) throw new LlmError('OpenAI returned no choices.');
      if (choice.message.refusal) {
        throw new LlmError(`OpenAI refused the request: ${truncate(choice.message.refusal)}`);
      }
      if (choice.finish_reason === 'length') {
        throw new LlmError('OpenAI response truncated (length) — narrative JSON incomplete.');
      }
      if (!choice.message.content) throw new LlmError('OpenAI returned an empty response.');

      return {
        text: choice.message.content,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens
      };
    }
  };
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
