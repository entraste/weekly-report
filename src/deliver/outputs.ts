/**
 * Local outputs: report files on disk, GitHub job summary, and the artifact.
 * These are "free" deliveries that always run (subject to output.* config).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import type { Report } from '../metrics/types.js';
import type { DeliveryResult } from './slack.js';

export interface ReportFiles {
  dir: string;
  markdownPath: string;
  htmlPath: string;
  dataPath: string;
}

export function writeReportFiles(markdown: string, html: string, report: Report): ReportFiles {
  const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'weekly-report');
  mkdirSync(dir, { recursive: true });

  const markdownPath = join(dir, 'report.md');
  const htmlPath = join(dir, 'report.html');
  const dataPath = join(dir, 'report-data.json');

  writeFileSync(markdownPath, markdown);
  writeFileSync(htmlPath, html);
  writeFileSync(
    dataPath,
    JSON.stringify(
      {
        org: report.org,
        window: report.window,
        orgMetrics: report.orgMetrics,
        repoMetrics: report.repoMetrics,
        personMetrics: report.personMetrics,
        highlights: report.highlights,
        narrativeStatus: report.narrativeStatus,
        llmUsage: report.llmUsage,
        warnings: report.warnings
      },
      null,
      2
    )
  );

  return { dir, markdownPath, htmlPath, dataPath };
}

export async function writeJobSummary(markdown: string): Promise<DeliveryResult> {
  try {
    await core.summary.addRaw(markdown).write();
    return { ok: true, detail: 'ok' };
  } catch (error) {
    return { ok: false, detail: `Job summary failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function uploadReportArtifact(name: string, files: ReportFiles): Promise<DeliveryResult> {
  try {
    const client = new DefaultArtifactClient();
    const response = await client.uploadArtifact(name, [files.markdownPath, files.htmlPath, files.dataPath], files.dir);
    return { ok: true, detail: `ok (artifact id ${response.id ?? 'n/a'})` };
  } catch (error) {
    return { ok: false, detail: `Artifact upload failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
