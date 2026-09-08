---
title: Getting started with Consolidated Compute
description: Run Consolidated Compute from source and start with host-local GitHub Work.
nav: Getting started
order: 1
category: Getting started
---

# Getting started with Consolidated Compute

The [architecture guide](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/architecture.md) explains how CC, Paseo, and your coding-agent harness fit together.

## Distribution and compatibility

Run both the app and daemon from the [Consolidated Compute repository](https://github.com/consolidated-compute/consolidated-compute). Upstream Paseo downloads, npm packages, and Docker images do not include CC's fork-only features. Independent CC installation, update, and migration destinations remain tracked in [#29](https://github.com/consolidated-compute/consolidated-compute/issues/29).

This source workflow uses browser web on macOS or Linux. For Electron, Windows, or native development, use the [development guide](https://github.com/consolidated-compute/consolidated-compute/blob/main/docs/development.md). Package names and commands still use Paseo compatibility identifiers; do not rename state directories or run the inherited release/update commands.

## Prepare the checkout

Install Git, Node.js at the version in [`.tool-versions`](https://github.com/consolidated-compute/consolidated-compute/blob/main/.tool-versions), and npm. Install your chosen provider CLI and configure its credentials on the machine that will run the daemon. The first-Team example uses Codex; CC does not supply a provider subscription.

```bash
git clone https://github.com/consolidated-compute/consolidated-compute.git
cd consolidated-compute
npm ci
npm run build:server
npm run build:app-deps
```

Run the following commands from that checkout. With no `PASEO_HOME` override, repo dev commands use `.dev/paseo-home`, separate from a packaged app's `~/.paseo` home. Keep production port `6767` separate from the dev daemon on `6768`. If either dev port below is already in use, follow the development guide rather than stopping someone else's daemon.

## Set up host security

Ordinary pairing does not require a password by default. CC supervised Teams require a saved host password; device enrollment does not replace that requirement.

For supervised Teams, connect first, open the host's settings and choose **Set up host security**. Electron approves setup for its managed local host through the desktop app. In a browser, first generate a private, five-minute setup code on the daemon host using the same checkout and home:

```bash
npm run cli -- daemon setup-code
```

Enter the code and a new password in the form. Setup requires a direct HTTPS or loopback connection, not a relay-only or SSH-only connection. The daemon stores a bcrypt hash, and the app remembers the password in its local connection registry, not an OS keychain. If saving or reconnecting fails, keep the form open and retry before restarting. Setup cannot replace an existing password or modify device-authenticated access; use `npm run cli -- daemon set-password` locally to change an existing password.

Do not launch the daemon with `PASEO_PASSWORD` set, even if you also saved a password. Supervised admission rejects that configuration because a same-user provider process may read the daemon's startup environment. Remove an inherited `PASEO_PASSWORD` from the shell or service configuration before starting the daemon.

The form asks you to confirm a restart before security takes effect. Finish active work first; restarting interrupts agents and Team Runs. Do not restart another operator's daemon. Keep the password and setup code out of shell history, launch URLs, role instructions, and agent terminals. The [configuration reference](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/configuration.md#password-authentication) describes the stored-password setting.

## Start the daemon and browser app

In one terminal:

```bash
npm run dev:server
```

In a second terminal, from the same checkout:

```bash
npm run dev:app
```

Open `http://localhost:8081`. Connect to the dev host at `localhost:6768`, entering the daemon password in the connection UI. Both processes must use the same dev home and endpoint; do not select a packaged upstream daemon on `6767` for this walkthrough.

Local operation does not need `relay.paseo.sh`. New homes default to relay disabled. If you reused a home with an explicit enabled relay setting, disable `daemon.relay.enabled` there; its saved value is preserved. Do not enable relay for this walkthrough. See the [relay configuration](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/configuration.md#relay).

## Run your first Team

Continue with [GitHub Work → your first Team Run](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/github-work.md). You will authenticate `gh` on the daemon host, select work before checkout, create an Assignment and saved Team, choose a worktree, inspect the security preview, and review the result.

You do not need a Hub account, GitHub App installation, or webhook configuration for this interactive path. Existing Paseo sessions remain available for one-off work; a Team is useful when you need durable multi-role execution and retained handoffs.
