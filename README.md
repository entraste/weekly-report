# OmbuPulse

**Org-wide GitHub activity digest with an LLM-written narrative — delivered to Slack, email, the job summary and an artifact. Reports in English or Spanish.**

Every period (weekly by default) the action scans the repositories of your organization, computes metrics and highlights **deterministically** — the LLM never invents numbers — and uses Claude or OpenAI to write a short executive narrative on top:

- 📊 **Key numbers**: PRs opened/merged, reviews, issues, commits, lines changed, median time-to-merge, active contributors/repos.
- ✨ **Highlights** (each toggleable): oldest open PR, top merger, top reviewer, PRs awaiting first review, biggest PR, fastest review, first-time contributors, most active repo.
- 🧭 **Three cuts**: org-wide, per-repository, per-contributor (with privacy opt-outs).
- 🤖 **Narrative**: executive summary + per-repo blurbs + a team note, written by Claude (`claude-sonnet-5`) or OpenAI (`gpt-5-mini`) in `en` or `es`. No key? You still get the full metrics report.
- 📬 **Delivery**: Slack webhook (condensed Block Kit) and/or full HTML email via [Resend](https://resend.com) — plus the job summary and a downloadable artifact, always.

## Quick start

```yaml
# .github/workflows/weekly-report.yml
name: Weekly report
on:
  schedule:
    - cron: '17 9 * * 1' # Mondays 09:17 UTC
  workflow_dispatch:

permissions:
  contents: read

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: ombustudio/weekly-report@v1
        with:
          github-token: ${{ secrets.ORG_REPORT_GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

More recipes in [`examples/`](examples/), including [GitHub App auth](examples/workflow-github-app.yml) and the [full config file](examples/weekly-report.config.yml). Or use the **[web configurator](#configurator)** to generate everything.

## Authentication — read this first

> ⚠️ The default `GITHUB_TOKEN` can only see the repository running the workflow. For an **org-wide** report you must pass a token with org read access.

**Option A — org fine-grained PAT (low friction).** An org owner creates a fine-grained PAT with:

- **Resource owner**: your organization (not your user!)
- **Repository access**: All repositories
- **Permissions (read-only)**: Metadata, Pull requests, Issues, Contents

Store it as a secret (e.g. `ORG_REPORT_GITHUB_TOKEN`) and pass it as `github-token`. Mind the token's expiration date — scheduled reports stop when it expires.

**Option B — GitHub App (robust).** Not tied to a person, tokens auto-expire hourly, higher rate limits. Create an org App with the same read-only permissions, install it on all repositories, then mint a token in the workflow with [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) and `owner: your-org`. See [the example](examples/workflow-github-app.yml).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-token` | **required** | Token with org-wide read access (see above). |
| `org` | repo owner | Organization to report on. |
| `anthropic-api-key` | — | For the narrative. Pass this **or** `openai-api-key`; with neither, the report is metrics-only. |
| `openai-api-key` | — | Alternative LLM provider. |
| `llm-provider` | `auto` | `auto` \| `anthropic` \| `openai` \| `none` (auto: Anthropic wins if both keys present). |
| `model` | provider default | Model override (`claude-sonnet-5` / `gpt-5-mini` by default). |
| `language` | `en` | Report language: `en` \| `es` (narrative **and** all templates). |
| `report-levels` | `org,repo,person` | Which cuts to include. |
| `highlights` | `all` | `all`, `none`, or a comma-separated list of highlight ids. |
| `period` | `weekly` | `daily` \| `weekly` \| `biweekly` \| `monthly` \| `custom`. Window = previous **complete** calendar period in `timezone`. |
| `start-date` / `end-date` | — | `YYYY-MM-DD`. Providing **both** switches the window to that custom range — wire them to `workflow_dispatch` inputs for on-demand reports. |
| `timezone` | `UTC` | IANA timezone for window boundaries. |
| `repos-include` / `repos-exclude` | `*` / — | Repo-name globs. |
| `slack-webhook-url` | — | Slack incoming webhook. |
| `resend-api-key` | — | Resend API key for email. |
| `email-to` / `email-from` | — | Recipients (comma-separated) and verified sender. Required with `resend-api-key`. |
| `email-subject` | `{org} engineering report — {period-label}` | Placeholders: `{org}` `{start}` `{end}` `{period-label}`. |
| `config-file` | `.github/weekly-report.yml` | Optional rich config, fetched via the API (no checkout needed). |
| `dry-run` | `false` | Render + summary + artifact, but skip the LLM call and Slack/email sends. |

**Outputs**: `report-markdown-path`, `report-html-path`, `metrics-json-path`, `delivery-status` (JSON per channel), `llm-usage` (tokens + estimated cost).

## Multiple organizations

Run the action once per org with a matrix — each org gets its own token (fine-grained PATs are single-org), report, and optionally its own Slack channel and language. One org failing never cancels the others (`fail-fast: false`). Full recipe: [`examples/workflow-multi-org.yml`](examples/workflow-multi-org.yml).

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - { org: acme, token_secret: ACME_TOKEN, slack_secret: ACME_SLACK, language: en }
      - { org: globex, token_secret: GLOBEX_TOKEN, slack_secret: GLOBEX_SLACK, language: es }
steps:
  - uses: ombustudio/weekly-report@v1
    with:
      org: ${{ matrix.org }}
      github-token: ${{ secrets[matrix.token_secret] }}
      slack-webhook-url: ${{ secrets[matrix.slack_secret] }}
      language: ${{ matrix.language }}
```

> Tip: a single **classic** PAT (`repo` + `read:org`) from a user who belongs to all the orgs can power every matrix entry with one secret — coarser permissions, less setup.

## Rich configuration

Simple knobs are inputs; nested tuning lives in an optional `.github/weekly-report.yml` — highlight thresholds, bot patterns, person opt-outs, LLM tone, output caps and more. Full annotated reference: [`examples/weekly-report.config.yml`](examples/weekly-report.config.yml).

Precedence: **inputs > config file > defaults** (an input left at its default lets the file win). Unknown keys fail loudly; secret-looking keys are rejected — secrets travel only as inputs.

## Delivery details

- **Slack**: condensed summary (headline, exec summary, key numbers, top-3 highlights, link to the full report). If Slack rejects the blocks, a minimal text notification is sent instead.
- **Email**: full report as table-based HTML (Outlook-safe) with a markdown text alternative, via Resend (recipients batched ≤50). While testing you can use Resend's `onboarding@resend.dev` sender before verifying your domain.
- **Always**: full markdown in the job summary + `weekly-report` artifact (`report.md`, `report.html`, `report-data.json` — the JSON is handy for downstream tooling).
- A single failing channel doesn't fail the run; the action fails only if **every** configured external delivery fails.

## Period semantics

The window is always the **previous complete calendar period** in your timezone — reruns and cron delays never shift or double-count it. `biweekly` uses a weekly cron + fortnight parity (`biweekly-anchor: even|odd`, continuous across year boundaries); off-weeks exit successfully with a notice, and manual `workflow_dispatch` runs always produce a report.

## Security & privacy by design

- Deterministic numbers — the LLM writes prose only and is instructed to never restate figures beyond those provided.
- Prompt-injection defense: PR/issue **bodies never reach the LLM** (sanitized titles only), untrusted data is fenced, and responses containing URLs or unknown @mentions are rejected (one retry, then metrics-only).
- No surveillance metrics: no after-hours/weekend tracking, no negative individual rankings. Contributors can be opted out via `people.exclude`.
- Least privilege: the workflow needs only `permissions: contents: read`; the org token needs read-only Metadata/PRs/Issues/Contents.
- Cost transparency: token usage + estimated USD in the appendix and the `llm-usage` output (typical week: a few cents).

## Configurator

A static web configurator (GitHub Pages) generates your workflow YAML + config file from a form — including auth path (PAT vs GitHub App), schedule builder, language and delivery setup. It never sees your secrets: it only emits `${{ secrets.X }}` references plus a checklist of secrets to create.

→ **https://ombustudio.github.io/weekly-report/** (after enabling Pages on this repo)

## Development

```bash
npm ci
npm run check   # typecheck + lint + tests + build
```

`action.yml` is generated from `src/schema/` (`npx tsx scripts/gen-action-yml.ts`); a drift test keeps them in sync. `dist/` is committed and CI-gated.

### Release & Marketplace checklist

1. `npm run check` green, `dist/` committed.
2. Tag: `git tag v1.0.0 && git push origin v1.0.0` — `release.yml` creates the GitHub release and force-moves the floating `v1` tag (plain tag, immutable-releases friendly).
3. First publish (manual, once): repo → Releases → edit the release → tick **“Publish this Action to the GitHub Marketplace”**, pick categories (suggested: *Reporting*, *Project management*), verify the marketplace name (OmbuPulse), publish. Requires 2FA and a public repo.
4. Repeat the checkbox on subsequent releases (no API exists for it).

## License

MIT
