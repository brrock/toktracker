import { argv } from "node:process";

const COMMIT_REFERENCE = /\(\[(?<hash>[0-9a-f]{7,})\]\((?<url>[^)]+)\)\)/u;
const PULL_REQUEST_REFERENCE =
  /\(\[#(?<number>\d+)\]\((?<url>[^)]+\/pull\/(?<pullNumber>\d+))\)\)/u;
const GITHUB_NOREPLY_EMAIL =
  /(?:\d+\+)?(?<username>[^@]+)@users\.noreply\.github\.com$/u;
const RELEASE_HEADER = /^## v(?<version>\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)$/mu;
const COMPARE_CHANGES = /\n\[compare changes\]\([^)]+\)\n/u;
const GITHUB_REPOSITORY_URL =
  /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/(?:commit|pull)\//u;
const CURSOR_AGENT_MARKER = "CURSOR_AGENT_PR_BODY_BEGIN";

const githubAuthorCache = new Map<string, string | undefined>();
const githubValueCache = new Map<string, string | undefined>();
const pullRequestMarkerCache = new Map<string, string | undefined>();

const changelogPath = argv.at(2);
if (!changelogPath) {
  throw new Error(
    "Usage: bun scripts/add-changelog-authors.ts <changelog-path>"
  );
}

const contributorForCommit = (hash: string): string | undefined => {
  const result = Bun.spawnSync({
    cmd: ["git", "show", "-s", "--format=%an%n%ae", hash],
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const [name, email] = new TextDecoder()
    .decode(result.stdout)
    .trim()
    .split("\n");
  if (!name) {
    return undefined;
  }

  const githubUsername = email?.match(GITHUB_NOREPLY_EMAIL)?.groups?.username;
  return githubUsername
    ? `[@${githubUsername}](https://github.com/${githubUsername})`
    : name;
};

const repositoryForUrl = (url: string): string | undefined =>
  url.match(GITHUB_REPOSITORY_URL)?.groups?.repository;

const githubValue = (endpoint: string, query: string): string | undefined => {
  const cacheKey = `${endpoint}:${query}`;
  const cachedValue = githubValueCache.get(cacheKey);
  if (cachedValue !== undefined || githubValueCache.has(cacheKey)) {
    return cachedValue;
  }

  const result = Bun.spawnSync({
    cmd: ["gh", "api", endpoint, "--jq", query],
    stderr: "pipe",
    stdout: "pipe",
  });
  const value =
    result.exitCode === 0
      ? new TextDecoder().decode(result.stdout).trim()
      : undefined;
  githubValueCache.set(cacheKey, value);
  return value;
};

const githubAuthor = (
  endpoint: string,
  query = ".user.login // empty"
): string | undefined => {
  const cacheKey = `${endpoint}:${query}`;
  const cachedAuthor = githubAuthorCache.get(cacheKey);
  if (cachedAuthor !== undefined || githubAuthorCache.has(cacheKey)) {
    return cachedAuthor;
  }

  const username = githubValue(endpoint, query);
  const author = username
    ? `[@${username}](https://github.com/${username})`
    : undefined;
  githubAuthorCache.set(cacheKey, author);
  return author;
};

const authorForPullRequest = (
  url: string,
  number: string
): string | undefined => {
  const repository = repositoryForUrl(url);
  return repository
    ? githubAuthor(`repos/${repository}/pulls/${number}`)
    : undefined;
};

const pullRequestForCommit = (
  url: string,
  hash: string
): string | undefined => {
  const repository = repositoryForUrl(url);
  return repository
    ? githubValue(
        `repos/${repository}/commits/${hash}/pulls`,
        ".[0].number // empty"
      )
    : undefined;
};

const markerForPullRequest = (
  url: string,
  number: string
): string | undefined => {
  const repository = repositoryForUrl(url);
  if (!repository) {
    return undefined;
  }

  const endpoint = `repos/${repository}/pulls/${number}`;
  const cachedMarker = pullRequestMarkerCache.get(endpoint);
  if (cachedMarker !== undefined || pullRequestMarkerCache.has(endpoint)) {
    return cachedMarker;
  }

  const result = Bun.spawnSync({
    cmd: ["gh", "api", endpoint, "--jq", '[.head.ref, .body] | join("\\n")'],
    stderr: "pipe",
    stdout: "pipe",
  });
  const pullRequestDetails =
    result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : undefined;
  let marker: string | undefined;
  if (pullRequestDetails?.startsWith("t3code/")) {
    marker = "[T3 Code]";
  } else if (pullRequestDetails?.includes(CURSOR_AGENT_MARKER)) {
    marker = "[Cursor Agent]";
  }
  pullRequestMarkerCache.set(endpoint, marker);
  return marker;
};

const addAuthorToEntry = (entry: string): string => {
  const pullRequest = entry.match(PULL_REQUEST_REFERENCE);
  if (pullRequest?.groups) {
    const { number, url } = pullRequest.groups;
    const author = authorForPullRequest(url, number);
    const marker = markerForPullRequest(url, number);
    return author ? `${entry} — ${author}${marker ? ` ${marker}` : ""}` : entry;
  }

  const commit = entry.match(COMMIT_REFERENCE);
  if (!commit?.groups) {
    return entry;
  }

  const { hash, url } = commit.groups;
  const pullRequestNumber = pullRequestForCommit(url, hash);
  const author = pullRequestNumber
    ? authorForPullRequest(url, pullRequestNumber)
    : contributorForCommit(hash);
  const marker = pullRequestNumber
    ? markerForPullRequest(url, pullRequestNumber)
    : undefined;
  return author ? `${entry} — ${author}${marker ? ` ${marker}` : ""}` : entry;
};

const rawChangelog = await Bun.file(changelogPath).text();
const compareChanges = rawChangelog.match(COMPARE_CHANGES)?.[0].trim();
const changelog = rawChangelog
  .replace(RELEASE_HEADER, "## $<version>")
  .replace(COMPARE_CHANGES, "");
const changelogWithAuthors = changelog
  .split("\n")
  .map((entry) => (entry.startsWith("- ") ? addAuthorToEntry(entry) : entry))
  .join("\n");
const formattedChangelog = compareChanges
  ? `${changelogWithAuthors.trimEnd()}\n\n${compareChanges}\n`
  : changelogWithAuthors;
await Bun.write(changelogPath, formattedChangelog);
