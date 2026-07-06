import { describe, expect, it } from 'vitest';
import { aggregate, dedupePrs, reviewsInWindow } from '../src/metrics/aggregate.js';
import { computeHighlights } from '../src/metrics/highlights.js';
import { NOW, busyWeek, collectedData, pr, testConfig } from './fixtures.js';

const config = testConfig();

describe('aggregate', () => {
  const data = busyWeek();
  const m = aggregate(data, config);

  it('computes org totals', () => {
    expect(m.org.prsOpened).toBe(3);
    expect(m.org.prsMerged).toBe(4);
    expect(m.org.openPrTotal).toBe(3);
    expect(m.org.issuesOpened).toBe(2);
    expect(m.org.issuesClosed).toBe(1);
    expect(m.org.commits).toBe(76);
    expect(m.org.additions).toBe(6960);
    expect(m.org.activeRepos).toBe(3);
    expect(m.org.totalReposScanned).toBe(3);
  });

  it('counts only in-window, deduped reviews', () => {
    // 4 unique reviews inside the window (one review per PR#1 x2, PR#2, PR#3)
    expect(m.org.reviewsSubmitted).toBe(4);
  });

  it('excludes bots from person metrics but keeps their merges attributed to humans', () => {
    expect(m.byPerson.find((p) => p.login === 'depbot[bot]')).toBeUndefined();
    const alice = m.byPerson.find((p) => p.login === 'alice')!;
    expect(alice.mergesPerformed).toBe(1); // merged the bot PR
    const bob = m.byPerson.find((p) => p.login === 'bob')!;
    expect(bob.mergesPerformed).toBe(2);
    expect(bob.reviewsSubmitted).toBe(2);
  });

  it('ranks repos by activity score', () => {
    expect(m.byRepo[0]!.repo).toBe('api');
    expect(m.byRepo.map((r) => r.repo)).toEqual(['api', 'web', 'docs']);
  });

  it('median time-to-merge is computed from merged PRs', () => {
    expect(m.org.medianTimeToMergeHours).not.toBeNull();
    expect(m.org.medianTimeToMergeHours!).toBeGreaterThan(0);
  });
});

describe('dedupePrs / reviewsInWindow', () => {
  it('dedupes PRs across sets by repo#number', () => {
    const a = pr({ repo: 'api', number: 1 });
    const b = pr({ repo: 'api', number: 1, title: 'same PR from another set' });
    expect(dedupePrs([a], [b])).toHaveLength(1);
  });

  it('drops reviews outside the window', () => {
    const data = collectedData({
      prsOpened: [
        pr({
          repo: 'api',
          number: 9,
          reviews: [
            { author: 'bob', state: 'APPROVED', submittedAt: '2026-06-15T10:00:00Z' }, // before window
            { author: 'carol', state: 'APPROVED', submittedAt: '2026-07-01T10:00:00Z' } // inside
          ]
        })
      ]
    });
    const reviews = reviewsInWindow(data);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.author).toBe('carol');
  });
});

describe('computeHighlights', () => {
  const data = busyWeek();
  const metrics = aggregate(data, config);
  const highlights = computeHighlights(data, metrics, config, NOW);
  const byId = new Map(highlights.map((h) => [h.id, h]));

  it('finds the oldest open PR, skipping drafts', () => {
    const h = byId.get('oldest-open-pr');
    expect(h).toMatchObject({ pr: { repo: 'api', number: 7 }, ageDays: 66 });
  });

  it('crowns the top merger excluding bots', () => {
    const h = byId.get('top-merger');
    expect(h).toMatchObject({ podium: [{ login: 'bob', count: 2 }] });
  });

  it('crowns the top reviewer', () => {
    const h = byId.get('top-reviewer');
    expect(h).toMatchObject({ podium: [{ login: 'bob', count: 2 }] });
  });

  it('lists stale PRs (no review, past threshold, non-draft)', () => {
    const h = byId.get('stale-prs');
    expect(h).toMatchObject({ totalStale: 2 });
    if (h?.id === 'stale-prs') {
      expect(h.items.map((i) => i.number)).toEqual([7, 8]);
    }
  });

  it('finds the biggest merged PR excluding bots', () => {
    const h = byId.get('biggest-pr');
    expect(h).toMatchObject({ pr: { repo: 'web', number: 3 }, additions: 1500 });
  });

  it('finds the fastest first review above the rubber-stamp floor', () => {
    const h = byId.get('fastest-review');
    // PR#1: carol reviewed 45 min after open (bob was 25h later); PR#2: alice 28h; PR#3: bob ~8d
    expect(h).toMatchObject({ pr: { repo: 'api', number: 1 }, reviewer: 'carol', minutes: 45 });
  });

  it('detects first-time contributors from authorAssociation', () => {
    expect(byId.get('first-time-contributors')).toMatchObject({ logins: ['dave'] });
  });

  it('picks the most active repo', () => {
    expect(byId.get('most-active-repo')).toMatchObject({ repo: 'api' });
  });

  it('honors disabled highlights', () => {
    const offConfig = testConfig({ highlights: 'top-merger' });
    const only = computeHighlights(data, metrics, offConfig, NOW);
    expect(only.map((h) => h.id)).toEqual(['top-merger']);
  });

  it('returns nothing on an empty week', () => {
    const empty = collectedData();
    const none = computeHighlights(empty, aggregate(empty, config), config, NOW);
    expect(none).toEqual([]);
  });
});
