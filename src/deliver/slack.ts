/**
 * Slack incoming-webhook delivery. One retry on 429/5xx; on a 4xx (usually a
 * blocks-validation problem) falls back to a minimal text-only payload so the
 * team still gets notified.
 */
import type { SlackPayload } from '../render/slack.js';

export interface DeliveryResult {
  ok: boolean;
  detail: string;
}

async function post(webhookUrl: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function deliverToSlack(
  webhookUrl: string,
  payload: SlackPayload,
  fetchImpl: typeof fetch = fetch
): Promise<DeliveryResult> {
  try {
    let response = await post(webhookUrl, payload, fetchImpl);

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 2);
      await sleep(Math.min(retryAfter, 10) * 1000);
      response = await post(webhookUrl, payload, fetchImpl);
    }

    if (response.ok) return { ok: true, detail: 'ok' };

    // Blocks rejected → minimal fallback so the notification still lands.
    if (response.status >= 400 && response.status < 500) {
      const fallback = await post(webhookUrl, { text: `${payload.text} — blocks fallback` }, fetchImpl);
      if (fallback.ok) return { ok: true, detail: `ok (minimal fallback after ${response.status})` };
      return { ok: false, detail: `Slack webhook ${response.status}; fallback also failed (${fallback.status})` };
    }

    return { ok: false, detail: `Slack webhook ${response.status}` };
  } catch (error) {
    return { ok: false, detail: `Slack delivery error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
