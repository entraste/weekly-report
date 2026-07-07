/**
 * Deterministic aggregation: CollectedData → org/repo/person metrics.
 */
import type { CollectedData, PrLite, ReviewLite } from '../github/types.js';
import type { ResolvedConfig } from '../schema/index.js';
import { matchesAny } from '../util/globs.js';
import type { OrgMetrics, PersonMetrics, RepoMetrics } from './types.js';

export interface AggregatedMetrics {
  org: OrgMetrics;
  byRepo: RepoMetrics[];
  byPerson: PersonMetrics[];
}

export function isBot(login: string, config: ResolvedConfig): boolean {
  return (
    (config.people.excludeBots && matchesAny(login, config.people.botPatterns)) ||
    config.people.exclude.some((l) => l.toLowerCase() === login.toLowerCase())
  );
}

/** PRs can appear in multiple search sets (opened AND merged in-window). */
export function dedupePrs(...sets: PrLite[][]): PrLite[] {
  const seen = new Map<string, PrLite>();
  for (const set of sets) {
    for (const pr of set) {
      seen.set(`${pr.repo}#${pr.number}`, pr);
    }
  }
  return [...seen.values()];
}

interface WindowedReview extends ReviewLite {
  repo: string;
  prNumber: number;
}

/** All reviews submitted inside the window, deduped across PR sets. */
export function reviewsInWindow(data: CollectedData): WindowedReview[] {
  const seen = new Map<string, WindowedReview>();
  const allPrs = dedupePrs(data.prsOpened, data.prsMerged, data.prsClosedUnmerged, data.openPrs);
  for (const pr of allPrs) {
    for (const review of pr.reviews) {
      if (!review.submittedAt) continue;
      // GitHub creates COMMENTED reviews when the author replies to threads —
      // self-reviews are not review work.
      if (review.author === pr.author) continue;
      const ts = Date.parse(review.submittedAt);
      if (ts < data.window.startUtcMs || ts >= data.window.endUtcMs) continue;
      const key = `${pr.repo}#${pr.number}@${review.author}@${review.submittedAt}`;
      if (!seen.has(key)) seen.set(key, { ...review, repo: pr.repo, prNumber: pr.number });
    }
  }
  return [...seen.values()];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function aggregate(data: CollectedData, config: ResolvedConfig): AggregatedMetrics {
  const reviews = reviewsInWindow(data);

  // ---------- per-repo ----------
  const repoMap = new Map<string, RepoMetrics>();
  const repoOf = (name: string): RepoMetrics => {
    let m = repoMap.get(name);
    if (!m) {
      m = {
        repo: name,
        prsOpened: 0,
        prsMerged: 0,
        openPrs: data.openPrCountByRepo[name] ?? 0,
        issuesOpened: 0,
        issuesClosed: 0,
        commits: data.commitsByRepo[name] ?? 0,
        additions: 0,
        deletions: 0,
        activityScore: 0
      };
      repoMap.set(name, m);
    }
    return m;
  };

  // Seed every scanned repo so zero-activity repos exist (then filtered by score).
  for (const repo of data.repos) repoOf(repo.name);

  for (const pr of data.prsOpened) repoOf(pr.repo).prsOpened += 1;
  for (const pr of data.prsMerged) {
    const m = repoOf(pr.repo);
    m.prsMerged += 1;
    m.additions += pr.additions;
    m.deletions += pr.deletions;
  }
  for (const issue of data.issuesOpened) repoOf(issue.repo).issuesOpened += 1;
  for (const issue of data.issuesClosed) repoOf(issue.repo).issuesClosed += 1;

  for (const m of repoMap.values()) {
    m.activityScore = m.commits + 3 * m.prsMerged + 2 * m.prsOpened + m.issuesOpened + m.issuesClosed;
  }

  const byRepo = [...repoMap.values()].sort(
    (a, b) => b.activityScore - a.activityScore || a.repo.localeCompare(b.repo)
  );

  // ---------- per-person ----------
  const personMap = new Map<string, PersonMetrics>();
  const personOf = (login: string): PersonMetrics => {
    let m = personMap.get(login);
    if (!m) {
      m = {
        login,
        prsOpened: 0,
        prsMerged: 0,
        mergesPerformed: 0,
        reviewsSubmitted: 0,
        issuesOpened: 0,
        activityScore: 0
      };
      personMap.set(login, m);
    }
    return m;
  };

  for (const pr of data.prsOpened) {
    if (!isBot(pr.author, config)) personOf(pr.author).prsOpened += 1;
  }
  for (const pr of data.prsMerged) {
    if (!isBot(pr.author, config)) personOf(pr.author).prsMerged += 1;
    if (pr.mergedBy && !isBot(pr.mergedBy, config)) personOf(pr.mergedBy).mergesPerformed += 1;
  }
  for (const review of reviews) {
    if (!isBot(review.author, config)) personOf(review.author).reviewsSubmitted += 1;
  }
  for (const issue of data.issuesOpened) {
    if (!isBot(issue.author, config)) personOf(issue.author).issuesOpened += 1;
  }

  for (const m of personMap.values()) {
    m.activityScore =
      3 * m.prsMerged + 2 * m.prsOpened + 2 * m.reviewsSubmitted + m.mergesPerformed + m.issuesOpened;
  }

  const byPerson = [...personMap.values()]
    .filter((m) => m.activityScore > 0)
    .sort((a, b) => b.activityScore - a.activityScore || a.login.localeCompare(b.login));

  // ---------- org ----------
  const mergedDurationsHours = data.prsMerged
    .filter((pr) => pr.mergedAt)
    .map((pr) => (Date.parse(pr.mergedAt!) - Date.parse(pr.createdAt)) / 3_600_000);

  const activeContributors = new Set<string>();
  for (const m of byPerson) activeContributors.add(m.login);

  const org: OrgMetrics = {
    prsOpened: data.prsOpened.length,
    prsMerged: data.prsMerged.length,
    openPrTotal: data.openPrTotalCount,
    issuesOpened: data.issuesOpened.length,
    issuesClosed: data.issuesClosed.length,
    commits: Object.values(data.commitsByRepo).reduce((a, b) => a + b, 0),
    reviewsSubmitted: reviews.length,
    additions: data.prsMerged.reduce((a, pr) => a + pr.additions, 0),
    deletions: data.prsMerged.reduce((a, pr) => a + pr.deletions, 0),
    medianTimeToMergeHours: median(mergedDurationsHours),
    activeContributors: activeContributors.size,
    activeRepos: byRepo.filter((m) => m.activityScore > 0).length,
    totalReposScanned: data.repos.length
  };

  return { org, byRepo, byPerson };
}
