# Consolidated Compute

An open control plane for **Harness Operations**. A harness for your harness.

Operate work across the coding agents and machines you already use: select repository work, give it a durable objective, run a saved Team, and review its evidence before deciding what ships.

Consolidated Compute is a shallow fork of [Paseo](https://github.com/getpaseo/paseo). Paseo supplies the agent runtime, Workspaces, provider integrations, and host connectivity. CC adds Assignments, Teams, immutable Artifacts, supervised execution, and operator views. It does not replace your coding-agent runtime or your issue tracker.

## Try it from source

Start with the [source setup guide](public-docs/index.md), then follow [GitHub Work → your first Team Run](public-docs/github-work.md).

See the [distribution and compatibility guidance](public-docs/index.md#distribution-and-compatibility) before installing or updating.

## Pick work, run a Team, review the result

1. Select a host and browse its authenticated GitHub repositories before creating a Workspace.
2. Turn an issue or pull request into an **Assignment** with an explicit objective. GitHub keeps the source issue; CC stores a bounded reference.
3. Choose a saved **Team** whose roles reference the host's ordinary Paseo **Agent Profiles**.
4. Create a dedicated worktree **Workspace** and inspect the daemon's security preview and approval fingerprint.
5. Start a supervised **Team Run**, respond to human checkpoints, and inspect immutable **Artifacts** with their producing role, agent, and run.
6. Review live Workspace changes, test results, and the PR. Keep merge approval with a human.

The [first-run guide](public-docs/github-work.md) provides a Plan → Implement → Review example, setup requirements, recovery steps, and proof limitations.

## Local-first architecture

```text
Consolidated Compute
        ↓
Paseo daemon on your host
        ↓
Forge / authenticated host gh
        ↓
GitHub
```

Interactive GitHub Work needs no Hub account, GitHub App installation, or webhook setup. Repository catalogs depend on the selected host's `gh` identity. Local operation needs no relay; relay is opt-in, and existing explicit relay settings remain in effect.

[Optional Hub integration](https://github.com/consolidated-compute/consolidated-compute/issues/140) is a separate, deferred track for concrete automation or hosted needs.

## What is proved

- **Self-work:** real supervised CC runs produced merged fixes. See [#126](https://github.com/consolidated-compute/consolidated-compute/issues/126).
- **GitHub Work:** a real Codex/Spark run on macOS produced Plan, Implementation, and Review Artifacts from repository-selected work. Browser and Electron preflight and reload evidence are recorded in [#135](https://github.com/consolidated-compute/consolidated-compute/issues/135). That issue remains open for the complete end-to-end proof.
- **Provider breadth:** Paseo integrates Claude Code, Codex, GitHub Copilot, OpenCode, and Pi. That is not a claim that every provider supports every Team security control; [#127](https://github.com/consolidated-compute/consolidated-compute/issues/127) tracks a second-harness proof.
- **Platforms:** clients target browser, Electron, iOS, and Android. Remaining native evidence is tracked in [#19](https://github.com/consolidated-compute/consolidated-compute/issues/19) and the deferred [#64](https://github.com/consolidated-compute/consolidated-compute/pull/64).

Security previews distinguish enforced controls, policy-only guidance, and unavailable controls. A worktree is not a credential sandbox, and a host's `gh` login is operator authority, not isolated per-agent least privilege. Read the [first-run security guidance](public-docs/github-work.md#review-the-security-preview) before starting work.

## Development

This is an npm workspace monorepo:

- `packages/server` — Paseo daemon and CC execution services
- `packages/app` — Expo client for browser, Electron renderer, iOS, and Android
- `packages/cli` — compatibility-named `paseo` CLI
- `packages/desktop` — Electron wrapper
- `packages/relay` — optional encrypted relay transport
- `packages/website` — inherited website and public-docs renderer

See [development](docs/development.md) for source commands, [architecture](docs/architecture.md) for package boundaries, and [fork maintenance](docs/fork-maintenance.md) for stable-release sync and release quarantine. The [roadmap](https://github.com/consolidated-compute/consolidated-compute/issues/9) owns the next milestones. [CONTRIBUTING.md](CONTRIBUTING.md) describes the contribution workflow.

## Attribution and license

Built on [Paseo](https://github.com/getpaseo/paseo), created by Mohamed Boudra and its contributors. Upstream runtime identifiers and notices are preserved. Licensed under [Apache-2.0](LICENSE).
