/**
 * CollectedData — everything the metrics stage needs, gathered in one pass.
 * All timestamps are ISO-8601 UTC strings exactly as GitHub returns them.
 */
import type { ReportWindow } from '../util/time.js';

export interface RepoInfo {
  name: string;
  archived: boolean;
  fork: boolean;
  isPrivate: boolean;
}

export interface ReviewLite {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string | null;
}

export interface PrLite {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** GitHub's association of the author with the repo (FIRST_TIME_CONTRIBUTOR etc.) */
  authorAssociation: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  additions: number;
  deletions: number;
  mergedBy: string | null;
  reviewsTotal: number;
  /** First page of reviews (≤50); enough for turnaround + per-reviewer counts. */
  reviews: ReviewLite[];
}

export interface IssueLite {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  closedAt: string | null;
}

export interface CollectedData {
  org: string;
  window: ReportWindow;
  /** All repos visible to the token after include/exclude/skip filtering. */
  repos: RepoInfo[];
  prsOpened: PrLite[];
  prsMerged: PrLite[];
  /** Currently-open PRs, oldest first (first pages up to the fetch cap). */
  openPrs: PrLite[];
  /** True total of open PRs org-wide (search issueCount, not just fetched page). */
  openPrTotalCount: number;
  issuesOpened: IssueLite[];
  issuesClosed: IssueLite[];
  /** Default-branch commit count per repo inside the window. */
  commitsByRepo: Record<string, number>;
  /** Exact open-PR count per repo (from the batched repo query). */
  openPrCountByRepo: Record<string, number>;
  /** Non-fatal collection problems, surfaced in the report appendix. */
  warnings: string[];
}
