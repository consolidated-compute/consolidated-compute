---
title: Consolidated Compute architecture
description: What CC owns, what Paseo supplies, and where your agent harnesses and optional Hub fit.
nav: Architecture
order: 4
category: Getting started
---

# Consolidated Compute architecture

Consolidated Compute is an agent control plane built as a shallow fork of [Paseo](https://github.com/getpaseo/paseo). Use it to operate work across existing coding-agent harnesses. You keep the harness that executes tools and talks to your model provider.

## One daemon, two layers

CC extends the Paseo app and daemon. You do not install a second orchestration server between them.

```text
CC app
  │ connect to selected Host
  ▼
Daemon from the CC checkout
  ├─ CC:
  │   Assignments, Teams, Artifacts
  │   supervision, security preview
  └─ Paseo:
      Agent Profiles, Workspaces
      agents, Forge, schedules
  │ provider adapters
  ▼
Your coding-agent harnesses
  │ provider connections
  ▼
Configured model services
```

The app presents Operations, Work, and Team Run review across connected hosts. Execution records belong to the daemon that accepted the work; selecting another host selects another host's state and credentials.

CC owns the durable objective, role instructions, run coordination, and retained handoffs. Paseo supplies the Agent Profiles, Workspace lifecycle, agent sessions, timelines, Forge adapters, and scheduler those services use. A Team role references an existing Agent Profile rather than maintaining another provider configuration. The [Team contract](https://github.com/consolidated-compute/consolidated-compute/blob/main/docs/teams.md) owns admission, frozen launches, and execution invariants.

## Local GitHub Work

Repository discovery follows **CC app → selected daemon → Paseo Forge → host `gh` → GitHub**. A Repository has a remote identity independent of a local checkout, so you can select work before creating a Workspace. Each host's authenticated `gh` identity determines its repository catalog.

GitHub remains the source of the issue or PR. CC stores a bounded Work Item reference with your Assignment objective; starting a run does not implicitly import the issue body or synchronize its lifecycle. See [Assignments and Artifacts](https://github.com/consolidated-compute/consolidated-compute/blob/main/docs/assignments.md) for that ownership boundary, and the [first-Team walkthrough](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/github-work.md) to try the flow.

## Network and authority boundaries

The daemon runs agent processes against your local Workspace. The harness can send prompts, selected code, and tool results to its configured model service. Forge calls contact GitHub. Local-first describes where you operate and retain execution state; it is not an offline-execution guarantee.

For provider-native restrictions and credential boundaries, read the [capability and evidence matrix](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/capabilities.md). Follow the [security-preview guidance](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/github-work.md#review-the-security-preview) before admission.

## Optional Hub

Interactive GitHub Work requires no Hub account, GitHub App installation, or webhook setup.

```text
Optional, explicitly connected:
Daemon ↔ Paseo Hub ↔ Integrations
```

Hub is a separate integration path for a concrete automation or hosted need, such as webhooks or shared organization identity. The [optional Hub track](https://github.com/consolidated-compute/consolidated-compute/issues/140) owns CC's adoption decisions; existing Paseo plumbing does not imply that each integration is a shipped CC Team workflow.

Hub and relay are separate connections. Hub enrollment is explicit and daemon-outbound; relay provides optional encrypted client transport. See the [Hub relationship contract](https://github.com/consolidated-compute/consolidated-compute/blob/main/docs/hub.md) and [relay configuration](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/configuration.md#relay) rather than enabling either for local setup.

## Start with the source workflow

Follow the [setup and distribution guide](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/index.md). For package boundaries and the client protocol, see the [implementation architecture](https://github.com/consolidated-compute/consolidated-compute/blob/main/docs/architecture.md).
