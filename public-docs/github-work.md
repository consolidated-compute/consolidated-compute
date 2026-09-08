---
title: GitHub Work → your first Team Run
description: Select repository work with host-local gh, run a saved Team, and review its Artifacts and Workspace changes.
nav: First Team Run
order: 2
category: Getting started
---

# GitHub Work → your first Team Run

Use this walkthrough for a small issue in a repository you control. Start from the [CC source setup](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/index.md), with the app and password-protected daemon from the same checkout. The example uses three worker roles and a separate supervisor, all backed by existing Paseo Agent Profiles.

An ordinary session is enough for a single task. Paseo's Handoff, Advisor, and Committee workflows suit ad-hoc collaboration. Choose an Assignment and Team when you need a saved process, explicit handoffs, human checkpoints, and durable run history. Teams do not share full conversations; roles still share the Workspace filesystem.

## Select work on the right host

GitHub authentication belongs to the **daemon host**, not the browser. Install GitHub CLI there and authenticate the intended account using its normal login flow:

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
```

CC uses host-local Forge/`gh`; Hub is optional and is not involved in this path. Two hosts can expose different repository catalogs. For GitHub Enterprise, authenticate the actual enterprise hostname on that host and enter it in **GitHub hostname**. Do not paste a URL or token into that field.

1. Open **GitHub Work** and select the daemon **Host**.
2. Search **Repositories** for `owner/repository`, then select the repository. No Project or Workspace needs to exist yet.
3. Choose **Issues** or **Pull requests**, search, and open an item. Read the body preview; use **Open in GitHub** when the preview is truncated or you need comments.
4. Check **Linked Assignments** for existing work on this host. **Open** shows the saved objective and execution history, including completed or canceled work, without creating another record. You can link several Assignments to one issue or PR for separate objectives.
5. For a new objective, select **Create Assignment** and write a bounded, explicit **Objective**. Save it and verify its **Work Item reference** and objective in Assignments.

For example, ask for one documentation correction and name the file, acceptance check, and excluded work. The issue body preview is not copied into the Assignment or implicitly fetched at run start. Put the necessary requirements in the objective; the linked issue alone does not supply them to the Team.

GitHub remains authoritative for the issue. Completing an Assignment does not close the issue, and a successful Team Run does not automatically complete its Assignment.

## Save the launch profiles

Open the selected host's **Agent profiles** in Settings, or use **Manage Agent Profiles** from Teams. Create the following profiles using **Codex**, an explicitly selected model and thinking level, and the named **Security boundary**:

| Profile name | Security boundary           | Purpose                                                    |
| ------------ | --------------------------- | ---------------------------------------------------------- |
| Supervisor   | Fail-closed read only       | Coordinate work and report when a human decision is needed |
| Planner      | Fail-closed read only       | Inspect the objective and checkout; produce a bounded plan |
| Builder      | Fail-closed Workspace write | Make the requested change in the selected worktree         |
| Reviewer     | Fail-closed read only       | Inspect the change and report evidence and remaining risks |

For CC's small smoke tasks, select `gpt-5.3-codex-spark` and Thinking `low` on all four profiles if the host offers them. That is the model used in the recorded GitHub Work proof, not a promise of availability or a dollar-cost estimate. If unavailable, stop and choose a model deliberately; do not substitute a more expensive default. Even a short supervised run includes coordination turns in addition to the three workers.

Select Mode **Default Permissions** and then the explicit security boundary above, not **Auto-review**. The native preset supplies the restrictions; the mode name alone does not. Keep native delegation disabled; the Codex fail-closed presets include that control. If these security presets are unavailable, resolve the host/provider support problem before starting this example. Do not replace them with **Provider defaults** merely to make Start available.

Profiles own launch settings. Team roles own instructions. Save profiles on the same host as the Assignment; a profile on another host is not interchangeable.

## Save a Plan → Implement → Review Team

Open **Teams → New Team**, select the same host, and name the Team. Add four roles referencing the profiles above. Use three workflow steps in order: Planner, Builder, Reviewer. Keep Supervisor as a role outside the worker workflow, then select it as the supervisor when starting the run.

Suggested **Team instructions**:

> Work only on the accepted objective in this Workspace. Keep final responses concise; they become handoff Artifacts. Do not commit, push, open or merge PRs, install dependencies, or change unrelated files. Report blockers and ask for human review instead of widening scope.

Suggested **Role instructions**:

| Role       | Instructions                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor | Plan the work using Planner, Builder, then Reviewer. Preserve that order. Complete only after the requested change and review evidence are present; otherwise escalate with the blocker.              |
| Planner    | Inspect the objective and checkout. Return a short plan naming the target files, acceptance checks, and risks. Do not edit files.                                                                     |
| Builder    | Read the supplied plan Artifact, implement the bounded change, and run the targeted check named in the objective. Report changed files, the exact command and result, and any untested requirement.   |
| Reviewer   | Read the supplied Artifacts and inspect the actual diff. Verify the acceptance criteria using checks that do not write files. Report failures or missing evidence; do not repair the change yourself. |

Instructions are policy guidance, not access controls. A read-only reviewer cannot run checks that generate caches or build outputs; review the Builder's recorded results and have the operator run any remaining checks instead of relaxing its boundary silently.

## Create a dedicated worktree

Discovery did not need a checkout; execution does. Clone or locate the selected repository **on the same daemon host**, then add that directory as a Project. From the Project's new Workspace composer, choose **Worktree**, review the base branch, leave the agent prompt empty, and select **Create**. Wait for setup to finish before starting the Team.

Use a dedicated branch and inspect the repository's worktree setup hooks before running them. A worktree separates files from your main checkout; it does not isolate credentials or other processes. Team Run locking excludes another Team Run from this Workspace, not ordinary agents or manual edits.

Return to **Assignments**, open the Assignment, and choose **Run Team**. Select the saved Team, the new Workspace, **Supervised**, and the Supervisor role. This is not the objective-only start from the Teams screen.

## Review the security preview

Before **Start Run**, inspect every resolved role: profile, provider, model, thinking, and security posture. Check that the Workspace is your new worktree and that the displayed approval fingerprint belongs to the preview you intend to accept.

You can stop at this preview without spending agent turns. Pressing **Start Run** begins provider execution and consumes provider usage.

Read each dimension using the matrix's [Enforced, Policy only, and Unavailable definitions](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/capabilities.md#read-support-and-evidence-separately). Do not infer one restriction from a badge on another dimension.

The fingerprint binds the accepted configuration, not future code correctness. If profiles or Workspace facts change, obtain and review a new preview. Start revalidates the configuration; do not work around a stale-preview rejection. Later profile edits affect future runs, not this run's frozen launch snapshot.

The preview does not certify secret isolation, GitHub least privilege, or host containment. Host `gh` authentication is operator authority. An agent running as the same OS user may have access to that user's credentials; a worktree, role instruction, or narrower injected token does not establish a separate identity. Keep merge controls and repository permissions outside the Team's prompt.

## Supervise and review

After starting, inspect **Workflow progress** and **Supervision activity**. Use **Open agent** to see a role's complete timeline; its final Artifact is a bounded result, not the whole conversation.

When the run shows **Needs review**, read the frozen request and its referenced evidence before submitting one of the offered actions. Continue is not always offered. A provider permission wait is separate: follow **Open agent** to inspect and answer it in the agent timeline.

When work finishes:

1. Inspect the Run's **Artifacts** and the Assignment's history. Check content, truncation indicators, and producing run/role/agent, not only titles. Handoffs use exact persisted Artifact references, not whichever output was created most recently.
2. Select **Review changes** to open this Workspace's Changes view. This is the live checkout and can include later edits; Artifacts remain frozen.
3. Inspect actual test output in the producing agent timeline. Run any remaining repository-prescribed checks from an operator terminal in that worktree. A narrative claim that tests passed is not a substitute for the command and exit result.
4. Review the diff and [publish through the host's Git/`gh` CLI](#publish-without-generated-metadata) or the existing Workspace/Forge tools. This example forbids agents from publishing; publishing is a separate operator action. Honor the repository's signing and protected-branch rules, inspect CI, and leave merge approval with a human.
5. Mark the Assignment **Complete** when its objective is satisfied. Update the linked GitHub issue separately if appropriate.

## Publish without generated metadata

The Workspace's one-click **Commit** and **Create PR** actions request generated text from the daemon's Git metadata model. Those requests are separate from the Team's frozen Profiles and can consume additional provider usage. To supply your own commit message and PR text, use a terminal on the selected host, in the reviewed worktree.

Confirm the feature branch and intended fork remote before publishing. Replace the example paths, message, title, and base branch below with your reviewed values. Keep repository hooks and signing enabled; do not publish from the base branch.

```bash
git status --short --branch
git remote -v
git diff
git add -- path/to/reviewed-file
git diff --cached
git commit -S -m "Describe the reviewed change"
git push -u origin HEAD
gh pr create --base main --title "Describe the reviewed change" --body-file /path/to/reviewed-pr-body.md
gh pr view --json url,headRefName,baseRefName
```

Review the PR body file before running the command. Git and `gh` do not ask a model to write it. If a push or PR request fails, keep the local commit and inspect the error before retrying; check `gh pr view` first when publication may already have succeeded.

Return to the same Workspace and open **Pull request** from the new-tab menu. Check its repository, number, title, status, and CI results. Use **Commits** in Changes to inspect the published commit's diff; a clean working tree alone does not prove that the intended commit was published. Reload to verify that the PR remains associated with this Workspace. Do not merge until a human has reviewed the actual diff and required checks.

## Recover without editing stored records

| What you see                                                 | Next action                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub authentication error or unexpected catalog            | Check the selected daemon host, hostname, and active `gh` account there; authenticate the intended account and retry discovery.                                                                                         |
| Update required, or Supervised unavailable                   | Use a CC daemon with the required capabilities. For an authentication reason, fix the persisted-password setup and arrange a safe restart; do not fall back to upstream downloads or a weaker mode.                     |
| Profile missing/invalid, model unavailable, or stale preview | Repair the saved profile or role reference on this host. Reopen admission and inspect the new preview before starting. Historical runs remain unchanged.                                                                |
| Offline or Connecting                                        | Restore the host connection. Reopen the existing Assignment/Run to read its durable state; do not start a duplicate run merely because the client disconnected.                                                         |
| Needs review                                                 | Inspect the pending request and choose an offered action. If no continue action is offered, inspect the blocker and cancel rather than trying to force a resume.                                                        |
| Stopping or Stop failed                                      | Wait for cancellation to settle, or retry **Cancel Run** after addressing the provider failure. The Workspace lock remains held while stopping is unresolved.                                                           |
| Interrupted after daemon restart                             | Inspect the retained Artifacts, agent timelines, and live worktree before starting a new run. Uncertain prompts are not replayed automatically. Safe idle human waits can survive restart and still require a response. |

## Evidence and current limits

The [capability and evidence matrix](https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/capabilities.md) owns the recorded run results, provider mappings, platform coverage, and remaining proof gaps. Consult it before applying this walkthrough to another provider or host; this guide is not cross-platform release certification.
