/**
 * Email delivery via the Resend API (raw fetch — one endpoint, no SDK).
 * Recipients are batched ≤50 per call (Resend's per-request cap).
 */
import type { DeliveryResult } from './slack.js';

const API_URL = 'https://api.resend.com/emails';
const BATCH_SIZE = 50;

export interface EmailMessage {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export async function deliverEmail(
  apiKey: string,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch
): Promise<DeliveryResult> {
  const batches: string[][] = [];
  for (let i = 0; i < message.to.length; i += BATCH_SIZE) {
    batches.push(message.to.slice(i, i + BATCH_SIZE));
  }

  const failures: string[] = [];
  for (const batch of batches) {
    try {
      let response = await send(apiKey, { ...message, to: batch }, fetchImpl);
      if (response.status === 429 || response.status >= 500) {
        await sleep(2000);
        response = await send(apiKey, { ...message, to: batch }, fetchImpl);
      }
      if (!response.ok) {
        const body = await response.text();
        failures.push(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length === 0) {
    return { ok: true, detail: `ok (${message.to.length} recipient${message.to.length === 1 ? '' : 's'})` };
  }
  return {
    ok: failures.length < batches.length,
    detail: `Resend: ${batches.length - failures.length}/${batches.length} batches sent; errors: ${failures.join(' | ')}`
  };
}

async function send(apiKey: string, message: EmailMessage, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      reply_to: message.replyTo || undefined,
      subject: message.subject,
      html: message.html,
      text: message.text
    })
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
