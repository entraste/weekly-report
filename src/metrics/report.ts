/**
 * Report assembly: aggregated metrics + highlights + narrative → Report model
 * consumed by every renderer.
 */
import { enabledHighlights } from '../config/resolve.js';
import type { CollectedData } from '../github/types.js';
import { periodLabel } from '../i18n/index.js';
import type { ResolvedConfig } from '../schema/index.js';
import type { AggregatedMetrics } from './aggregate.js';
import type { HighlightData, LlmUsage, MergedPrGroup, Narrative, NarrativeStatus, Report } from './types.js';

export interface BuildReportOptions {
  data: CollectedData;
  metrics: AggregatedMetrics;
  highlights: HighlightData[];
  config: ResolvedConfig;
  narrative: Narrative | null;
  narrativeStatus: NarrativeStatus;
  llmUsage: LlmUsage | null;
  runUrl: string;
}

export function buildReport(opts: BuildReportOptions): Report {
  const { data, metrics, config } = opts;
  const window = data.window;
  const year = Number(window.endDate.slice(0, 4));
  const label = periodLabel(window.period, window.startDate, window.endDate, config.language, year);

  const title = config.report.title.replaceAll('{org}', config.org).replaceAll('{period-label}', label);

  // Repo table: only repos with activity, capped; the rest roll up.
  const activeRepos = metrics.byRepo.filter((m) => m.activityScore > 0);
  const visible = activeRepos.slice(0, config.report.reposMax);
  const tail = activeRepos.slice(config.report.reposMax);
  const repoLongTail =
    tail.length > 0
      ? {
          count: tail.length,
          prsMerged: tail.reduce((a, m) => a + m.prsMerged, 0),
          commits: tail.reduce((a, m) => a + m.commits, 0)
        }
      : null;

  // Per-repo merged-PR detail, ordered like the repo table (most active first).
  const mergedPrsByRepo: MergedPrGroup[] = [];
  if (config.report.listMergedPrs) {
    const byRepo = new Map<string, typeof data.prsMerged>();
    for (const pr of data.prsMerged) {
      const list = byRepo.get(pr.repo) ?? [];
      list.push(pr);
      byRepo.set(pr.repo, list);
    }
    const repoOrder = [
      ...metrics.byRepo.map((m) => m.repo),
      ...[...byRepo.keys()].filter((r) => !metrics.byRepo.some((m) => m.repo === r)).sort()
    ];
    for (const repo of repoOrder) {
      const prs = byRepo.get(repo);
      if (!prs || prs.length === 0) continue;
      const sorted = [...prs].sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''));
      mergedPrsByRepo.push({
        repo,
        total: sorted.length,
        prs: sorted.slice(0, config.report.mergedPrsPerRepo).map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          mergedAt: pr.mergedAt ?? '',
          additions: pr.additions,
          deletions: pr.deletions
        }))
      });
    }
  }

  return {
    org: config.org,
    window,
    language: config.language,
    title,
    periodLabel: label,
    levels: config.levels,
    orgMetrics: metrics.org,
    repoMetrics: visible,
    repoLongTail,
    personMetrics: metrics.byPerson.slice(0, config.people.maxListed),
    highlights: opts.highlights,
    mergedPrsByRepo,
    enabledHighlightIds: enabledHighlights(config),
    narrative: opts.narrative,
    narrativeStatus: opts.narrativeStatus,
    llmUsage: opts.llmUsage,
    warnings: data.warnings,
    runUrl: opts.runUrl,
    slackReportUrl: config.slack.reportUrl || opts.runUrl,
    slackTopHighlights: config.slack.topHighlights
  };
}
