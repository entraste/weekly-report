/**
 * Data collection: repo enumeration → period-bounded searches → batched
 * per-repo stats. Budget for a 200-repo org and a 1-week window: ~5-15 search
 * calls + 2-4 GraphQL batches — far inside every rate limit.
 */
import { ActionError } from '../errors.js';
import type { ResolvedConfig } from '../schema/index.js';
import { matchesAny } from '../util/globs.js';
import type { ReportWindow } from '../util/time.js';
import { toSearchTimestamp } from '../util/time.js';
import type { GitHubClient } from './client.js';
import { SEARCH_ISSUES_QUERY, SEARCH_PRS_QUERY, buildRepoStatsQuery, searchQualifiers } from './queries.js';
import type { CollectedData, IssueLite, PrLite, RepoInfo } from './types.js';

const SEARCH_PAGE_SIZE = 100;
/** Search hard cap; beyond this a query must be partitioned (M8) or fails loudly. */
const SEARCH_RESULT_CAP = 1000;
/** How many currently-open PRs we fetch in detail (oldest first). */
const OPEN_PR_FETCH_CAP = 200;
const REPO_STATS_BATCH = 100;

interface GraphQlPrNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  additions: number;
  deletions: number;
  authorAssociation: string;
  author: { login: string } | null;
  mergedBy: { login: string } | null;
  repository: { name: string };
  reviews: {
    totalCount: number;
    nodes: Array<{ author: { login: string } | null; state: string; submittedAt: string | null }>;
  };
}

interface GraphQlIssueNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
  author: { login: string } | null;
  repository: { name: string };
}

interface SearchPage<T> {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: T[];
  };
}

function toPrLite(node: GraphQlPrNode): PrLite {
  return {
    repo: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? 'ghost',
    authorAssociation: node.authorAssociation,
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    mergedBy: node.mergedBy?.login ?? null,
    reviewsTotal: node.reviews.totalCount,
    reviews: node.reviews.nodes
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({
        author: r.author?.login ?? 'ghost',
        state: r.state as PrLite['reviews'][number]['state'],
        submittedAt: r.submittedAt
      }))
  };
}

function toIssueLite(node: GraphQlIssueNode): IssueLite {
  return {
    repo: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? 'ghost',
    createdAt: node.createdAt,
    closedAt: node.closedAt
  };
}

async function searchAll<T>(
  client: GitHubClient,
  query: string,
  qualifier: string,
  opts: { fetchCap?: number; label: string; warnings: string[] }
): Promise<{ nodes: T[]; totalCount: number }> {
  const nodes: T[] = [];
  let after: string | null = null;
  let totalCount = 0;
  const cap = opts.fetchCap ?? SEARCH_RESULT_CAP;

  for (;;) {
    const page: SearchPage<T> = await client.graphql<SearchPage<T>>(query, {
      q: qualifier,
      first: Math.min(SEARCH_PAGE_SIZE, cap - nodes.length),
      after
    });
    totalCount = page.search.issueCount;

    if (totalCount > SEARCH_RESULT_CAP && (opts.fetchCap ?? SEARCH_RESULT_CAP) >= SEARCH_RESULT_CAP) {
      throw new ActionError(
        'E_SEARCH_CAP',
        `Search "${opts.label}" matched ${totalCount} items — beyond GitHub's 1000-result cap.`,
        [
          'Narrow the window (shorter period) or exclude high-churn repos with repos-exclude.',
          'Automatic date-partitioning for large orgs is on the roadmap.'
        ]
      );
    }

    // GraphQL search can return empty non-PR/Issue nodes ({}) — drop them.
    nodes.push(...page.search.nodes.filter((n) => n && Object.keys(n as object).length > 0));

    if (!page.search.pageInfo.hasNextPage || nodes.length >= cap) {
      if (page.search.pageInfo.hasNextPage && nodes.length >= cap) {
        opts.warnings.push(
          `${opts.label}: fetched first ${nodes.length} of ${totalCount} results (detail cap).`
        );
      }
      return { nodes, totalCount };
    }
    after = page.search.pageInfo.endCursor;
  }
}

export async function listOrgRepos(
  client: GitHubClient,
  config: ResolvedConfig,
  warnings: string[]
): Promise<RepoInfo[]> {
  let raw: Array<{ name: string; archived: boolean; fork: boolean; private: boolean }>;
  try {
    const pages = await client.paginate('GET /orgs/{org}/repos', {
      org: config.org,
      per_page: 100,
      sort: 'pushed',
      direction: 'desc'
    });
    raw = pages.map((r) => ({
      name: r.name,
      archived: Boolean(r.archived),
      fork: Boolean(r.fork),
      private: Boolean(r.private)
    }));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      throw new ActionError('E_ORG_NOT_FOUND', `Organization "${config.org}" was not found or is not visible to this token.`, [
        'Check the org input for typos.',
        'The default GITHUB_TOKEN cannot see the org — pass an org fine-grained PAT (All repositories: Metadata, Pull requests, Issues, Contents — read) or a GitHub App token.',
        'For fine-grained PATs the ORG must be the resource owner, and an org admin may need to approve the token.'
      ]);
    }
    if (status === 401 || status === 403) {
      throw new ActionError('E_TOKEN_SCOPE', `GitHub rejected the token for org "${config.org}" (HTTP ${status}).`, [
        'Verify the token has not expired and has read access to org repositories.'
      ]);
    }
    throw error;
  }

  const filtered = raw
    .filter((r) => !(config.repos.skipArchived && r.archived))
    .filter((r) => !(config.repos.skipForks && r.fork))
    .filter((r) => matchesAny(r.name, config.repos.include))
    .filter((r) => !matchesAny(r.name, config.repos.exclude));

  if (filtered.length === 0) {
    throw new ActionError('E_BAD_INPUT', `No repositories left after filtering (org has ${raw.length} visible).`, [
      `include globs: ${config.repos.include.join(', ')} — exclude globs: ${config.repos.exclude.join(', ') || '(none)'}`
    ]);
  }

  let capped = filtered;
  if (filtered.length > config.limits.maxRepos) {
    capped = filtered.slice(0, config.limits.maxRepos);
    warnings.push(
      `Org has ${filtered.length} matching repos; limited to the ${config.limits.maxRepos} most recently pushed (limits.max-repos).`
    );
  }

  return capped.map((r) => ({ name: r.name, archived: r.archived, fork: r.fork, isPrivate: r.private }));
}

async function collectRepoStats(
  client: GitHubClient,
  org: string,
  repoNames: string[],
  window: ReportWindow,
  warnings: string[]
): Promise<{ commitsByRepo: Record<string, number>; openPrCountByRepo: Record<string, number> }> {
  const commitsByRepo: Record<string, number> = {};
  const openPrCountByRepo: Record<string, number> = {};

  for (let i = 0; i < repoNames.length; i += REPO_STATS_BATCH) {
    const batch = repoNames.slice(i, i + REPO_STATS_BATCH);
    const query = buildRepoStatsQuery(org, batch);
    type RepoStatsResult = Record<
      string,
      {
        name: string;
        pullRequests: { totalCount: number };
        defaultBranchRef: { target: { history: { totalCount: number } } | null } | null;
      } | null
    >;
    let result: RepoStatsResult;
    try {
      result = await client.graphql<RepoStatsResult>(query, {
        since: new Date(window.startUtcMs).toISOString(),
        until: new Date(window.endUtcMs).toISOString()
      });
    } catch (error) {
      // GraphQL "errors" responses may still carry partial data (e.g. SAML-gated repos).
      const partial = (error as { data?: RepoStatsResult }).data;
      if (!partial) throw error;
      warnings.push('Some repositories could not be read for commit counts (partial GraphQL response).');
      result = partial;
    }

    for (const value of Object.values(result)) {
      if (!value) continue;
      openPrCountByRepo[value.name] = value.pullRequests.totalCount;
      commitsByRepo[value.name] = value.defaultBranchRef?.target?.history.totalCount ?? 0;
    }
  }

  return { commitsByRepo, openPrCountByRepo };
}

export async function collect(
  client: GitHubClient,
  config: ResolvedConfig,
  window: ReportWindow
): Promise<CollectedData> {
  const warnings: string[] = [];
  const repos = await listOrgRepos(client, config, warnings);
  const repoNames = new Set(repos.map((r) => r.name));

  const startIso = toSearchTimestamp(window.startUtcMs);
  // Search ranges are inclusive on both ends; subtract 1s from the exclusive bound.
  const endIso = toSearchTimestamp(window.endUtcMs - 1000);
  const q = searchQualifiers(config.org, startIso, endIso);

  const [prsOpenedRes, prsMergedRes, issuesOpenedRes, issuesClosedRes, openPrsRes] = [
    await searchAll<GraphQlPrNode>(client, SEARCH_PRS_QUERY, q.prsOpened, { label: 'PRs opened', warnings }),
    await searchAll<GraphQlPrNode>(client, SEARCH_PRS_QUERY, q.prsMerged, { label: 'PRs merged', warnings }),
    await searchAll<GraphQlIssueNode>(client, SEARCH_ISSUES_QUERY, q.issuesOpened, {
      label: 'Issues opened',
      warnings
    }),
    await searchAll<GraphQlIssueNode>(client, SEARCH_ISSUES_QUERY, q.issuesClosed, {
      label: 'Issues closed',
      warnings
    }),
    await searchAll<GraphQlPrNode>(client, SEARCH_PRS_QUERY, q.openPrs, {
      label: 'Open PRs',
      warnings,
      fetchCap: OPEN_PR_FETCH_CAP
    })
  ];

  // Search is org-wide; drop anything from repos filtered out by globs/skips.
  const inScope = <T extends { repo: string }>(items: T[]): T[] => items.filter((x) => repoNames.has(x.repo));

  const { commitsByRepo, openPrCountByRepo } = await collectRepoStats(
    client,
    config.org,
    repos.map((r) => r.name),
    window,
    warnings
  );

  return {
    org: config.org,
    window,
    repos,
    prsOpened: inScope(prsOpenedRes.nodes.map(toPrLite)),
    prsMerged: inScope(prsMergedRes.nodes.map(toPrLite)),
    openPrs: inScope(openPrsRes.nodes.map(toPrLite)),
    openPrTotalCount: openPrsRes.totalCount,
    issuesOpened: inScope(issuesOpenedRes.nodes.map(toIssueLite)),
    issuesClosed: inScope(issuesClosedRes.nodes.map(toIssueLite)),
    commitsByRepo,
    openPrCountByRepo,
    warnings
  };
}
