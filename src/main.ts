/**
 * Org Weekly Report (AI) — entrypoint.
 *
 * Pipeline: resolve config → period gate → collect → aggregate → highlights →
 * LLM narrative (optional) → render → deliver. Delivery failures are isolated:
 * the action fails only when EVERY configured external delivery fails.
 */
import * as core from '@actions/core';
import { fetchConfigFile } from './config/file-config.js';
import { resolveConfig } from './config/resolve.js';
import { createClient } from './github/client.js';
import { collect } from './github/collect.js';
import { generateNarrative } from './llm/narrative.js';
import { aggregate } from './metrics/aggregate.js';
import { computeHighlights } from './metrics/highlights.js';
import { buildReport } from './metrics/report.js';
import type { NarrativeStatus, Report } from './metrics/types.js';
import { renderEmailHtml } from './render/email.js';
import { renderMarkdown } from './render/markdown.js';
import { buildSlackPayload } from './render/slack.js';
import { deliverEmail } from './deliver/resend.js';
import { deliverToSlack } from './deliver/slack.js';
import { uploadReportArtifact, writeJobSummary, writeReportFiles } from './deliver/outputs.js';
import { ActionError } from './errors.js';
import { biweeklyShouldRun, computeWindow } from './util/time.js';

function runUrl(): string {
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  return repo && runId ? `${server}/${repo}/actions/runs/${runId}` : server;
}

function fillSubject(template: string, report: Report): string {
  return template
    .replaceAll('{org}', report.org)
    .replaceAll('{start}', report.window.startDate)
    .replaceAll('{end}', report.window.endDate)
    .replaceAll('{period-label}', report.periodLabel);
}

export async function run(): Promise<void> {
  const nowMs = Date.now();

  // --- Config: token + config file first, then full resolution ---
  const githubToken = core.getInput('github-token');
  const configFilePath = core.getInput('config-file') || '.github/weekly-report.yml';
  for (const key of ['github-token', 'anthropic-api-key', 'openai-api-key', 'slack-webhook-url', 'resend-api-key']) {
    const value = core.getInput(key);
    if (value) core.setSecret(value);
  }

  const client = createClient({ token: githubToken, onWarning: (m) => core.warning(m) });

  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const fileResult = repository && githubToken
    ? await fetchConfigFile(client, repository, configFilePath)
    : { config: undefined, warnings: [] as string[] };
  for (const warning of fileResult.warnings) core.warning(warning);

  const config = resolveConfig({
    getInput: (name) => core.getInput(name),
    configFile: fileResult.config,
    repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER ?? ''
  });

  core.info(`Reporting on org "${config.org}" — period=${config.period}, timezone=${config.timezone}, language=${config.language}${config.dryRun ? ' (dry run)' : ''}`);

  // --- Biweekly parity gate (manual dispatches always run) ---
  const isManualDispatch = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (
    config.period === 'biweekly' &&
    !biweeklyShouldRun({ nowMs, timezone: config.timezone, anchor: config.biweeklyAnchor, isManualDispatch })
  ) {
    const notice = `Biweekly parity: this ISO week does not match biweekly-anchor=${config.biweeklyAnchor}; skipping (next scheduled week will run).`;
    core.notice(notice);
    await core.summary.addRaw(`> ${notice}`).write();
    return;
  }

  const window = computeWindow({
    period: config.period,
    timezone: config.timezone,
    nowMs,
    startDate: config.startDate,
    endDate: config.endDate
  });
  core.info(`Window: ${window.startDate} → ${window.endDate} (${config.timezone})`);

  // --- Collect + aggregate (deterministic core) ---
  const data = await collect(client, config, window);
  core.info(
    `Collected: ${data.repos.length} repos, ${data.prsOpened.length} PRs opened, ${data.prsMerged.length} merged, ` +
      `${data.issuesOpened.length}/${data.issuesClosed.length} issues opened/closed.`
  );
  const metrics = aggregate(data, config);
  const highlights = computeHighlights(data, metrics, config, nowMs);

  // --- LLM narrative (never fails the run) ---
  let narrative = null;
  let narrativeStatus: NarrativeStatus;
  let llmUsage = null;
  if (config.dryRun) {
    narrativeStatus = 'skipped-dry-run';
  } else if (config.llm.provider === 'none') {
    narrativeStatus = config.llm.anthropicApiKey || config.llm.openaiApiKey ? 'skipped-disabled' : 'skipped-no-key';
    if (narrativeStatus === 'skipped-no-key') {
      core.warning('No LLM API key configured — generating a metrics-only report. Add anthropic-api-key or openai-api-key for a narrative.');
    }
  } else {
    const outcome = await generateNarrative({ data, metrics, highlights, config });
    for (const note of outcome.notes) core.info(`LLM: ${note}`);
    narrative = outcome.narrative;
    narrativeStatus = outcome.status === 'ok' ? 'ok' : 'failed';
    llmUsage = outcome.llmUsage;
    if (llmUsage) {
      core.info(
        `LLM usage: ${llmUsage.provider}/${llmUsage.model} — ${llmUsage.inputTokens} in / ${llmUsage.outputTokens} out` +
          (llmUsage.estimatedCostUsd !== null ? ` (~$${llmUsage.estimatedCostUsd.toFixed(4)})` : '')
      );
    }
    if (narrativeStatus === 'failed') {
      core.warning('LLM narrative failed — shipping the deterministic report without it. See the log above.');
    }
  }

  const report = buildReport({ data, metrics, highlights, config, narrative, narrativeStatus, llmUsage, runUrl: runUrl() });

  // --- Render ---
  const markdown = renderMarkdown(report);
  const html = renderEmailHtml(report);

  // --- Deliver ---
  const deliveryStatus: Record<string, string> = {};
  const files = writeReportFiles(markdown, html, report);
  core.setOutput('report-markdown-path', files.markdownPath);
  core.setOutput('report-html-path', files.htmlPath);
  core.setOutput('metrics-json-path', files.dataPath);

  if (config.output.jobSummary) {
    const summary = await writeJobSummary(markdown);
    deliveryStatus.summary = summary.ok ? 'ok' : 'failed';
    if (!summary.ok) core.warning(summary.detail);
  }

  if (config.output.artifact && !config.dryRun) {
    const artifact = await uploadReportArtifact(config.output.artifactName, files);
    deliveryStatus.artifact = artifact.ok ? 'ok' : 'failed';
    if (!artifact.ok) core.warning(artifact.detail);
  }

  const externalResults: Array<{ channel: string; ok: boolean; detail: string }> = [];
  if (config.dryRun) {
    core.notice('Dry run — external deliveries (Slack/email) skipped.');
  } else {
    const tasks: Array<Promise<void>> = [];
    if (config.slack.webhookUrl) {
      tasks.push(
        deliverToSlack(config.slack.webhookUrl, buildSlackPayload(report)).then((r) => {
          externalResults.push({ channel: 'slack', ...r });
        })
      );
    }
    if (config.email.resendApiKey && config.email.to.length > 0) {
      tasks.push(
        deliverEmail(config.email.resendApiKey, {
          from: config.email.from,
          to: config.email.to,
          replyTo: config.email.replyTo || undefined,
          subject: fillSubject(config.email.subject, report),
          html,
          text: markdown
        }).then((r) => {
          externalResults.push({ channel: 'email', ...r });
        })
      );
    }
    await Promise.allSettled(tasks);
  }

  for (const result of externalResults) {
    deliveryStatus[result.channel] = result.ok ? 'ok' : 'failed';
    if (result.ok) core.info(`Delivery ${result.channel}: ${result.detail}`);
    else core.error(`Delivery ${result.channel}: ${result.detail}`);
  }

  core.setOutput('delivery-status', JSON.stringify(deliveryStatus));
  core.setOutput('llm-usage', llmUsage ? JSON.stringify(llmUsage) : '');

  const configuredExternal = externalResults.length;
  const failedExternal = externalResults.filter((r) => !r.ok).length;
  if (configuredExternal > 0 && failedExternal === configuredExternal) {
    throw new ActionError('E_ALL_DELIVERIES_FAILED', 'Every configured external delivery (Slack/email) failed.', [
      'The full report is still available in the job summary and artifact.',
      ...externalResults.map((r) => `${r.channel}: ${r.detail}`)
    ]);
  }

  core.info('Report delivered. ✅');
}

run().catch((error: unknown) => {
  if (error instanceof ActionError) {
    core.setFailed(error.format());
  } else {
    core.setFailed(error instanceof Error ? `Unexpected error: ${error.stack ?? error.message}` : String(error));
  }
});
