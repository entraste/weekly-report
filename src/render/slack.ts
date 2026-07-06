/**
 * Slack Block Kit renderer — condensed summary (~9 blocks): headline,
 * period context, executive summary (≤1800 chars), key-number fields (≤10),
 * top-N highlights, link to the full report.
 */
import { t } from '../i18n/index.js';
import type { Report } from '../metrics/types.js';
import { keyNumberRows, renderHighlight } from './markdown.js';

const SUMMARY_CHAR_LIMIT = 1800;
const MAX_FIELDS = 10;

/** GitHub-flavored markdown → Slack mrkdwn (links + bold only). */
export function mdToMrkdwn(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*');
}

export interface SlackPayload {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function buildSlackPayload(report: Report): SlackPayload {
  const lang = report.language;
  const headline = t(lang, 'slack.headline', { org: report.org, periodLabel: report.periodLabel });
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: headline.slice(0, 150), emoji: true }
  });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${report.window.startDate} → ${report.window.endDate} (${report.window.timezone})`
      }
    ]
  });

  // Executive summary (or status notice)
  const summaryText = report.narrative
    ? report.narrative.executiveSummary
    : t(lang, `narrative.${report.narrativeStatus}` as Parameters<typeof t>[1]).replaceAll('_', '');
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(summaryText, SUMMARY_CHAR_LIMIT) }
  });

  // Key numbers as fields
  const rows = keyNumberRows(report).slice(0, MAX_FIELDS);
  if (rows.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      fields: rows.map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` }))
    });
  }

  // Top-N highlights
  const top = report.highlights.slice(0, report.slackTopHighlights ?? 3);
  if (top.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: top.map((h) => `• ${truncate(mdToMrkdwn(renderHighlight(h, report).split('\n')[0]!), 500)}`).join('\n')
      }
    });
  }

  // Link to the full report
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${report.runUrl}|${t(lang, 'slack.viewFull')}>` }]
  });

  return { text: headline, blocks };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
