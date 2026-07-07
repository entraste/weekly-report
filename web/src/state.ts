/**
 * Configurator state. SECURITY INVARIANT: this state never holds secret
 * VALUES — only the NAMES of the repo secrets the workflow will reference
 * (`${{ secrets.X }}`). Enforced by tests on the generators.
 */
import { signal } from '@preact/signals';
import { HIGHLIGHT_IDS, INPUT_DEFS, inputDef } from '@schema/index';
import type { HighlightId } from '@schema/index';

export type AuthMode = 'pat' | 'app';
export type LlmChoice = 'anthropic' | 'openai' | 'none';
export type Cadence = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface ConfiguratorState {
  /** owner/repo of the published action, e.g. "acme/weekly-report" */
  actionRef: string;
  actionVersion: string;
  /** target repo (owner/repo) that will host the workflow — for quick-create links */
  targetRepo: string;
  org: string;

  auth: AuthMode;
  githubTokenSecret: string;
  appIdVar: string;
  appKeySecret: string;

  cadence: Cadence;
  dayOfWeek: number; // 1=Mon..7=Sun
  hour: number;
  minute: number;
  timezone: string;
  biweeklyAnchor: 'even' | 'odd';

  language: 'en' | 'es';
  levels: { org: boolean; repo: boolean; person: boolean };
  highlights: Record<HighlightId, boolean>;
  staleThresholdDays: number;
  reposInclude: string;
  reposExclude: string;
  excludeBots: boolean;
  peopleExclude: string;
  tone: 'professional-warm' | 'neutral' | 'playful';

  llm: LlmChoice;
  anthropicSecret: string;
  openaiSecret: string;

  slackEnabled: boolean;
  slackSecret: string;
  emailEnabled: boolean;
  resendSecret: string;
  emailTo: string;
  emailFrom: string;
}

export const DEFAULT_STATE: ConfiguratorState = {
  actionRef: 'ombustudio/weekly-report',
  actionVersion: 'v1',
  targetRepo: '',
  org: '',

  auth: 'pat',
  githubTokenSecret: inputDef('github-token').suggestedSecretName ?? 'ORG_REPORT_GITHUB_TOKEN',
  appIdVar: 'REPORT_APP_ID',
  appKeySecret: 'REPORT_APP_PRIVATE_KEY',

  cadence: 'weekly',
  dayOfWeek: 1,
  hour: 9,
  minute: 17,
  timezone: 'UTC',
  biweeklyAnchor: 'even',

  language: 'en',
  levels: { org: true, repo: true, person: true },
  highlights: Object.fromEntries(HIGHLIGHT_IDS.map((id) => [id, true])) as Record<HighlightId, boolean>,
  staleThresholdDays: 7,
  reposInclude: '',
  reposExclude: '',
  excludeBots: true,
  peopleExclude: '',
  tone: 'professional-warm',

  llm: 'anthropic',
  anthropicSecret: inputDef('anthropic-api-key').suggestedSecretName ?? 'ANTHROPIC_API_KEY',
  openaiSecret: inputDef('openai-api-key').suggestedSecretName ?? 'OPENAI_API_KEY',

  slackEnabled: true,
  slackSecret: inputDef('slack-webhook-url').suggestedSecretName ?? 'SLACK_WEBHOOK_URL',
  emailEnabled: false,
  resendSecret: inputDef('resend-api-key').suggestedSecretName ?? 'RESEND_API_KEY',
  emailTo: '',
  emailFrom: ''
};

// ---------------------------------------------------------------------------
// Persistence: the form auto-saves to localStorage (config only — this state
// never holds secret VALUES, so nothing sensitive is stored). Saved data is
// re-validated on load so a stale/corrupt blob can never break the generators.
// ---------------------------------------------------------------------------
export const STORAGE_KEY = 'ombupulse-configurator-v1';

const ENUM_FIELDS: Partial<Record<keyof ConfiguratorState, readonly string[]>> = {
  auth: ['pat', 'app'],
  cadence: ['daily', 'weekly', 'biweekly', 'monthly'],
  llm: ['anthropic', 'openai', 'none'],
  language: ['en', 'es'],
  biweeklyAnchor: ['even', 'odd'],
  tone: ['professional-warm', 'neutral', 'playful']
};

export function sanitizeSaved(saved: unknown): Partial<ConfiguratorState> {
  if (typeof saved !== 'object' || saved === null) return {};
  const raw = saved as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, defVal] of Object.entries(DEFAULT_STATE as unknown as Record<string, unknown>)) {
    const val = raw[key];
    if (val === undefined || typeof val !== typeof defVal) continue;
    const allowed = ENUM_FIELDS[key as keyof ConfiguratorState];
    if (allowed && !allowed.includes(val as string)) continue;
    if (typeof defVal === 'object' && defVal !== null) {
      // Nested objects (levels, highlights): keep only known keys, matching types.
      const merged: Record<string, unknown> = { ...(defVal as Record<string, unknown>) };
      for (const k of Object.keys(merged)) {
        const v = (val as Record<string, unknown>)[k];
        if (v !== undefined && typeof v === typeof merged[k]) merged[k] = v;
      }
      out[key] = merged;
    } else {
      out[key] = val;
    }
  }
  // Numeric clamps so a hand-edited blob cannot produce an invalid cron.
  if (typeof out.hour === 'number') out.hour = Math.min(23, Math.max(0, Math.trunc(out.hour as number)));
  if (typeof out.minute === 'number') out.minute = Math.min(59, Math.max(0, Math.trunc(out.minute as number)));
  if (typeof out.dayOfWeek === 'number') out.dayOfWeek = Math.min(7, Math.max(1, Math.trunc(out.dayOfWeek as number)));
  return out as Partial<ConfiguratorState>;
}

/** Functional localStorage or null (Node exposes a stub global; browsers may block it). */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function loadSavedState(): Partial<ConfiguratorState> {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return raw ? sanitizeSaved(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export const state = signal<ConfiguratorState>({ ...DEFAULT_STATE, ...loadSavedState() });

/** True when the current state came (partly) from a previous session. */
export const restoredFromSave = ((): boolean => {
  try {
    return storage()?.getItem(STORAGE_KEY) !== null && storage() !== null;
  } catch {
    return false;
  }
})();

export function update(patch: Partial<ConfiguratorState>): void {
  state.value = { ...state.value, ...patch };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state.value));
  } catch {
    // Storage full/blocked — the form still works, it just won't persist.
  }
}

export function resetState(): void {
  state.value = { ...DEFAULT_STATE };
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** All input keys the generator may emit — used by the drift test. */
export const KNOWN_INPUT_KEYS = new Set(INPUT_DEFS.map((d) => d.key));
