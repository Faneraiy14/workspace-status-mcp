# workspace-status-mcp

*[Українською](README.uk.md)*

An MCP server with two tools:

- `sweep_status` — a one-call snapshot of every git repository under a
  given folder: branch, uncommitted changes, unpushed commits, and
  (optionally) the latest GitHub Actions CI conclusion. Replaces manually
  looping `git status` + `gh run list` over dozens of repos one at a time.
- `check_docs` — flags which repos' `Architecture/<repo>.txt` doc is
  missing or older than the repo's last commit. Doesn't write or
  regenerate anything itself (understanding a codebase well enough to
  document it is an LLM/human job, not a script's) — it just says where
  to look, so docs get updated deliberately instead of silently rotting.

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
`current` / `no-commits`), `lastCommitAt`, `docUpdatedAt`, and
`staleBySeconds` (only on `stale`).

## Architecture

- `src/sweep.js` — all the logic: finds `.git` folders one level under
  `root` (exported as `findGitRepos`, reused by `docs.js`), then for each
  one runs `git branch`/`git status`/`git rev-list` and (optionally)
  `gh run list` in parallel, batched at 8 repos at a time to avoid
  hammering the GitHub API.
- `src/docs.js` — `checkDocs()`: for each repo, `git log -1 --format=%ct`
  vs the doc file's mtime, compared as Unix timestamps (no timezone
  fuss). A repo with no commits yet reports `no-commits` rather than
  being silently lumped into `missing` or `current`.
- `src/server.js` — registers both tools with the MCP SDK over the
  stdio transport.
- `test/smoke.mjs` — `sweep_status` against real local repos (no
  synthetic fixtures needed — the workspace itself already has clean,
  dirty, and upstream-less repos to test against).
- `test/docs.mjs` — `check_docs` against temporary, throwaway git repos
  with controlled commit/file timestamps (real `~/Projects` drifts over
  time, which would make a fixed test flaky).

## License

MIT — Faneraiy14.
