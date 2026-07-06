/**
 * Optional rich config: .github/weekly-report.yml fetched via the Contents
 * API (release-drafter pattern — no checkout needed).
 *
 * Security: secrets travel ONLY through inputs. Any key in the file matching
 * SECRET_KEY_PATTERN is rejected (warn + ignore the key). Unknown keys fail
 * loudly via the strict zod schema so typos never silently no-op.
 */
import { parse } from 'yaml';
import { ActionError } from '../errors.js';
import type { GitHubClient } from '../github/client.js';
import { SECRET_KEY_PATTERN, configFileSchema } from '../schema/index.js';
import type { ConfigFile } from '../schema/index.js';

export interface FileConfigResult {
  config?: ConfigFile;
  warnings: string[];
}

/** Recursively drop secret-looking keys, collecting warnings. */
export function stripSecretKeys(value: unknown, path: string, warnings: string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => stripSecretKeys(v, `${path}[${i}]`, warnings));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      warnings.push(`Config file: ignored key "${path ? `${path}.` : ''}${key}" — secrets must be passed as action inputs, never in the config file.`);
      continue;
    }
    out[key] = stripSecretKeys(v, path ? `${path}.${key}` : key, warnings);
  }
  return out;
}

export function parseConfigFile(yamlText: string, sourcePath: string): FileConfigResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    throw new ActionError('E_CONFIG_FILE', `Could not parse ${sourcePath} as YAML.`, [
      error instanceof Error ? error.message : String(error)
    ]);
  }
  if (raw === null || raw === undefined) return { warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ActionError('E_CONFIG_FILE', `${sourcePath} must be a YAML mapping at the top level.`);
  }

  const cleaned = stripSecretKeys(raw, '', warnings);
  const result = configFileSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ActionError('E_CONFIG_FILE', `${sourcePath} failed validation.`, issues);
  }
  return { config: result.data, warnings };
}

/**
 * Fetch the config file from the repo running the workflow. A missing file is
 * fine (all defaults); a present-but-invalid file fails loudly.
 */
export async function fetchConfigFile(
  client: GitHubClient,
  repository: string, // "owner/repo" from GITHUB_REPOSITORY
  path: string
): Promise<FileConfigResult> {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return { warnings: [`Could not parse repository "${repository}"; skipping config file.`] };

  try {
    const response = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
      headers: { accept: 'application/vnd.github.raw+json' }
    });
    const yamlText = typeof response.data === 'string' ? response.data : '';
    return parseConfigFile(yamlText, path);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return { warnings: [] }; // no config file — defaults apply
    throw error;
  }
}
