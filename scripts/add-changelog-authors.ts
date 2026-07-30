import { argv } from "node:process";

const COMMIT_REFERENCE = /\(\[(?<hash>[0-9a-f]{7,})\]\([^)]+\)\)/gu;
const GITHUB_NOREPLY_EMAIL =
  /(?:\d+\+)?(?<username>[^@]+)@users\.noreply\.github\.com$/u;
const RELEASE_HEADER = /^## v(?<version>\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)$/mu;
const COMPARE_CHANGES = /\n\[compare changes\]\([^)]+\)\n/u;

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

const rawChangelog = await Bun.file(changelogPath).text();
const compareChanges = rawChangelog.match(COMPARE_CHANGES)?.[0].trim();
const changelog = rawChangelog
  .replace(RELEASE_HEADER, "## $<version>")
  .replace(COMPARE_CHANGES, "");
const changelogWithAuthors = changelog.replaceAll(
  COMMIT_REFERENCE,
  (reference, hash: string) => {
    const contributor = contributorForCommit(hash);
    return contributor ? `${reference} — ${contributor}` : reference;
  }
);
const formattedChangelog = compareChanges
  ? `${changelogWithAuthors.trimEnd()}\n\n${compareChanges}\n`
  : changelogWithAuthors;
await Bun.write(changelogPath, formattedChangelog);
