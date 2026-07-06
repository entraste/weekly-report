/**
 * Metrics + Report — the deterministic core. Every number in the report comes
 * from here; the LLM never computes or restates figures on its own.
 */
import type { HighlightId, Language, ResolvedConfig } from '../schema/index.js';
import type { ReportWindow } from '../util/time.js';

export interface OrgMetrics {
  prsOpened: number;
  prsMerged: number;
  /** Org-wide currently-open PR total (true count, not fetch-capped). */
  openPrTotal: number;
  issuesOpened: number;
  issuesClosed: number;
  commits: number;
  reviewsSubmitted: number;
  additions: number;
  deletions: number;
  medianTimeToMergeHours: number | null;
  activeContributors: number;
  activeRepos: number;
  totalReposScanned: number;
}

export interface RepoMetrics {
  repo: string;
  prsOpened: number;
  prsMerged: number;
  openPrs: number;
  issuesOpened: number;
  issuesClosed: number;
  commits: number;
  additions: number;
  deletions: number;
  /** Composite ordering score (also drives most-active-repo). */
  activityScore: number;
}

export interface PersonMetrics {
  login: string;
  prsOpened: number;
  prsMerged: number;
  mergesPerformed: number;
  reviewsSubmitted: number;
  issuesOpened: number;
  activityScore: number;
}

/** Highlight payloads are data-only; rendering/i18n happens in the render stage. */
export interface HighlightPrRef {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
}

export type HighlightData =
  | { id: 'oldest-open-pr'; pr: HighlightPrRef; ageDays: number }
  | { id: 'top-merger'; podium: Array<{ login: string; count: number }> }
  | { id: 'top-reviewer'; podium: Array<{ login: string; count: number }> }
  | { id: 'stale-prs'; items: Array<HighlightPrRef & { ageDays: number }>; totalStale: number; thresholdDays: number }
  | { id: 'biggest-pr'; pr: HighlightPrRef; additions: number; deletions: number }
  | { id: 'fastest-review'; pr: HighlightPrRef; reviewer: string; minutes: number }
  | { id: 'first-time-contributors'; logins: string[] }
  | { id: 'most-active-repo'; repo: string; prsMerged: number; commits: number };

export interface Narrative {
  executiveSummary: string;
  repoNotes: Array<{ repo: string; note: string }>;
  teamNote: string;
}

export type NarrativeStatus = 'ok' | 'skipped-no-key' | 'skipped-dry-run' | 'skipped-disabled' | 'failed';

export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
}

export interface Report {
  org: string;
  window: ReportWindow;
  language: Language;
  /** Rendered title with placeholders resolved. */
  title: string;
  /** Human period label in the report language, e.g. "Week of Jun 29 – Jul 5, 2026". */
  periodLabel: string;
  levels: ResolvedConfig['levels'];
  orgMetrics: OrgMetrics;
  /** Sorted by activity, capped at report.repos-max (+ rollup row info). */
  repoMetrics: RepoMetrics[];
  /** Repos beyond the cap, aggregated. */
  repoLongTail: { count: number; prsMerged: number; commits: number } | null;
  /** Sorted by activity, bots/opt-outs excluded, capped at people.max-listed. */
  personMetrics: PersonMetrics[];
  highlights: HighlightData[];
  enabledHighlightIds: HighlightId[];
  narrative: Narrative | null;
  narrativeStatus: NarrativeStatus;
  llmUsage: LlmUsage | null;
  warnings: string[];
  /** Workflow run URL (link target in Slack/email). */
  runUrl: string;
  /** How many highlights the Slack summary shows. */
  slackTopHighlights: number;
}
