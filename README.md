# workspace-status-mcp

*[Українською](README.uk.md)*

An MCP server with one tool, `sweep_status`: a one-call snapshot of every
git repository under a given folder — branch, uncommitted changes, unpushed
commits, and (optionally) the latest GitHub Actions CI conclusion. Replaces
manually looping `git status` + `gh run list` over dozens of repos one at a
time.

## Why

Working across ~50 repositories in the same workspace, "what actually needs
attention right now" was a real recurring question — checked by hand,
repo by repo, over and over in the same session. `sweep_status` answers it
in one call and, by default, only returns repos that actually need a look
(dirty working tree, unpushed commits, or a CI run that isn't a plain
success) — clean repos are silently skipped so the answer stays short.

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

## Architecture

- `src/sweep.js` — all the logic: finds `.git` folders one level under
  `root`, then for each one runs `git branch`/`git status`/`git rev-list`
  and (optionally) `gh run list` in parallel, batched at 8 repos at a time
  to avoid hammering the GitHub API.
- `src/server.js` — registers `sweep_status` with the MCP SDK over the
  stdio transport.
- `test/smoke.mjs` — runs against real local repos (no synthetic
  fixtures needed — the workspace itself already has clean, dirty, and
  upstream-less repos to test against).

## License

MIT — Faneraiy14.
