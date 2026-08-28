# workspace-status-mcp

*[Українською](README.uk.md)*

An MCP server with four tools:

- `sweep_status` — a one-call snapshot of every git repository under a
  given folder: branch, uncommitted changes, unpushed commits, and
  (optionally) the latest GitHub Actions CI conclusion. Replaces manually
  looping `git status` + `gh run list` over dozens of repos one at a time.
- `check_docs` — flags which repos' `Architecture/<repo>.txt` doc is
  missing or stale. Doesn't write or regenerate anything itself
  (understanding a codebase well enough to document it is an LLM/human
  job, not a script's) — it just says where to look, so docs get updated
  deliberately instead of silently rotting.
- `write_doc` — writes `Architecture/<repo>.txt` and stamps it with the
  repo's current commit hash, so `check_docs` can later measure staleness
  precisely (commits since write) instead of guessing from file mtime.
- `check_release_drift` — for explicit (source repo, release repo) pairs,
  counts how many commits landed in the source since the release repo's
  last git tag, and how old the oldest one is. Cutting a release is
  usually a manual "whenever I remember" step (tag a version, push it,
  CI builds and publishes) — this answers "has anyone actually done that
  lately" without checking by hand.

## Why

Working across ~50 repositories in the same workspace, "what actually needs
attention right now" was a real recurring question — checked by hand,
repo by repo, over and over in the same session. `sweep_status` answers it
in one call and, by default, only returns repos that actually need a look
(dirty working tree, unpushed commits, or a CI run that isn't a plain
success) — clean repos are silently skipped so the answer stays short.

`check_docs` exists for the same reason, one level up: a per-project
architecture doc is only useful if it's trusted, and it's only trusted if
someone actually checks it's current. Comparing "last commit" to "doc's
mtime" turns that from a thing you have to remember into a thing you can
just ask.

## Install

```bash
npm install
```

Requires the GitHub CLI (`gh`), authenticated, if you want CI status
(`check_ci: true`, the default). Without it CI results just come back as
`null` per repo.

## Tool: `sweep_status`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `root` | string | — (required) | Folder to scan, one level deep (e.g. `/home/user/Projects`) |
| `repos` | string[] | all subfolders | Limit to specific repo names instead of scanning everything |
| `check_ci` | boolean | `true` | Also query GitHub Actions for each repo's latest run |
| `only_attention` | boolean | `true` | Only return repos that need a look; `false` returns everything |

Each repo entry: `name`, `path`, `branch`, `uncommittedFiles` (count),
`ahead`/`behind` (vs upstream, `null` if no upstream configured),
`hasUpstream`, and `ci` (`{status, conclusion, workflow, url}` or `null`).

## Tool: `check_docs`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `projectsRoot` | string | — (required) | Folder with the repos |
| `docsRoot` | string | `<projectsRoot>/Architecture` | Folder with the `<repo>.txt` docs |
| `repos` | string[] | all subfolders | Limit to specific repo names |
| `only_attention` | boolean | `true` | Only return missing/stale; `false` returns everything including `current` |

Each repo entry: `name`, `docPath`, `status` (`missing` / `stale` /
`current` / `no-commits`), `trackingMethod` (`commit` if the doc was
written via `write_doc`, `mtime` otherwise — see below), `lastCommitAt`,
and either `commitsSinceWrite`/`writtenAtCommit`/`writtenAt` (commit
tracking) or `docUpdatedAt`/`staleBySeconds` (mtime tracking, only on
`stale`).

## Tool: `write_doc`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `projectsRoot` | string | — (required) | Folder with the repos |
| `repo` | string | — (required) | Repo folder name (e.g. `"anylint"`) |
| `content` | string | — (required) | Full text to write to `<repo>.txt` |
| `docsRoot` | string | `<projectsRoot>/Architecture` | Folder with the `<repo>.txt` docs |

Writes `<repo>.txt` and, next to it, `.meta/<repo>.json` with the repo's
`HEAD` commit hash at write time. `check_docs` then reports the *exact*
number of commits since the doc was written (`git rev-list --count`)
instead of the coarser mtime-vs-last-commit-time comparison — the same
pattern `check_release_drift` already uses for source→release drift. Docs
written directly (e.g. via a plain file write, not this tool) keep using
mtime tracking — there's no meta file to compare against.

## Tool: `check_release_drift`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `projectsRoot` | string | — (required) | Folder with the repos |
| `pairs` | `{source, release}[]` | — (required) | Explicit list of source→release folder-name pairs |
| `only_attention` | boolean | `true` | Only return `drifted`; `false` returns everything including `current`/`no-tags` |

Each pair entry: `source`, `release`, `status` (`drifted` / `current` /
`no-tags`), and on `drifted`: `latestTag`, `tagCreatedAt`,
`commitsSinceTag`, `oldestUnreleasedCommitAt`, `oldestUnreleasedAgeDays`.

## Architecture

- `src/sweep.js` — all the logic: finds `.git` folders one level under
  `root` (exported as `findGitRepos`, reused by `docs.js`), then for each
  one runs `git branch`/`git status`/`git rev-list` and (optionally)
  `gh run list` in parallel, batched at 8 repos at a time to avoid
  hammering the GitHub API.
- `src/docs.js` — `checkDocs()`: prefers commit-based tracking
  (`.meta/<repo>.json`, written by `write_doc`) when available; falls
  back to comparing `git log -1 --format=%ct` against the doc file's
  mtime for docs written directly. A repo with no commits yet reports
  `no-commits` rather than being silently lumped into `missing` or
  `current`.
- `src/write-doc.js` — `writeDoc()`: writes `<repo>.txt` plus
  `.meta/<repo>.json` (`{commitHash, writtenAt}`, `HEAD` at write time).
  Doesn't generate the text itself — understanding a codebase well
  enough to document it stays an LLM/human job.
- `src/server.js` — registers all four tools with the MCP SDK over the
  stdio transport.
- `test/smoke.mjs` — `sweep_status` against real local repos (no
  synthetic fixtures needed — the workspace itself already has clean,
  dirty, and upstream-less repos to test against).
- `test/docs.mjs` — `check_docs` against temporary, throwaway git repos
  with controlled commit/file timestamps (real `~/Projects` drifts over
  time, which would make a fixed test flaky), including both tracking
  methods.
- `test/write-doc.mjs` — `writeDoc()` against a temporary git repo:
  correct `HEAD` captured, `.meta/` created on demand, empty content
  rejected.
- `src/release-drift.js` — `checkReleaseDrift()`: finds the release
  repo's most recent tag via `git for-each-ref --sort=-creatordate`
  (sorted by actual tag time, not the semver-string sort `-v:refname`
  would give — `v1.10` would otherwise sort before `v1.9`), then counts
  `git log --since=@<tagTimestamp>` in the source repo. The
  source↔release relationship isn't guessable from folder structure (no
  general rule "folder X releases folder Y"), so the caller passes pairs
  explicitly.
- `test/release-drift.mjs` — temporary repos with explicit
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` per commit (not relying on real
  wall-clock gaps between commits made milliseconds apart in a test run,
  which `git log --since`'s second-level granularity could otherwise
  make flaky), plus one live check against the real
  NyxilumLang→NyxilumNode pair that only asserts it doesn't throw.

## License

MIT — Faneraiy14.
