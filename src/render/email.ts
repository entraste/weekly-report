/**
 * Email HTML renderer — table-based layout with inline CSS (Outlook-safe).
 * The text/plain alternative is the markdown report.
 */
import { humanDuration, t } from '../i18n/index.js';
import type { Report } from '../metrics/types.js';
import { hasTrackedActivity, keyNumberRows, renderHighlight } from './markdown.js';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escaped markdown (links + bold) → minimal inline HTML. */
export function mdInlineToHtml(md: string): string {
  return escapeHtml(md)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) =>
      // Only http(s) targets become anchors — javascript:/data: render as text.
      /^https?:\/\//i.test(url) ? `<a href="${url}" style="color:#0969da;text-decoration:none;">${text}</a>` : match
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // word-boundary-aware italics so snake_case identifiers survive
    .replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,;:!?<])/g, '$1<em>$2</em>');
}

const CELL = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:14px;';
const HEAD_CELL = `${CELL}font-weight:600;background:#f6f8fa;text-align:left;`;
const NUM_CELL = `${CELL}text-align:right;font-variant-numeric:tabular-nums;`;

function table(headers: string[], rows: string[][], numericFrom = 1): string {
  const head = headers
    .map((h, i) => `<th style="${HEAD_CELL}${i >= numericFrom ? 'text-align:right;' : ''}">${escapeHtml(h)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => `<td style="${i >= numericFrom ? NUM_CELL : CELL}">${cell}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:8px 0 24px;">` +
    `<tr>${head}</tr>${body}</table>`;
}

function sectionTitle(text: string): string {
  return `<h2 style="font-size:18px;margin:28px 0 8px;color:#1f2328;">${escapeHtml(text)}</h2>`;
}

export function renderEmailHtml(report: Report): string {
  const lang = report.language;
  const n = (v: number): string => v.toLocaleString('en-US');
  const parts: string[] = [];

  parts.push(
    `<h1 style="font-size:22px;margin:0 0 4px;color:#1f2328;">${escapeHtml(report.title)}</h1>`,
    `<p style="color:#57606a;font-size:13px;margin:0 0 20px;">${report.window.startDate} → ${report.window.endDate} (${escapeHtml(report.window.timezone)})</p>`
  );

  // Executive summary
  parts.push(sectionTitle(t(lang, 'section.executiveSummary')));
  const summary = report.narrative
    ? escapeHtml(report.narrative.executiveSummary)
    : mdInlineToHtml(t(lang, `narrative.${report.narrativeStatus}` as Parameters<typeof t>[1]));
  parts.push(`<p style="font-size:15px;line-height:1.5;color:#1f2328;">${summary}</p>`);

  // Key numbers
  parts.push(sectionTitle(t(lang, 'section.keyNumbers')));
  if (!hasTrackedActivity(report)) {
    parts.push(`<p style="font-size:14px;color:#57606a;">${escapeHtml(t(lang, 'report.noActivity'))}</p>`);
  } else {
    parts.push(table([' ', ' '], keyNumberRows(report).map(([label, value]) => [escapeHtml(label), escapeHtml(value)])));
  }

  // Highlights
  if (report.highlights.length > 0) {
    parts.push(sectionTitle(t(lang, 'section.highlights')));
    parts.push(
      `<ul style="padding-left:20px;font-size:14px;line-height:1.7;color:#1f2328;">` +
        report.highlights
          .map((h) => `<li>${renderHighlight(h, report).split('\n').map(mdInlineToHtml).join('<br>')}</li>`)
          .join('') +
        `</ul>`
    );
  }

  // Repo activity
  if (report.levels.repo && report.repoMetrics.length > 0) {
    parts.push(sectionTitle(t(lang, 'section.repoActivity')));
    const notes = new Map(report.narrative?.repoNotes.map((r) => [r.repo, r.note]) ?? []);
    const rows = report.repoMetrics.map((m) => {
      const note = notes.get(m.repo);
      const name = `<strong>${escapeHtml(m.repo)}</strong>${note ? `<br><em style="color:#57606a;font-size:13px;">${escapeHtml(note)}</em>` : ''}`;
      return [
        name,
        n(m.prsMerged),
        n(m.prsOpened),
        n(m.openPrs),
        `${n(m.issuesOpened)}/${n(m.issuesClosed)}`,
        n(m.commits)
      ];
    });
    parts.push(
      table(
        [
          t(lang, 'table.repo'),
          t(lang, 'table.prsMerged'),
          t(lang, 'table.prsOpened'),
          t(lang, 'table.openPrsNow'),
          t(lang, 'table.issues'),
          t(lang, 'table.commits')
        ],
        rows
      )
    );
    if (report.repoLongTail) {
      parts.push(
        `<p style="font-size:13px;color:#57606a;">${escapeHtml(
          t(lang, 'table.longTail', {
            count: report.repoLongTail.count,
            prsMerged: n(report.repoLongTail.prsMerged),
            commits: n(report.repoLongTail.commits)
          })
        )}</p>`
      );
    }
  }

  // Contributors
  if (report.levels.person && report.personMetrics.length > 0) {
    parts.push(sectionTitle(t(lang, 'section.contributors')));
    parts.push(
      table(
        [
          t(lang, 'table.person'),
          t(lang, 'table.prsMerged'),
          t(lang, 'table.prsOpened'),
          t(lang, 'table.reviews'),
          t(lang, 'table.merges')
        ],
        report.personMetrics.map((p) => [
          `@${escapeHtml(p.login)}`,
          n(p.prsMerged),
          n(p.prsOpened),
          n(p.reviewsSubmitted),
          n(p.mergesPerformed)
        ])
      )
    );
    if (report.narrative?.teamNote) {
      parts.push(`<p style="font-size:14px;color:#1f2328;">${escapeHtml(report.narrative.teamNote)}</p>`);
    }
  }

  // Appendix line + run link
  const appendix: string[] = [
    t(lang, 'appendix.window', {
      startDate: report.window.startDate,
      endDate: report.window.endDate,
      timezone: report.window.timezone,
      period: t(lang, `periodWord.${report.window.period}` as Parameters<typeof t>[1])
    }),
    t(lang, 'appendix.repos', { scanned: report.orgMetrics.totalReposScanned })
  ];
  if (report.orgMetrics.medianTimeToMergeHours !== null) {
    appendix.push(
      `${t(lang, 'metric.medianTimeToMerge')}: ${humanDuration(report.orgMetrics.medianTimeToMergeHours, lang)}`
    );
  }
  parts.push(
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px;">`,
    `<p style="font-size:12px;color:#8b949e;line-height:1.6;">${appendix.map(escapeHtml).join('<br>')}<br>` +
      `<a href="${report.runUrl}" style="color:#0969da;">${escapeHtml(t(lang, 'email.viewRun'))}</a> · ${escapeHtml(
        t(lang, 'appendix.generatedBy')
      )}</p>`
  );

  return (
    `<div style="max-width:720px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#ffffff;">` +
    parts.join('\n') +
    `</div>`
  );
}
