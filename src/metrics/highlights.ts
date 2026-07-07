/**
 * Highlight computation — deterministic, celebratory/process-level only.
 */
import type { CollectedData, PrLite } from '../github/types.js';
import type { ResolvedConfig } from '../schema/index.js';
import { dedupePrs, isBot, reviewsInWindow } from './aggregate.js';
import type { AggregatedMetrics } from './aggregate.js';
import type { HighlightData, HighlightPrRef } from './types.js';

function prRef(pr: PrLite): HighlightPrRef {
  return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author };
}

function ageDays(pr: PrLite, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(pr.createdAt)) / 86_400_000);
}

function podium(counts: Map<string, number>, size: number): Array<{ login: string; count: number }> {
  return [...counts.entries()]
    .map(([login, count]) => ({ login, count }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login))
    .slice(0, size);
}

export function computeHighlights(
  data: CollectedData,
  metrics: AggregatedMetrics,
  config: ResolvedConfig,
  nowMs: number
): HighlightData[] {
  const results: HighlightData[] = [];
  const h = config.highlights;

  if (h['oldest-open-pr'].enabled) {
    const { minAgeDays, ignoreDrafts } = h['oldest-open-pr'].params;
    // openPrs arrive oldest-first from search.
    const oldest = data.openPrs.find((pr) => !(ignoreDrafts && pr.isDraft) && ageDays(pr, nowMs) >= minAgeDays);
    if (oldest) results.push({ id: 'oldest-open-pr', pr: prRef(oldest), ageDays: ageDays(oldest, nowMs) });
  }

  if (h['top-merger'].enabled) {
    const counts = new Map<string, number>();
    for (const pr of data.prsMerged) {
      if (pr.mergedBy && !isBot(pr.mergedBy, config)) {
        counts.set(pr.mergedBy, (counts.get(pr.mergedBy) ?? 0) + 1);
      }
    }
    const top = podium(counts, h['top-merger'].params.podium);
    if (top.length > 0) results.push({ id: 'top-merger', podium: top });
  }

  if (h['top-reviewer'].enabled) {
    const counts = new Map<string, number>();
    for (const review of reviewsInWindow(data)) {
      if (!isBot(review.author, config)) counts.set(review.author, (counts.get(review.author) ?? 0) + 1);
    }
    const top = podium(counts, h['top-reviewer'].params.podium);
    if (top.length > 0) results.push({ id: 'top-reviewer', podium: top });
  }

  if (h['stale-prs'].enabled) {
    const { thresholdDays, maxListed } = h['stale-prs'].params;
    const stale = data.openPrs.filter(
      (pr) =>
        !pr.isDraft &&
        ageDays(pr, nowMs) >= thresholdDays &&
        !pr.reviews.some((r) => r.submittedAt !== null)
    );
    if (stale.length > 0) {
      results.push({
        id: 'stale-prs',
        items: stale.slice(0, maxListed).map((pr) => ({ ...prRef(pr), ageDays: ageDays(pr, nowMs) })),
        totalStale: stale.length,
        thresholdDays
      });
    }
  }

  if (h['biggest-pr'].enabled) {
    const candidates = data.prsMerged.filter(
      (pr) => !(h['biggest-pr'].params.excludeBots && isBot(pr.author, config))
    );
    const biggest = candidates.reduce<PrLite | null>(
      (best, pr) => (!best || pr.additions + pr.deletions > best.additions + best.deletions ? pr : best),
      null
    );
    if (biggest && biggest.additions + biggest.deletions > 0) {
      results.push({ id: 'biggest-pr', pr: prRef(biggest), additions: biggest.additions, deletions: biggest.deletions });
    }
  }

  if (h['fastest-review'].enabled) {
    const { minMinutes } = h['fastest-review'].params;
    let best: { pr: PrLite; reviewer: string; minutes: number } | null = null;
    for (const pr of dedupePrs(data.prsOpened, data.prsMerged)) {
      const created = Date.parse(pr.createdAt);
      // The PR's true FIRST eligible review — and it must fall inside the
      // window, otherwise a pre-window review would win (or repeat) here.
      let first: { author: string; ts: number } | null = null;
      for (const review of pr.reviews) {
        if (!review.submittedAt || isBot(review.author, config) || review.author === pr.author) continue;
        const ts = Date.parse(review.submittedAt);
        if (!first || ts < first.ts) first = { author: review.author, ts };
      }
      if (!first) continue;
      if (first.ts < data.window.startUtcMs || first.ts >= data.window.endUtcMs) continue;
      const minutes = (first.ts - created) / 60_000;
      if (minutes < minMinutes) continue; // ignore instant rubber stamps
      if (!best || minutes < best.minutes) best = { pr, reviewer: first.author, minutes };
    }
    if (best) {
      results.push({
        id: 'fastest-review',
        pr: prRef(best.pr),
        reviewer: best.reviewer,
        minutes: Math.round(best.minutes)
      });
    }
  }

  if (h['first-time-contributors'].enabled) {
    const logins = new Set<string>();
    for (const pr of dedupePrs(data.prsOpened, data.prsMerged)) {
      if (isBot(pr.author, config)) continue;
      if (pr.authorAssociation === 'FIRST_TIME_CONTRIBUTOR' || pr.authorAssociation === 'FIRST_TIMER') {
        logins.add(pr.author);
      }
    }
    if (logins.size > 0) results.push({ id: 'first-time-contributors', logins: [...logins].sort() });
  }

  if (h['most-active-repo'].enabled) {
    const top = metrics.byRepo[0];
    if (top && top.activityScore > 0) {
      results.push({ id: 'most-active-repo', repo: top.repo, prsMerged: top.prsMerged, commits: top.commits });
    }
  }

  return results;
}
