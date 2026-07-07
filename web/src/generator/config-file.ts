/**
 * Optional .github/weekly-report.yml generator — emitted only when the state
 * carries settings that can't be expressed as simple workflow inputs
 * (per-highlight params, bot/person exclusions, tone, biweekly anchor).
 * The output must round-trip through the action's own configFileSchema
 * (asserted by tests).
 */
import { stringify } from 'yaml';
import { HIGHLIGHT_DEFAULTS } from '@schema/index';
import type { ConfiguratorState } from '../state.js';

export function buildConfigObject(state: ConfiguratorState): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (state.cadence === 'biweekly' && state.biweeklyAnchor !== 'even') {
    config['biweekly-anchor'] = state.biweeklyAnchor;
  }

  if (state.staleThresholdDays !== HIGHLIGHT_DEFAULTS['stale-prs'].params.thresholdDays && state.highlights['stale-prs']) {
    config.highlights = {
      'stale-prs': { 'threshold-days': state.staleThresholdDays }
    };
  }

  if (!state.listMergedPrs) {
    config.report = { 'list-merged-prs': false };
  }

  const people: Record<string, unknown> = {};
  if (!state.excludeBots) people['exclude-bots'] = false;
  const excluded = state.peopleExclude
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (excluded.length > 0) people.exclude = excluded;
  if (Object.keys(people).length > 0) config.people = people;

  if (state.tone !== 'professional-warm') {
    config.llm = { tone: state.tone };
  }

  return config;
}

export function needsConfigFile(state: ConfiguratorState): boolean {
  return Object.keys(buildConfigObject(state)).length > 0;
}

export function generateConfigFile(state: ConfiguratorState): string {
  const header =
    '# Rich configuration for Org Weekly Report (AI) — every key optional.\n' +
    '# Secrets NEVER go in this file; pass them as action inputs.\n';
  return header + stringify(buildConfigObject(state));
}
