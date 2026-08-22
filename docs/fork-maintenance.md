# Fork maintenance

Consolidated Compute follows [Paseo](https://github.com/getpaseo/paseo) on a deliberate stable-release cadence. Preserve upstream ancestry and isolate fork behavior so a sync is a reviewable product change instead of a repository-wide port.

## Remotes

`origin` is `consolidated-compute/consolidated-compute`. `upstream` is `getpaseo/paseo` and has no working push URL.

Configure the remote without fetching upstream tags:

```bash
git config remote.upstream.url https://github.com/getpaseo/paseo.git
git config remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config remote.upstream.pushurl DISABLED
git fetch --no-tags upstream
```

Do not fetch upstream tags in bulk. Fetch only the stable release tag selected for a sync so Paseo tags stay separate from Consolidated Compute's future release lineage. Check the configuration with:

```bash
git remote -v
git config --get-regexp '^remote\.(origin|upstream)\.(url|pushurl|fetch)$'
```

## Stable-release sync cadence

Sync published Paseo stable releases. A stable release is a non-draft, non-prerelease GitHub release with a `vMAJOR.MINOR.PATCH` tag. Do not sync upstream `main`, beta tags, release candidates, or every upstream commit.

An urgent security fix or a Paseo change that blocks Consolidated Compute development can be synced early. Link the exception to an issue and explain why waiting for the next stable release is unsafe or stops planned work.

`.github/workflows/upstream-release-monitor.yml` checks GitHub daily and can be run manually. When the latest stable release is not in the fork, it opens one deduplicated sync issue. It does not create a branch or pull request; sync commits stay signed and reviewed without storing a signing key in Actions.

Every sync uses a pull request. Never rebase, force-push, or merge directly into canonical `main`. Rebase unmerged topic branches only. Do not require linear history on `main`; upstream merge ancestry must remain visible.

Inspect GitHub's latest stable release, then start from a clean, current fork branch. Replace `vX.Y.Z` with the release tag returned by GitHub:

```bash
gh api repos/getpaseo/paseo/releases/latest \
  --jq '{tag: .tag_name, published: .published_at, draft: .draft, prerelease: .prerelease}'
git status --short
git fetch --no-tags origin main:refs/remotes/origin/main
git fetch --no-tags upstream \
  'refs/tags/vX.Y.Z:refs/remotes/upstream/releases/vX.Y.Z'
git switch -c sync/paseo-vX.Y.Z origin/main
git merge --no-commit --no-ff refs/remotes/upstream/releases/vX.Y.Z
git commit -S -m 'chore: sync Paseo vX.Y.Z'
```

Resolve conflicts before creating the signed merge commit. Run the affected checks, push the branch, and merge it through the normal pull-request path. Keep the merge commit so the imported release ancestry remains visible.

Favor the current upstream structure during conflict resolution. Reapply the smallest Consolidated Compute change that preserves the feature. Do not accept either whole file without reviewing both sides. Record each conflicted file and the chosen resolution in the pull request.

## Measure divergence

Fetch `origin/main` and the selected stable tag immediately before measuring. Compare the release tag with the remote fork branch rather than a local branch or `HEAD`.

```bash
release_ref=refs/remotes/upstream/releases/vX.Y.Z
git rev-list --left-right --count "$release_ref"...origin/main
git merge-base "$release_ref" origin/main
git diff --stat "$(git merge-base "$release_ref" origin/main)"..origin/main
git diff --shortstat "$release_ref"..origin/main
```

The first count is release-only commits: how far the fork lags the selected release. The second count is fork-only commits: the graph divergence. The merge-base diff is the fork patch surface. The tip-to-tip diff shows the current content difference.

Record all four facts. A single ahead/behind number hides whether the fork is behind, fork-only, or two-sided. Do not make equality with upstream `main` a pull-request check.

## Shallow-fork boundaries

- Keep Paseo's Project, Workspace, Agent session, Host, Daemon, and Worktree meanings. [The glossary](glossary.md) owns those terms.
- Add persistence only for a Consolidated Compute abstraction that Paseo cannot represent.
- Change the daemon, protocol, wire schemas, provider adapters, and scheduler only when a Consolidated Compute feature needs a new runtime contract.
- Preserve compatibility identifiers unless a separately reviewed migration owns the change: the `@getpaseo/*` package scope, `paseo` CLI, `paseo.json`, `PASEO_*`, `~/.paseo`, `paseo://`, stored keys, wire names, and existing implementation symbols.
- Put fork-owned behavior in new, narrow modules and integration points. Avoid repository-wide renames and formatting churn.
- Keep `LICENSE` and third-party notices intact. Add fork attribution separately; do not replace upstream copyright or author metadata.

Display branding is separate from runtime identity. The fork displays **Consolidated Compute** in translated app copy, native app labels, PWA metadata, and desktop window chrome. Keep the existing `Paseo` Electron user-data directory so the display rename does not strand settings or browser sessions.

Keep application IDs, deep-link schemes, state directories, package scopes, environment variables, CLI names, artifact names, signing, update feeds, package destinations, and mobile ownership unchanged until the release process defines their Consolidated Compute replacements and migration behavior. Source code may therefore display Consolidated Compute while compatibility paths and unpublished package metadata still contain `Paseo` or `paseo`.

## Repository and release controls

Protect `main` with pull requests, required CI checks, deletion protection, and non-fast-forward protection. Leave linear-history enforcement off.

Inherited delivery workflows and release commands still target Paseo-owned services and namespaces. Every deploy, publish, and write-back job must require the repository variable `CC_DELIVERY_ENABLED` to equal `true`. Keep it unset or set to `false` while verification CI is active.

Do not enable that gate, run `release:*` commands, or push `v*` tags until [the release process](release.md) names Consolidated Compute destinations, credentials, signing identities, updater repository, package policy, and tag lineage.

## Sync evidence

Every upstream sync pull request includes:

- the selected Paseo tag or exception commit, its SHA, publication date when applicable, and the fork tip SHA before the merge;
- upstream-only and fork-only commit counts before and after;
- the merge-base SHA and fork patch summary;
- conflicted files and their resolutions;
- exact format, lint, typecheck, build, and targeted test results;
- affected platforms tested and gaps assigned for follow-up.

Follow [testing.md](testing.md) for local test scope and [qa.md](qa.md) for the evidence and platform matrix. An inherited upstream failure is still a fork baseline failure until it is resolved or explicitly accepted with an owner and follow-up.
