/**
 * Static action.yml metadata (everything except inputs/outputs, which live in
 * inputs.ts). Consumed by the action.yml drift test and the configurator.
 */
export const ACTION_META = {
  /** Marketplace name — globally unique. */
  name: 'OmbuPulse',
  description:
    'Org-wide activity digest with an LLM-written narrative (Claude or OpenAI). ' +
    'Collects PRs, issues, reviews and commits across all org repos and delivers to Slack, ' +
    'email (Resend), the job summary and an artifact. Reports in English or Spanish.',
  author: 'punchup',
  branding: {
    // Feather icon (v4.28) from the allowed set; report-themed.
    icon: 'bar-chart-2',
    color: 'purple'
  },
  runs: { using: 'node24', main: 'dist/index.js' }
} as const;
