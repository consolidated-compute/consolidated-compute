import type { Locator, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionInputDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import {
  connectAssignmentsClient,
  type AssignmentsDaemonClient,
} from "../support/helpers/assignments";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { connectTeamsClient, removeTeam } from "../support/helpers/teams";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  openAssignmentRunForReview,
  openTeamRunAgentForReview,
  openTeamRunChangesForReview,
} from "../support/helpers/team-run-review";

const WORKER_PROFILE: AgentProfile = {
  id: "assignment-worker",
  name: "Assignment worker",
  provider: "mock",
  model: "ten-second-stream",
  modeId: "load-test",
};

const SUPERVISOR_PROFILE: AgentProfile = {
  ...WORKER_PROFILE,
  id: "assignment-supervisor",
  name: "Assignment supervisor",
};

test.describe("Assignments reliability", () => {
  test("preserves authored intent, frozen runs, and exact Artifacts", async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const profiles = await seedAgentProfiles([WORKER_PROFILE, SUPERVISOR_PROFILE]);
    const workspace = await seedWorkspace({
      repoPrefix: "assignments-reliability-",
      title: "Assignments reliability",
    });
    const assignments = await connectAssignmentsClient();
    const teams = await connectTeamsClient();
    const createdTeam = await teams.createTeam(oneRoleTeam());
    let assignmentId: string | null = null;

    try {
      await openAssignments(page);

      await test.step("create durable execution intent through the form", async () => {
        await page.getByTestId("assignments-new").click();
        const form = page.getByTestId("assignment-form-sheet");
        await expect(form).toBeVisible();
        await form.getByTestId("assignment-form-title").fill("Assignment surface proof");
        await form
          .getByTestId("assignment-form-objective")
          .fill("Produce one exact bounded Artifact from a saved Team.");
        await expect(form.getByTestId("assignment-form-save")).toBeEnabled();
        await form.getByTestId("assignment-form-save").click();
        await expect(form).toHaveCount(0, { timeout: 30_000 });

        const assignment = await waitForAssignment(assignments, "Assignment surface proof");
        assignmentId = assignment.id;
        await expect(page.getByTestId(assignmentDetailTestId(assignment.id))).toBeVisible();
      });

      const persistedAssignmentId = assignmentId;
      if (!persistedAssignmentId) throw new Error("Assignment ID was not captured");

      await test.step("recover a stale edit without losing draft input", async () => {
        await page.getByTestId(assignmentTestId("assignment-edit", persistedAssignmentId)).click();
        const form = page.getByTestId("assignment-form-sheet");
        await form.getByTestId("assignment-form-title").fill("Preserved Assignment draft");

        const beforeConflict = await assignments.getAssignment(persistedAssignmentId);
        await assignments.patchAssignment({
          assignmentId: persistedAssignmentId,
          expectedRevision: beforeConflict.assignment.revision,
          patch: {
            objective: "A concurrent edit that the preserved draft will supersede.",
          },
        });

        await form.getByTestId("assignment-form-save").click();
        await expect(form.getByTestId("assignment-form-revision-recovered")).toBeVisible({
          timeout: 30_000,
        });
        await expect(form.getByTestId("assignment-form-title")).toHaveValue(
          "Preserved Assignment draft",
        );
        await form.getByTestId("assignment-form-save").click();
        await expect(form).toHaveCount(0, { timeout: 30_000 });
        await expect(
          page.getByText("Preserved Assignment draft", { exact: true }).first(),
        ).toBeVisible();

        const afterRecovery = await assignments.getAssignment(persistedAssignmentId);
        await assignments.patchAssignment({
          assignmentId: persistedAssignmentId,
          expectedRevision: afterRecovery.assignment.revision,
          patch: {
            workItem: {
              sourceId: "github",
              sourceLabel: "GitHub",
              resourceType: "issue",
              resourceId: "consolidated-compute/consolidated-compute:issue:71",
              identifier: "#71",
              title: "Assignments: add management, run, and Artifact surfaces",
              url: "https://github.com/consolidated-compute/consolidated-compute/issues/71",
            },
          },
        });
        await expect(
          page.getByTestId(assignmentTestId("assignment-work-item", persistedAssignmentId)),
        ).toContainText("#71", { timeout: 30_000 });
      });

      let runId: string | null = null;
      await test.step("launch only same-host saved resources and render the frozen facts", async () => {
        await page
          .getByTestId(assignmentTestId("assignment-run-open", persistedAssignmentId))
          .click();
        await page.getByTestId(`assignment-team-${getServerId()}-${createdTeam.team.id}`).click();
        const form = page.getByTestId("team-run-form-sheet");
        await expect(form.getByTestId("team-run-assignment")).toContainText(
          "Preserved Assignment draft",
        );
        await expect(form.getByTestId("team-run-objective")).toHaveCount(0);
        await chooseSelectOption(
          page,
          form.getByTestId("team-run-workspace-field"),
          `team-run-workspace-${workspace.workspaceId}`,
        );
        await expect(form.getByTestId("team-run-execution-mode")).toHaveCount(0);
        await expect(form.getByTestId("team-run-supervisor-field")).toHaveCount(0);
        await expect(form.getByTestId("team-run-start")).toBeEnabled({ timeout: 30_000 });
        await form.getByTestId("team-run-start").click();
        await expect(
          page.getByTestId(assignmentTestId("team-run-frozen-assignment", persistedAssignmentId)),
        ).toContainText("Preserved Assignment draft", { timeout: 30_000 });
        runId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
      });

      const persistedRunId = runId;
      if (!persistedRunId) throw new Error("Team Run ID was not captured");
      const reviewTarget = {
        serverId: getServerId(),
        assignmentId: persistedAssignmentId,
        runId: persistedRunId,
        workspaceId: workspace.workspaceId,
      };
      const runDetail = page
        .getByTestId(`team-run-detail-${getServerId()}-${persistedRunId}`)
        .filter({ visible: true });

      await test.step("materialize and inspect the exact step Artifact", async () => {
        await expect(runDetail.getByTestId("team-run-status")).toContainText("Succeeded", {
          timeout: 70_000,
        });
        const artifacts = runDetail.getByTestId(
          assignmentRunTestId("team-run-artifacts", persistedAssignmentId, persistedRunId),
        );
        await expect(artifacts).toContainText("Worker output", { timeout: 30_000 });
        await expect(artifacts).toContainText("team_step_output · worker · work");
        await waitForArtifactCount(assignments, persistedAssignmentId, 1);
      });

      await test.step("wait for persisted layout restoration on a cold Run link", async () => {
        const release = await holdWorkspaceLayoutHydration(page);
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-workspace-layout-read", "pending");
        await expect(runDetail.getByTestId("team-run-status")).toContainText("Succeeded");
        const review = runDetail.getByTestId("team-run-review-changes");
        await expect(review).toBeVisible();
        await expect(review).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath("team-run-review-hydrating.png") });
        await release();
        await expect(review).toBeEnabled();
      });

      await test.step("review the run Workspace through the existing Changes view", async () => {
        // A deterministic filesystem fixture exercises review navigation without
        // asking a paid provider to generate another change.
        await writeFile(
          path.join(workspace.workspaceDirectory, "review-checklist.md"),
          "# Review handoff\nInspect the diff and test results.\nLeave merge to a human.\n",
        );
        const changes = await openTeamRunChangesForReview(page, reviewTarget);
        await expect(changes.getByTestId("diff-file-0")).toHaveAccessibleName(
          "review-checklist.md, +3, -0",
          { timeout: 30_000 },
        );
        await expect(changes.getByTestId("git-diff-canvas")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("team-run-review-desktop.png") });

        await page.locator('[data-testid="sidebar-assignments"]:visible').click();
        await page.getByTestId(assignmentTestId("assignment-row", persistedAssignmentId)).click();
        await page
          .getByTestId(assignmentRunTestId("assignment-run", persistedAssignmentId, persistedRunId))
          .click();
        await expect(runDetail.getByTestId("team-run-review-changes")).toBeVisible();
      });

      await test.step("open the exact producing agent and return through Assignment history", async () => {
        const { run } = await assignments.getTeamRun(persistedRunId);
        const worker = run.steps[0]!;
        if (worker.state.status !== "succeeded") throw new Error("Worker did not succeed");
        await openTeamRunAgentForReview(page, reviewTarget, {
          stepId: worker.snapshot.stepId,
          agentId: worker.state.agentId,
        });
        const decoy = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.workspaceDirectory,
          workspaceId: workspace.workspaceId,
          title: "Unrelated review agent",
          modeId: "load-test",
          model: "e2e-fast-stream",
          initialPrompt: "Keep another completed timeline available during run review.",
        });
        await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: decoy.id });
        const workerTab = page
          .getByTestId(`workspace-tab-agent_${worker.state.agentId}`)
          .filter({ visible: true })
          .first();
        const decoyTab = page
          .getByTestId(`workspace-tab-agent_${decoy.id}`)
          .filter({ visible: true })
          .first();
        await expect(decoyTab).toHaveAttribute("aria-selected", "true");
        await expect(workerTab).toBeVisible();
        await expect(workerTab).toHaveAttribute("aria-selected", "false");
        await expect(
          page.getByTestId("assistant-message").filter({ visible: true }).first(),
        ).toBeVisible();
        await openAssignmentRunForReview(page, reviewTarget);
        await openTeamRunAgentForReview(page, reviewTarget, {
          stepId: worker.snapshot.stepId,
          agentId: worker.state.agentId,
        });
        await expect(decoyTab).toBeVisible();
        await expect(decoyTab).toHaveAttribute("aria-selected", "false");
        await page.screenshot({ path: testInfo.outputPath("team-run-worker-timeline.png") });
        await openAssignmentRunForReview(page, reviewTarget);
        await expect(runDetail.getByTestId("team-run-status-succeeded")).toBeVisible();
      });

      await test.step("retain review navigation across compact layout and reload", async () => {
        await page.setViewportSize({ width: 480, height: 900 });
        const review = runDetail.getByTestId("team-run-review-changes");
        // The compact screen replaces the desktop element during the resize.
        await review.click({ trial: true });
        await page.screenshot({ path: testInfo.outputPath("team-run-review-compact.png") });
        await review.click();
        const changes = page.getByTestId("working-diff-panel").filter({ visible: true });
        await expect(changes.getByTestId("diff-file-0")).toHaveAccessibleName(
          "review-checklist.md, +3, -0",
          { timeout: 30_000 },
        );
        await page.reload();
        await expect(changes.getByTestId("diff-file-0")).toHaveAccessibleName(
          "review-checklist.md, +3, -0",
          { timeout: 30_000 },
        );
        await expect(changes.getByTestId("git-diff-canvas")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("team-run-review-compact-diff.png") });
        await page.setViewportSize({ width: 1280, height: 900 });
      });

      await test.step("later edits and completion leave frozen history unchanged", async () => {
        // Sidebar navigation retains the run screen. Scope Artifact assertions to
        // the Assignment so both mounted copies cannot satisfy the same locator.
        await page.locator('[data-testid="sidebar-assignments"]:visible').click();
        await page.getByTestId(assignmentTestId("assignment-row", persistedAssignmentId)).click();
        const detail = page.getByTestId(assignmentDetailTestId(persistedAssignmentId));
        await expect(detail).toBeVisible({
          timeout: 30_000,
        });
        const { artifacts } = await assignments.listAssignmentArtifacts({
          assignmentId: persistedAssignmentId,
        });
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts[0]!;
        await expect(
          detail.getByTestId(
            assignmentTestId("assignment-artifact", persistedAssignmentId, artifact.id),
          ),
        ).toContainText(artifact.producer.agentId);
        await page.getByTestId(assignmentTestId("assignment-edit", persistedAssignmentId)).click();
        const form = page.getByTestId("assignment-form-sheet");
        await form.getByTestId("assignment-form-title").fill("Current Assignment title");
        await form.getByTestId("assignment-form-save").click();
        await expect(form).toHaveCount(0, { timeout: 30_000 });

        await page
          .getByTestId(assignmentRunTestId("assignment-run", persistedAssignmentId, persistedRunId))
          .click();
        await expect(
          runDetail.getByTestId(
            assignmentTestId("team-run-frozen-assignment", persistedAssignmentId),
          ),
        ).toContainText("Preserved Assignment draft");
        await expect(
          runDetail.getByTestId(
            assignmentRunTestId("team-run-artifacts", persistedAssignmentId, persistedRunId),
          ),
        ).toContainText("Worker output");
        await page.reload();
        await expect(
          runDetail.getByTestId(
            assignmentRunTestId("team-run-artifacts", persistedAssignmentId, persistedRunId),
          ),
        ).toContainText("Worker output", { timeout: 30_000 });

        await page.getByRole("button", { name: "Back", exact: true }).first().click();
        const confirmation = acceptNextDialog(page);
        await page
          .getByTestId(assignmentTestId("assignment-complete", persistedAssignmentId))
          .click();
        expect(await confirmation).toContain("Mark Current Assignment title complete?");
        await expect(
          page.getByTestId(
            assignmentTestId("assignment-status", persistedAssignmentId, "completed"),
          ),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByTestId(assignmentTestId("assignment-run-open", persistedAssignmentId)),
        ).toBeDisabled();
      });
    } finally {
      await Promise.allSettled([
        removeTeam(teams, createdTeam.team.id),
        assignments.close(),
        teams.close(),
        workspace.cleanup(),
        profiles.restore(),
      ]);
    }
  });
});

async function holdWorkspaceLayoutHydration(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    localStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({ version: 2, state: { layoutByWorkspace: {} } }),
    );
    sessionStorage.setItem("hold-workspace-layout-read", "1");
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("hold-workspace-layout-read") !== "1") return;
    sessionStorage.removeItem("hold-workspace-layout-read");
    const getItem = Storage.prototype.getItem;
    // AsyncStorage resolves this read as a Promise. Hold only its layout
    // value to reproduce native storage latency; other reads stay real.
    Object.defineProperty(Storage.prototype, "getItem", {
      configurable: true,
      value: function (this: Storage, key: string) {
        const value = getItem.call(this, key);
        if (this !== localStorage || key !== "workspace-layout-state") return value;
        Object.defineProperty(Storage.prototype, "getItem", {
          configurable: true,
          value: getItem,
        });
        document.documentElement.dataset.workspaceLayoutRead = "pending";
        return new Promise<string | null>((resolve) => {
          window.addEventListener("release-workspace-layout-read", () => resolve(value), {
            once: true,
          });
        });
      },
    });
  });
  return () =>
    page.evaluate(() => window.dispatchEvent(new Event("release-workspace-layout-read")));
}

async function openAssignments(page: Page): Promise<void> {
  await gotoAppShell(page);
  const link = page.locator('[data-testid="sidebar-assignments"]:visible').first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(page.getByTestId("assignments-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`assignments-host-${getServerId()}`)).toContainText("Online", {
    timeout: 30_000,
  });
}

function assignmentDetailTestId(assignmentId: string): string {
  return assignmentTestId("assignment-detail", assignmentId);
}

function assignmentTestId(prefix: string, assignmentId: string, suffix?: string): string {
  const base = `${prefix}-${getServerId()}-${assignmentId}`;
  return suffix ? `${base}-${suffix}` : base;
}

function assignmentRunTestId(prefix: string, assignmentId: string, runId: string): string {
  return assignmentTestId(prefix, assignmentId, runId);
}

async function findAssignment(client: AssignmentsDaemonClient, title: string) {
  return (
    (await client.listAssignments()).assignments.find((entry) => entry.title === title) ?? null
  );
}

async function waitForAssignment(client: AssignmentsDaemonClient, title: string) {
  await expect.poll(() => findAssignment(client, title), { timeout: 30_000 }).not.toBeNull();
  const assignment = await findAssignment(client, title);
  if (!assignment) throw new Error(`Assignment ${title} was not persisted`);
  return assignment;
}

async function artifactCount(
  client: AssignmentsDaemonClient,
  assignmentId: string,
): Promise<number> {
  return (await client.listAssignmentArtifacts({ assignmentId })).artifacts.length;
}

async function waitForArtifactCount(
  client: AssignmentsDaemonClient,
  assignmentId: string,
  count: number,
): Promise<void> {
  await expect.poll(() => artifactCount(client, assignmentId), { timeout: 30_000 }).toBe(count);
}

async function chooseSelectOption(page: Page, field: Locator, optionTestId: string): Promise<void> {
  await field.getByRole("button").click();
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(optionTestId).click();
}

async function acceptNextDialog(page: Page): Promise<string> {
  const dialog = await page.waitForEvent("dialog");
  const message = dialog.message();
  await dialog.accept();
  return message;
}

function oneRoleTeam(): TeamDefinitionInputDto {
  return {
    name: "Assignment Artifact Team",
    instructions: "Produce the requested bounded result.",
    roles: [
      {
        id: "worker",
        name: "Worker",
        instructions: "Return the final Assignment result.",
        profileId: WORKER_PROFILE.id,
      },
      {
        id: "supervisor",
        name: "Supervisor",
        instructions: "Coordinate the saved worker plan.",
        profileId: SUPERVISOR_PROFILE.id,
      },
    ],
    workflow: [{ id: "work", roleId: "worker", instructions: null }],
  };
}
