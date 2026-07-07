/**
 * GitHub deep links for the output panel. The page never holds credentials,
 * so "actions" are one-click jumps into GitHub's own UI:
 *  - quickCreateUrl: new-file editor prefilled with the generated content
 *  - editUrl: editor for the EXISTING file (paste over + commit = save changes)
 *  - runWorkflowUrl: the workflow's Actions page, where GitHub shows the
 *    "Run workflow" button (workflow_dispatch)
 */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const MAX_URL_LENGTH = 8000;

export const WORKFLOW_FILENAME = '.github/workflows/weekly-report.yml';
export const CONFIG_FILENAME = '.github/weekly-report.yml';

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

export function quickCreateUrl(repo: string, filename: string, content: string): string | null {
  if (!isValidRepo(repo)) return null;
  const url = `https://github.com/${repo}/new/main?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(content)}`;
  return url.length > MAX_URL_LENGTH ? null : url;
}

export function editUrl(repo: string, filename: string): string | null {
  if (!isValidRepo(repo)) return null;
  return `https://github.com/${repo}/edit/main/${filename}`;
}

export function runWorkflowUrl(repo: string): string | null {
  if (!isValidRepo(repo)) return null;
  const workflowBasename = WORKFLOW_FILENAME.split('/').pop()!;
  return `https://github.com/${repo}/actions/workflows/${workflowBasename}`;
}
