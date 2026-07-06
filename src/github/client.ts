/**
 * Octokit client with throttling + retry, tuned for a report job that must
 * never hammer the API (search = 30 req/min) and must survive transient 5xx.
 */
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

export const ReportOctokit = Octokit.plugin(paginateRest, retry, throttling);
export type GitHubClient = InstanceType<typeof ReportOctokit>;

export interface ClientOptions {
  token: string;
  /** Injectable for fixture-based tests. */
  fetch?: typeof globalThis.fetch;
  onWarning?: (message: string) => void;
  baseUrl?: string;
}

export function createClient(opts: ClientOptions): GitHubClient {
  const warn = opts.onWarning ?? (() => {});
  return new ReportOctokit({
    auth: opts.token,
    baseUrl: opts.baseUrl,
    request: opts.fetch ? { fetch: opts.fetch } : undefined,
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        warn(`Primary rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s.`);
        return retryCount < 2; // retry twice, then give up
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        warn(`Secondary rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s.`);
        return retryCount < 2;
      }
    }
  });
}
