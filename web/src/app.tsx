/**
 * Configurator UI — a single-page form (left) driving live YAML previews
 * (right). No backend, no persistence: secrets are referenced by NAME only.
 */
import { useComputed, useSignal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { HIGHLIGHT_IDS } from '@schema/index';
import type { HighlightId } from '@schema/index';
import { generateConfigFile, needsConfigFile } from './generator/config-file.js';
import { lint } from './generator/lint.js';
import { secretsChecklist } from './generator/secrets.js';
import { generateWorkflow } from './generator/workflow.js';
import { state, update } from './state.js';
import type { Cadence, ConfiguratorState } from './state.js';

const HIGHLIGHT_LABELS: Record<HighlightId, string> = {
  'oldest-open-pr': '🕰️ Oldest open PR',
  'top-merger': '🚢 Top merger',
  'top-reviewer': '🔍 Top reviewer',
  'stale-prs': '🧊 PRs awaiting review',
  'biggest-pr': '🐘 Biggest PR merged',
  'fastest-review': '⚡ Fastest first review',
  'first-time-contributors': '🎉 First-time contributors',
  'most-active-repo': '🔥 Most active repo'
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  // div, not label: several fields wrap multiple controls (toggles, segments)
  // and a shared <label> would misdirect clicks to the first control.
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </div>
  );
}

function TextInput(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      class={props.mono ? 'mono' : ''}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
    />
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function Segmented<T extends string>(props: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented">
      {props.options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={props.value === opt.value}
          class={props.value === opt.value ? 'active' : ''}
          onClick={() => props.onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Section(props: { step: number; title: string; children: ComponentChildren }) {
  return (
    <section class="card">
      <h2>
        <span class="step">{props.step}</span> {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function CopyButton(props: { text: string; label?: string }) {
  const copied = useSignal(false);
  return (
    <button
      type="button"
      class="btn"
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          copied.value = true;
          setTimeout(() => (copied.value = false), 1500);
        });
      }}
    >
      {copied.value ? '✓ Copied' : (props.label ?? 'Copy')}
    </button>
  );
}

function quickCreateUrl(targetRepo: string, filename: string, content: string): string | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) return null;
  const url = `https://github.com/${targetRepo}/new/main?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(content)}`;
  return url.length > 8000 ? null : url;
}

export function App() {
  const s = state;
  const workflowYaml = useComputed(() => generateWorkflow(s.value));
  const configYaml = useComputed(() => (needsConfigFile(s.value) ? generateConfigFile(s.value) : null));
  const warnings = useComputed(() => lint(s.value));
  const secrets = useComputed(() => secretsChecklist(s.value));
  const tab = useSignal<'workflow' | 'config' | 'secrets'>('workflow');

  const set = (patch: Partial<ConfiguratorState>) => update(patch);
  const v = s.value;
  // A stale Config tab (settings changed so no file is needed) falls back to
  // the workflow view instead of rendering an empty panel.
  const activeTab = tab.value === 'config' && !configYaml.value ? 'workflow' : tab.value;

  return (
    <div class="layout">
      <header class="hero">
        <h1>
          OmbuPulse <span class="ai-badge">AI</span>
        </h1>
        <p>
          Configure the GitHub Action that turns your org's activity into a narrated report — Slack, email, English or
          Spanish. This page generates YAML only; <strong>your secrets never leave GitHub</strong>.
        </p>
      </header>

      <main class="columns">
        <div class="form-column">
          <Section step={1} title="Action & organization">
            <Field label="Published action (owner/repo)" hint="Where this action lives once published to the Marketplace.">
              <TextInput mono value={v.actionRef} onInput={(x) => set({ actionRef: x })} placeholder="ombustudio/weekly-report" />
            </Field>
            <Field label="Target repo for the workflow (optional)" hint="Enables one-click 'Create in GitHub' links (assumes the default branch is main).">
              <TextInput mono value={v.targetRepo} onInput={(x) => set({ targetRepo: x })} placeholder="acme/reports" />
            </Field>
            <Field label="Organization to report on" hint="Empty = the owner of the repo running the workflow.">
              <TextInput mono value={v.org} onInput={(x) => set({ org: x })} placeholder="acme" />
            </Field>
          </Section>

          <Section step={2} title="GitHub access">
            <Segmented
              value={v.auth}
              onChange={(auth) => set({ auth })}
              options={[
                { value: 'pat', label: 'Fine-grained PAT (simple)' },
                { value: 'app', label: 'GitHub App (robust)' }
              ]}
            />
            <p class="note">
              ⚠️ The default <code>GITHUB_TOKEN</code> only sees one repo. Org-wide reports need an org PAT
              (read-only: Metadata, Pull requests, Issues, Contents — all repositories) or a GitHub App.
            </p>
            {v.auth === 'pat' ? (
              <Field label="Secret name for the PAT">
                <TextInput mono value={v.githubTokenSecret} onInput={(x) => set({ githubTokenSecret: x })} />
              </Field>
            ) : (
              <>
                <Field label="Variable name for the App ID">
                  <TextInput mono value={v.appIdVar} onInput={(x) => set({ appIdVar: x })} />
                </Field>
                <Field label="Secret name for the App private key">
                  <TextInput mono value={v.appKeySecret} onInput={(x) => set({ appKeySecret: x })} />
                </Field>
              </>
            )}
          </Section>

          <Section step={3} title="Schedule & period">
            <Segmented
              value={v.cadence}
              onChange={(cadence: Cadence) => set({ cadence })}
              options={[
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'biweekly', label: 'Biweekly' },
                { value: 'monthly', label: 'Monthly' }
              ]}
            />
            <div class="row">
              {(v.cadence === 'weekly' || v.cadence === 'biweekly') && (
                <Field label="Day">
                  <select
                    value={String(v.dayOfWeek)}
                    onChange={(e) => set({ dayOfWeek: Number((e.target as HTMLSelectElement).value) })}
                  >
                    {DAY_NAMES.map((d, i) => (
                      <option key={d} value={String(i + 1)}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Time (UTC)" hint="GitHub cron always fires in UTC.">
                <div class="time-row">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={v.hour}
                    onInput={(e) => set({ hour: Math.min(23, Math.max(0, Number((e.target as HTMLInputElement).value) || 0)) })}
                  />
                  <span>:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={v.minute}
                    onInput={(e) => set({ minute: Math.min(59, Math.max(0, Number((e.target as HTMLInputElement).value) || 0)) })}
                  />
                </div>
              </Field>
              <Field label="Report timezone" hint="Window boundaries + displayed dates.">
                <TextInput mono value={v.timezone} onInput={(x) => set({ timezone: x })} placeholder="America/Montevideo" />
              </Field>
            </div>
            {v.cadence === 'biweekly' && (
              <Field label="Biweekly anchor" hint="Run on even or odd ISO weeks.">
                <Segmented
                  value={v.biweeklyAnchor}
                  onChange={(biweeklyAnchor) => set({ biweeklyAnchor })}
                  options={[
                    { value: 'even', label: 'Even weeks' },
                    { value: 'odd', label: 'Odd weeks' }
                  ]}
                />
              </Field>
            )}
          </Section>

          <Section step={4} title="Report content">
            <Field label="Language">
              <Segmented
                value={v.language}
                onChange={(language) => set({ language })}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'es', label: 'Español' }
                ]}
              />
            </Field>
            <Field label="Report levels">
              <div class="toggles">
                <Toggle checked={v.levels.org} onChange={(x) => set({ levels: { ...v.levels, org: x } })} label="Org summary" />
                <Toggle checked={v.levels.repo} onChange={(x) => set({ levels: { ...v.levels, repo: x } })} label="Per repository" />
                <Toggle
                  checked={v.levels.person}
                  onChange={(x) => set({ levels: { ...v.levels, person: x } })}
                  label="Per contributor"
                />
              </div>
            </Field>
            <Field label="Highlights">
              <div class="toggles grid2">
                {HIGHLIGHT_IDS.map((id) => (
                  <Toggle
                    key={id}
                    checked={v.highlights[id]}
                    onChange={(x) => set({ highlights: { ...v.highlights, [id]: x } })}
                    label={HIGHLIGHT_LABELS[id]}
                  />
                ))}
              </div>
            </Field>
            {v.highlights['stale-prs'] && (
              <Field label="'Awaiting review' threshold (days)">
                <input
                  type="number"
                  min={1}
                  value={v.staleThresholdDays}
                  onInput={(e) => set({ staleThresholdDays: Number((e.target as HTMLInputElement).value) || 7 })}
                />
              </Field>
            )}
            <div class="row">
              <Field label="Include repos (globs)" hint="Empty = all repos.">
                <TextInput mono value={v.reposInclude} onInput={(x) => set({ reposInclude: x })} placeholder="api-*, web" />
              </Field>
              <Field label="Exclude repos (globs)">
                <TextInput mono value={v.reposExclude} onInput={(x) => set({ reposExclude: x })} placeholder="*-archive" />
              </Field>
            </div>
            <div class="row">
              <Field label="Tone">
                <select value={v.tone} onChange={(e) => set({ tone: (e.target as HTMLSelectElement).value as ConfiguratorState['tone'] })}>
                  <option value="professional-warm">Professional · warm</option>
                  <option value="neutral">Neutral</option>
                  <option value="playful">Playful</option>
                </select>
              </Field>
              <Field label="Exclude people (privacy opt-out)" hint="Comma-separated logins.">
                <TextInput mono value={v.peopleExclude} onInput={(x) => set({ peopleExclude: x })} placeholder="octocat" />
              </Field>
            </div>
            <Toggle checked={v.excludeBots} onChange={(x) => set({ excludeBots: x })} label="Exclude bots from contributor stats" />
          </Section>

          <Section step={5} title="LLM narrative">
            <Segmented
              value={v.llm}
              onChange={(llm) => set({ llm })}
              options={[
                { value: 'anthropic', label: 'Claude (Anthropic)' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'none', label: 'No narrative' }
              ]}
            />
            {v.llm === 'anthropic' && (
              <Field label="Secret name for the Anthropic key">
                <TextInput mono value={v.anthropicSecret} onInput={(x) => set({ anthropicSecret: x })} />
              </Field>
            )}
            {v.llm === 'openai' && (
              <Field label="Secret name for the OpenAI key">
                <TextInput mono value={v.openaiSecret} onInput={(x) => set({ openaiSecret: x })} />
              </Field>
            )}
          </Section>

          <Section step={6} title="Delivery">
            <Toggle checked={v.slackEnabled} onChange={(x) => set({ slackEnabled: x })} label="Slack (incoming webhook)" />
            {v.slackEnabled && (
              <Field label="Secret name for the webhook URL">
                <TextInput mono value={v.slackSecret} onInput={(x) => set({ slackSecret: x })} />
              </Field>
            )}
            <Toggle checked={v.emailEnabled} onChange={(x) => set({ emailEnabled: x })} label="Email (via Resend)" />
            {v.emailEnabled && (
              <>
                <Field label="Secret name for the Resend key">
                  <TextInput mono value={v.resendSecret} onInput={(x) => set({ resendSecret: x })} />
                </Field>
                <div class="row">
                  <Field label="Recipients (comma-separated)">
                    <TextInput mono value={v.emailTo} onInput={(x) => set({ emailTo: x })} placeholder="team@acme.dev" />
                  </Field>
                  <Field label="From (verified sender)">
                    <TextInput
                      mono
                      value={v.emailFrom}
                      onInput={(x) => set({ emailFrom: x })}
                      placeholder="Reports <reports@acme.dev>"
                    />
                  </Field>
                </div>
              </>
            )}
          </Section>
        </div>

        <div class="output-column">
          <div class="output-panel">
            {warnings.value.length > 0 && (
              <div class="warnings">
                {warnings.value.map((w, i) => (
                  <div key={i} class={`warning ${w.level}`}>
                    {w.level === 'error' ? '✖' : w.level === 'warn' ? '⚠' : 'ℹ'} {w.message}
                  </div>
                ))}
              </div>
            )}

            <div class="tabs">
              <button type="button" class={tab.value === 'workflow' ? 'active' : ''} onClick={() => (tab.value = 'workflow')}>
                Workflow
              </button>
              <button
                type="button"
                class={tab.value === 'config' ? 'active' : ''}
                onClick={() => (tab.value = 'config')}
                disabled={!configYaml.value}
                title={configYaml.value ? '' : 'No config file needed with the current settings'}
              >
                Config file{configYaml.value ? '' : ' —'}
              </button>
              <button type="button" class={tab.value === 'secrets' ? 'active' : ''} onClick={() => (tab.value = 'secrets')}>
                Secrets ({secrets.value.length})
              </button>
            </div>

            {activeTab === 'workflow' && (
              <div class="output">
                <div class="output-actions">
                  <span class="filename mono">.github/workflows/weekly-report.yml</span>
                  <CopyButton text={workflowYaml.value} />
                  {quickCreateUrl(v.targetRepo, '.github/workflows/weekly-report.yml', workflowYaml.value) && (
                    <a
                      class="btn primary"
                      target="_blank"
                      rel="noopener"
                      href={quickCreateUrl(v.targetRepo, '.github/workflows/weekly-report.yml', workflowYaml.value)!}
                    >
                      Create in GitHub ↗
                    </a>
                  )}
                </div>
                <pre>{workflowYaml.value}</pre>
              </div>
            )}

            {activeTab === 'config' && configYaml.value && (
              <div class="output">
                <div class="output-actions">
                  <span class="filename mono">.github/weekly-report.yml</span>
                  <CopyButton text={configYaml.value} />
                  {quickCreateUrl(v.targetRepo, '.github/weekly-report.yml', configYaml.value) && (
                    <a
                      class="btn primary"
                      target="_blank"
                      rel="noopener"
                      href={quickCreateUrl(v.targetRepo, '.github/weekly-report.yml', configYaml.value)!}
                    >
                      Create in GitHub ↗
                    </a>
                  )}
                </div>
                <pre>{configYaml.value}</pre>
              </div>
            )}

            {activeTab === 'secrets' && (
              <div class="output secrets-list">
                <p class="note">
                  Create these in the target repo: <em>Settings → Secrets and variables → Actions</em>. This page never
                  sees the values.
                </p>
                {secrets.value.map((item) => (
                  <div key={item.name} class="secret-item">
                    <div class="secret-head">
                      <code>{item.name}</code>
                      <span class={`chip ${item.kind}`}>{item.kind}</span>
                    </div>
                    <p>{item.what}</p>
                    <p class="how">{item.how}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer>
        <p>
          Generated files reference secrets by name only — values stay in GitHub. · Cron fires in UTC and is best-effort.
          · <a href="https://github.com/ombustudio/weekly-report">Action source &amp; docs</a>
        </p>
      </footer>
    </div>
  );
}
