# Fork maintenance

Consolidated Compute stays close to [Paseo](https://github.com/getpaseo/paseo). Preserve upstream ancestry and isolate fork behavior so a sync is a reviewable product change instead of a repository-wide port.

## Remotes

`origin` is `consolidated-compute/consolidated-compute`. `upstream` is `getpaseo/paseo` and has no working push URL.

Configure the remote without fetching upstream tags:

```bash
git config remote.upstream.url https://github.com/getpaseo/paseo.git
git config remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config remote.upstream.pushurl DISABLED
git fetch --no-tags upstream
```

Keep tags separate until Consolidated Compute defines its own release and version lineage. Check the configuration with:

```bash
git remote -v
git config --get-regexp '^remote\.(origin|upstream)\.(url|pushurl|fetch)$'
```

## Sync through a pull request

Never rebase, force-push, or merge directly into canonical `main`. Rebase unmerged topic branches only. Do not require linear history on `main`; upstream merge ancestry must remain visible.

Start from a clean, current fork branch:

```bash
git status --short
git fetch --no-tags origin main:refs/remotes/origin/main
git fetch --no-tags upstream main:refs/remotes/upstream/main
git switch -c sync/paseo-YYYY-MM-DD origin/main
git merge upstream/main
```

Resolve conflicts on the sync branch, run the affected checks, push the branch, and merge it through the normal pull-request path. If the fork has no unique commits, the sync branch can fast-forward. Once the fork diverges, keep the merge commit produced by the sync.

Favor the current upstream structure during conflict resolution. Reapply the smallest Consolidated Compute change that preserves the feature. Do not accept either whole file without reviewing both sides. Record each conflicted file and the chosen resolution in the pull request.

## Measure divergence

Fetch both remotes immediately before measuring. Compare remote branches rather than a local branch or `HEAD`.

```bash
git rev-list --left-right --count upstream/main...origin/main
git merge-base upstream/main origin/main
git diff --stat "$(git merge-base upstream/main origin/main)"..origin/main
git diff --shortstat upstream/main..origin/main
```

The first count is upstream-only commits: how far the fork lags. The second count is fork-only commits: the graph divergence. The merge-base diff is the fork patch surface. The tip-to-tip diff shows the current content difference.

Record all four facts. A single ahead/behind number hides whether the fork is behind, fork-only, or two-sided. Do not make live upstream equality a pull-request check; upstream can move while an unrelated change is under review.

## Shallow-fork boundaries

- Keep Paseo's Project, Workspace, Agent session, Host, Daemon, and Worktree meanings. [The glossary](glossary.md) owns those terms.
- Add persistence only for a Consolidated Compute abstraction that Paseo cannot represent.
- Change the daemon, protocol, wire schemas, provider adapters, and scheduler only when a Consolidated Compute feature needs a new runtime contract.
- Preserve compatibility identifiers unless a separately reviewed migration owns the change: the `@getpaseo/*` package scope, `paseo` CLI, `paseo.json`, `PASEO_*`, `~/.paseo`, `paseo://`, stored keys, wire names, and existing implementation symbols.
- Put fork-owned behavior in new, narrow modules and integration points. Avoid repository-wide renames and formatting churn.
- Keep `LICENSE` and third-party notices intact. Add fork attribution separately; do not replace upstream copyright or author metadata.

Display branding is separate from runtime identity. A packaged branding change must decide application IDs, deep links, state-directory compatibility, signing, update feeds, artifact names, package destinations, mobile ownership, and migration behavior together.

## Repository and release controls

Protect `main` with pull requests, required CI checks, deletion protection, and non-fast-forward protection. Leave linear-history enforcement off.

Inherited delivery workflows and release commands still target Paseo-owned services and namespaces. Every deploy, publish, and write-back job must require the repository variable `CC_DELIVERY_ENABLED` to equal `true`. Keep it unset or set to `false` while verification CI is active.

Do not enable that gate, run `release:*` commands, or push `v*` tags until [the release process](release.md) names Consolidated Compute destinations, credentials, signing identities, updater repository, package policy, and tag lineage.

## Sync evidence

Every upstream sync pull request includes:

- upstream and fork tip SHAs before the merge;
- upstream-only and fork-only commit counts before and after;
- the merge-base SHA and fork patch summary;
- conflicted files and their resolutions;
- exact format, lint, typecheck, build, and targeted test results;
- affected platforms tested and gaps assigned for follow-up.

Follow [testing.md](testing.md) for local test scope and [qa.md](qa.md) for the evidence and platform matrix. An inherited upstream failure is still a fork baseline failure until it is resolved or explicitly accepted with an owner and follow-up.
