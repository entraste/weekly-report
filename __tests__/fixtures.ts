/**
 * Synthetic CollectedData + ResolvedConfig builders for tests.
 * Window: 2026-06-29 → 2026-07-05 (UTC), "now" = Monday 2026-07-06 14:30 UTC.
 */
import type { CollectedData, IssueLite, PrLite } from '../src/github/types.js';
import { resolveConfig } from '../src/config/resolve.js';
import type { ResolvedConfig } from '../src/schema/index.js';
import { INPUT_DEFS } from '../src/schema/index.js';
import type { ConfigFile } from '../src/schema/index.js';
import { computeWindow } from '../src/util/time.js';

export const NOW = Date.UTC(2026, 6, 6, 14, 30, 0);

export function testConfig(
  overrides: Record<string, string> = {},
  configFile?: ConfigFile
): ResolvedConfig {
  const defaults: Record<string, string> = {};
  for (const def of INPUT_DEFS) {
    defaults[def.key] = def.default && !def.default.includes('${{') ? def.default : '';
  }
  defaults['github-token'] = 'ghp_test';
  return resolveConfig({
    getInput: (name) => overrides[name] ?? defaults[name] ?? '',
    configFile,
    repositoryOwner: 'acme'
  });
}

let prCounter = 100;

export function pr(partial: Partial<PrLite> & { repo: string }): PrLite {
  prCounter += 1;
  const number = partial.number ?? prCounter;
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/${partial.repo}/pull/${number}`,
    author: 'alice',
    authorAssociation: 'MEMBER',
    createdAt: '2026-06-30T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    isDraft: false,
    additions: 10,
    deletions: 5,
    mergedBy: null,
    reviewsTotal: 0,
    reviews: [],
    ...partial
  };
}

export function issue(partial: Partial<IssueLite> & { repo: string }): IssueLite {
  prCounter += 1;
  const number = partial.number ?? prCounter;
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/${partial.repo}/issues/${number}`,
    author: 'carol',
    createdAt: '2026-07-01T09:00:00Z',
    closedAt: null,
    ...partial
  };
}

export function collectedData(partial: Partial<CollectedData> = {}): CollectedData {
  const window = computeWindow({ period: 'weekly', timezone: 'UTC', nowMs: NOW });
  return {
    org: 'acme',
    window,
    repos: [
      { name: 'api', archived: false, fork: false, isPrivate: true },
      { name: 'web', archived: false, fork: false, isPrivate: true },
      { name: 'docs', archived: false, fork: false, isPrivate: false }
    ],
    prsOpened: [],
    prsMerged: [],
    prsClosedUnmerged: [],
    openPrs: [],
    openPrTotalCount: 0,
    issuesOpened: [],
    issuesClosed: [],
    commitsByRepo: {},
    openPrCountByRepo: {},
    warnings: [],
    ...partial
  };
}

/** A realistic busy week at "acme": 3 repos, 4 humans + 1 bot. */
export function busyWeek(): CollectedData {
  const merged = [
    pr({
      repo: 'api',
      number: 1,
      title: 'Add rate limiter',
      author: 'alice',
      createdAt: '2026-06-29T08:00:00Z',
      mergedAt: '2026-06-30T12:00:00Z',
      mergedBy: 'bob',
      additions: 400,
      deletions: 120,
      reviewsTotal: 2,
      reviews: [
        { author: 'bob', state: 'APPROVED', submittedAt: '2026-06-30T09:00:00Z' },
        { author: 'carol', state: 'COMMENTED', submittedAt: '2026-06-29T08:45:00Z' }
      ]
    }),
    pr({
      repo: 'api',
      number: 2,
      title: 'Fix N+1 in reports',
      author: 'dave',
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      createdAt: '2026-07-01T10:00:00Z',
      mergedAt: '2026-07-02T15:00:00Z',
      mergedBy: 'bob',
      additions: 60,
      deletions: 30,
      reviewsTotal: 1,
      reviews: [{ author: 'alice', state: 'APPROVED', submittedAt: '2026-07-02T14:00:00Z' }]
    }),
    pr({
      repo: 'web',
      number: 3,
      title: 'New dashboard',
      author: 'carol',
      createdAt: '2026-06-25T10:00:00Z', // opened before window, merged inside
      mergedAt: '2026-07-03T11:00:00Z',
      mergedBy: 'carol',
      additions: 1500,
      deletions: 200,
      reviewsTotal: 1,
      reviews: [{ author: 'bob', state: 'APPROVED', submittedAt: '2026-07-03T10:00:00Z' }]
    }),
    pr({
      repo: 'web',
      number: 4,
      title: 'Bump deps',
      author: 'depbot[bot]',
      createdAt: '2026-07-01T00:00:00Z',
      mergedAt: '2026-07-01T06:00:00Z',
      mergedBy: 'alice',
      additions: 5000,
      deletions: 4800,
      reviewsTotal: 0,
      reviews: []
    })
  ];

  const opened = [
    merged[1]!, // opened AND merged inside the window (dedupe check)
    pr({
      repo: 'api',
      number: 5,
      title: 'WIP: new auth flow',
      author: 'alice',
      createdAt: '2026-07-02T09:00:00Z',
      isDraft: true
    }),
    pr({ repo: 'docs', number: 6, title: 'Document webhooks', author: 'carol', createdAt: '2026-07-04T16:00:00Z' })
  ];

  const open = [
    pr({
      repo: 'api',
      number: 7,
      title: 'Refactor billing',
      author: 'dave',
      createdAt: '2026-05-01T10:00:00Z', // 66 days old at NOW
      reviewsTotal: 0,
      reviews: []
    }),
    pr({
      repo: 'web',
      number: 8,
      title: 'Migrate to Vite',
      author: 'alice',
      createdAt: '2026-06-20T10:00:00Z', // 16 days old
      reviewsTotal: 0,
      reviews: []
    }),
    pr({
      repo: 'api',
      number: 5,
      title: 'WIP: new auth flow',
      author: 'alice',
      createdAt: '2026-07-02T09:00:00Z',
      isDraft: true
    })
  ];

  return collectedData({
    prsOpened: opened,
    prsMerged: merged,
    openPrs: open,
    openPrTotalCount: 3,
    issuesOpened: [
      issue({ repo: 'api', number: 50, title: 'Timeout on large orgs', author: 'erin' }),
      issue({ repo: 'web', number: 51, title: 'Dark mode flash', author: 'carol' })
    ],
    issuesClosed: [
      issue({
        repo: 'api',
        number: 40,
        title: 'Flaky login test',
        author: 'alice',
        createdAt: '2026-06-20T09:00:00Z',
        closedAt: '2026-07-01T09:00:00Z'
      })
    ],
    commitsByRepo: { api: 42, web: 31, docs: 3 },
    openPrCountByRepo: { api: 2, web: 1, docs: 0 }
  });
}
