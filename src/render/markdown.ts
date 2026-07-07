/**
 * Markdown renderer — the canonical full report (job summary, artifact, and
 * the text/plain email alternative all derive from this).
 */
import { humanDuration, t } from '../i18n/index.js';
import type { HighlightData, Report } from '../metrics/types.js';

function n(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Escape untrusted text for inline-markdown interpolation: neutralizes table
 * pipes, link/emphasis metacharacters and newlines so a PR title can never
 * inject links or break tables (defense-in-depth next to the LLM tripwires).
 */
export function mdEscapeInline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1');
}

/** Anything at all happened in this window? Shared by all renderers. */
export function hasTrackedActivity(report: Report): boolean {
  const m = report.orgMetrics;
  return m.prsOpened + m.prsMerged + m.commits + m.issuesOpened + m.issuesClosed + m.reviewsSubmitted > 0;
}

export function renderHighlight(h: HighlightData, report: Report): string {
  const lang = report.language;
  switch (h.id) {
    case 'oldest-open-pr':
      return t(lang, 'highlight.oldest-open-pr', { ...h.pr, title: mdEscapeInline(h.pr.title), ageDays: h.ageDays });
    case 'top-merger':
    case 'top-reviewer':
      return t(lang, `highlight.${h.id}`, {
        entries: h.podium.map((e) => t(lang, 'highlight.entry', { login: e.login, count: e.count })).join(', ')
      });
    case 'stale-prs': {
      const header = t(lang, 'highlight.stale-prs', {
        totalStale: h.totalStale,
        thresholdDays: h.thresholdDays
      });
      const items = h.items.map((item) => `  - ${t(lang, 'highlight.stale-prs.item', { ...item, title: mdEscapeInline(item.title) })}`);
      return [header, ...items].join('\n');
    }
    case 'biggest-pr':
      return t(lang, 'highlight.biggest-pr', { ...h.pr, title: mdEscapeInline(h.pr.title), additions: n(h.additions), deletions: n(h.deletions) });
    case 'fastest-review':
      return t(lang, 'highlight.fastest-review', {
        ...h.pr,
        title: mdEscapeInline(h.pr.title),
        reviewer: h.reviewer,
        duration: humanDuration(h.minutes / 60, lang)
      });
    case 'first-time-contributors':
      return t(lang, 'highlight.first-time-contributors', {
        logins: h.logins.map((l) => `@${l}`).join(', ')
      });
    case 'most-active-repo':
      return t(lang, 'highlight.most-active-repo', { repo: h.repo, prsMerged: h.prsMerged, commits: h.commits });
  }
}

export function keyNumberRows(report: Report): Array<[string, string]> {
  const lang = report.language;
  const m = report.orgMetrics;
  const rows: Array<[string, string]> = [
    [t(lang, 'metric.prsMerged'), n(m.prsMerged)],
    [t(lang, 'metric.prsOpened'), n(m.prsOpened)],
    [t(lang, 'metric.openPrTotal'), n(m.openPrTotal)],
    [t(lang, 'metric.reviewsSubmitted'), n(m.reviewsSubmitted)],
    [t(lang, 'metric.issuesOpened'), n(m.issuesOpened)],
    [t(lang, 'metric.issuesClosed'), n(m.issuesClosed)],
    [t(lang, 'metric.commits'), n(m.commits)],
    [t(lang, 'metric.linesChanged'), `+${n(m.additions)} / −${n(m.deletions)}`],
    [t(lang, 'metric.activeContributors'), n(m.activeContributors)],
    [t(lang, 'metric.activeRepos'), `${n(m.activeRepos)} / ${n(m.totalReposScanned)}`]
  ];
  if (m.medianTimeToMergeHours !== null) {
    rows.push([t(lang, 'metric.medianTimeToMerge'), humanDuration(m.medianTimeToMergeHours, lang)]);
  }
  return rows;
}

export function renderMarkdown(report: Report): string {
  const lang = report.language;
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');

  // 1. Executive summary (LLM) or status notice
  lines.push(`## ${t(lang, 'section.executiveSummary')}`);
  lines.push('');
  if (report.narrative) {
    lines.push(report.narrative.executiveSummary.trim());
  } else {
    lines.push(t(lang, `narrative.${report.narrativeStatus}` as Parameters<typeof t>[1]));
  }
  lines.push('');

  // 2. Key numbers
  lines.push(`## ${t(lang, 'section.keyNumbers')}`);
  lines.push('');
  if (!hasTrackedActivity(report)) {
    lines.push(t(lang, 'report.noActivity'));
  } else {
    lines.push('| | |');
    lines.push('|---|---:|');
    for (const [label, value] of keyNumberRows(report)) lines.push(`| ${label} | ${value} |`);
  }
  lines.push('');

  // 3. Highlights
  if (report.highlights.length > 0) {
    lines.push(`## ${t(lang, 'section.highlights')}`);
    lines.push('');
    for (const h of report.highlights) lines.push(`- ${renderHighlight(h, report)}`);
    lines.push('');
  }

  // 4. Repository activity
  if (report.levels.repo && report.repoMetrics.length > 0) {
    lines.push(`## ${t(lang, 'section.repoActivity')}`);
    lines.push('');
    lines.push(
      `| ${t(lang, 'table.repo')} | ${t(lang, 'table.prsMerged')} | ${t(lang, 'table.prsOpened')} | ` +
        `${t(lang, 'table.openPrsNow')} | ${t(lang, 'table.issues')} | ${t(lang, 'table.commits')} | ${t(lang, 'table.linesChanged')} |`
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    const notes = new Map(report.narrative?.repoNotes.map((r) => [r.repo, r.note]) ?? []);
    for (const m of report.repoMetrics) {
      lines.push(
        `| **${m.repo}** | ${n(m.prsMerged)} | ${n(m.prsOpened)} | ${n(m.openPrs)} | ` +
          `${n(m.issuesOpened)}/${n(m.issuesClosed)} | ${n(m.commits)} | +${n(m.additions)}/−${n(m.deletions)} |`
      );
      const note = notes.get(m.repo);
      if (note) lines.push(`| ↳ _${mdEscapeInline(note.trim())}_ |||||||`);
    }
    if (report.repoLongTail) {
      lines.push('');
      lines.push(
        t(lang, 'table.longTail', {
          count: report.repoLongTail.count,
          prsMerged: n(report.repoLongTail.prsMerged),
          commits: n(report.repoLongTail.commits)
        })
      );
    }
    lines.push('');
  }

  // 5. Contributors
  if (report.levels.person && report.personMetrics.length > 0) {
    lines.push(`## ${t(lang, 'section.contributors')}`);
    lines.push('');
    lines.push(
      `| ${t(lang, 'table.person')} | ${t(lang, 'table.prsMerged')} | ${t(lang, 'table.prsOpened')} | ` +
        `${t(lang, 'table.reviews')} | ${t(lang, 'table.merges')} | ${t(lang, 'table.issuesOpened')} |`
    );
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const p of report.personMetrics) {
      lines.push(
        `| @${p.login} | ${n(p.prsMerged)} | ${n(p.prsOpened)} | ${n(p.reviewsSubmitted)} | ` +
          `${n(p.mergesPerformed)} | ${n(p.issuesOpened)} |`
      );
    }
    lines.push('');
    if (report.narrative?.teamNote) {
      lines.push(report.narrative.teamNote.trim());
      lines.push('');
    }
  }

  // 6. Appendix
  lines.push(`## ${t(lang, 'section.appendix')}`);
  lines.push('');
  lines.push(
    `- ${t(lang, 'appendix.window', {
      startDate: report.window.startDate,
      endDate: report.window.endDate,
      timezone: report.window.timezone,
      period: t(lang, `periodWord.${report.window.period}` as Parameters<typeof t>[1])
    })}`
  );
  lines.push(`- ${t(lang, 'appendix.repos', { scanned: report.orgMetrics.totalReposScanned })}`);
  lines.push(`- ${t(lang, 'appendix.method')}`);
  if (report.llmUsage) {
    const cost =
      report.llmUsage.estimatedCostUsd !== null
        ? t(lang, 'appendix.llmCost', { cost: report.llmUsage.estimatedCostUsd.toFixed(3) })
        : '';
    lines.push(
      `- ${t(lang, 'appendix.llmUsage', {
        provider: report.llmUsage.provider,
        model: report.llmUsage.model,
        inputTokens: n(report.llmUsage.inputTokens),
        outputTokens: n(report.llmUsage.outputTokens),
        cost
      })}`
    );
  }
  if (report.warnings.length > 0) {
    lines.push(`- ${t(lang, 'appendix.warnings')}`);
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  lines.push(`_${t(lang, 'appendix.generatedBy')}_`);
  lines.push('');

  return lines.join('\n');
}
