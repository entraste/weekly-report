/**
 * GraphQL documents for collection.
 *
 * Search strategy (frozen at design time): GitHub Search for period-bounded
 * sets — the qualifiers MUST include `is:pr` / `is:issue` (advanced-search
 * requirement since Sept 2025) and use full ISO-8601 UTC timestamps so window
 * boundaries respect the configured timezone. PR nodes carry everything the
 * metrics stage needs (mergedBy, reviews, authorAssociation) so there is no
 * REST N+1 anywhere.
 */

export const PR_FRAGMENT = `
fragment PrFields on PullRequest {
  number
  title
  url
  createdAt
  mergedAt
  closedAt
  isDraft
  additions
  deletions
  authorAssociation
  author { login }
  mergedBy { login }
  repository { name }
  reviews(first: 50) {
    totalCount
    nodes {
      author { login }
      state
      submittedAt
    }
  }
}`;

export const SEARCH_PRS_QUERY = `
${PR_FRAGMENT}
query SearchPrs($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ...PrFields }
  }
}`;

export const SEARCH_ISSUES_QUERY = `
query SearchIssues($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        url
        createdAt
        closedAt
        author { login }
        repository { name }
      }
    }
  }
}`;

/**
 * Batched per-repo stats: default-branch commit count in the window + exact
 * open-PR count. Repos are aliased r0..rN (~100 per query, 1-2 pages for a
 * 200-repo org).
 */
export function buildRepoStatsQuery(org: string, repoNames: string[]): string {
  const fields = repoNames
    .map(
      (name, i) => `
  r${i}: repository(owner: ${JSON.stringify(org)}, name: ${JSON.stringify(name)}) {
    name
    pullRequests(states: OPEN) { totalCount }
    defaultBranchRef {
      target {
        ... on Commit {
          history(since: $since, until: $until) { totalCount }
        }
      }
    }
  }`
    )
    .join('\n');
  return `query RepoStats($since: GitTimestamp!, $until: GitTimestamp!) {${fields}\n}`;
}

/** Search qualifier strings (window bounds are full UTC timestamps). */
export function searchQualifiers(org: string, startIso: string, endIso: string) {
  const range = `${startIso}..${endIso}`;
  return {
    prsOpened: `org:${org} is:pr created:${range}`,
    prsMerged: `org:${org} is:pr is:merged merged:${range}`,
    issuesOpened: `org:${org} is:issue created:${range}`,
    issuesClosed: `org:${org} is:issue closed:${range}`,
    openPrs: `org:${org} is:pr is:open sort:created-asc`
  };
}
