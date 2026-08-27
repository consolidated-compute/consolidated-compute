import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionDto, TeamDefinitionInputDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostsAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { getServerId } from "../support/helpers/server-id";
import { connectTeamsClient, removeTeam, type TeamsDaemonClient } from "../support/helpers/teams";
import { seedWorkspace } from "../support/helpers/seed-client";

const ORIGINAL_PROFILES: AgentProfile[] = [
  {
    id: "architect",
    name: "Architect",
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
  },
  {
    id: "builder",
    name: "Builder",
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
  },
];

const EDITED_PROFILES: AgentProfile[] = [
  {
    ...ORIGINAL_PROFILES[0]!,
    name: "Architect v2",
    model: "one-minute-stream",
  },
  ORIGINAL_PROFILES[1]!,
  ORIGINAL_PROFILES[2]!,
];

test.describe("Teams reliability", () => {
  test("authors a profile-backed Team and freezes accepted work across profile churn", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const profiles = await seedAgentProfiles(ORIGINAL_PROFILES);
    const workspace = await seedWorkspace({
      repoPrefix: "teams-reliability-",
      title: "Teams reliability",
    });
    const client = await connectTeamsClient();
    let teamId: string | null = null;
    let runUrl: string | null = null;
    let runId: string | null = null;

    try {
      await openTeams(page);

      const authored = await authorPlanImplementReviewTeam(page, client);
      teamId = authored.id;
      expect(authored.workflow.map((step) => step.roleId)).toEqual([
        authored.roles[0]!.id,
        authored.roles[1]!.id,
        authored.roles[2]!.id,
      ]);

      await test.step("run admission resolves all three host-local profiles", async () => {
        await page.getByTestId(`team-run-open-${getServerId()}-${teamId}`).click();
        const form = page.getByTestId("team-run-form-sheet");
        await expect(form).toBeVisible();
        await chooseSelectOption(
          page,
          form.getByTestId("team-run-workspace-field"),
          `team-run-workspace-${workspace.workspaceId}`,
        );
        await form
          .getByTestId("team-run-objective")
          .fill("Prove that a frozen Team Run survives live profile changes.");

        for (const role of authored.roles) {
          const preview = form.getByTestId(`team-run-role-${role.id}`);
          await expect(preview).toContainText("Ready", { timeout: 30_000 });
          await expect(preview).toContainText("mock · ten-second-stream · load-test");
        }
        await expect(form.getByTestId("team-run-start")).toBeEnabled();
        await form.getByTestId("team-run-start").click();
        await expect(page.getByTestId("team-run-status")).toContainText("Waiting for permission", {
          timeout: 30_000,
        });
        runUrl = page.url();
        runId = new URL(runUrl).pathname.split("/").at(-1) ?? null;
      });

      await test.step("accepted work ignores profile rename, edit, and deletion", async () => {
        await profiles.replace(EDITED_PROFILES.slice(0, 2));

        const plannerStep = page.getByTestId(`team-run-step-${authored.workflow[0]!.id}`);
        await plannerStep.getByRole("button", { name: "Open agent", exact: true }).click();
        await waitForPermissionPrompt(page);
        await allowPermission(page);
        await page.goBack();

        await expect(page.getByTestId("team-run-status")).toContainText("Succeeded", {
          timeout: 70_000,
        });
        for (const [index, step] of authored.workflow.entries()) {
          const card = page.getByTestId(`team-run-step-${step.id}`);
          await expect(card).toContainText(ORIGINAL_PROFILES[index]!.id);
          await expect(card).toContainText("mock · ten-second-stream · load-test");
          await expect(card).toContainText("Succeeded");
        }
      });

      await test.step("reload and later Team edits cannot rewrite the historical snapshot", async () => {
        await page.reload();
        await expect(page.getByTestId("team-run-status")).toContainText("Succeeded", {
          timeout: 30_000,
        });
        await expect(page.getByText("Delivery Team", { exact: true }).first()).toBeVisible();

        await profiles.replace(EDITED_PROFILES);
        await page.getByRole("button", { name: "Back", exact: true }).first().click();
        await expect(page.getByTestId(`team-detail-${getServerId()}-${teamId}`)).toBeVisible({
          timeout: 30_000,
        });
        await page.getByTestId(`team-edit-${getServerId()}-${teamId}`).click();
        const editForm = page.getByTestId("team-form-sheet");
        await editForm.getByTestId("team-form-name").fill("Delivery Team v2");
        await editForm.getByTestId("team-form-save").click();
        await expect(editForm).toHaveCount(0, { timeout: 30_000 });

        if (!runId) throw new Error(`Could not read Team Run ID from ${runUrl}`);
        await page.getByTestId(`team-run-row-${runId}`).click();
        await expect(page.getByTestId("team-run-status")).toContainText("Succeeded", {
          timeout: 30_000,
        });
        await expect(page.getByText("Delivery Team", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Delivery Team v2", { exact: true })).toHaveCount(0);
      });

      await test.step("future starts reflect edits and fail explicitly until repaired", async () => {
        await page.getByRole("button", { name: "Back", exact: true }).first().click();
        await page.getByTestId(`team-run-open-${getServerId()}-${teamId}`).click();
        const form = page.getByTestId("team-run-form-sheet");
        await chooseSelectOption(
          page,
          form.getByTestId("team-run-workspace-field"),
          `team-run-workspace-${workspace.workspaceId}`,
        );
        await form
          .getByTestId("team-run-objective")
          .fill("Prove future starts use the current profile catalog.");
        const architect = form.getByTestId(`team-run-role-${authored.roles[0]!.id}`);
        await expect(architect).toContainText("Architect v2", { timeout: 30_000 });
        await expect(architect).toContainText("mock · one-minute-stream · load-test");

        await profiles.replace(EDITED_PROFILES.slice(0, 2));
        const reviewer = form.getByTestId(`team-run-role-${authored.roles[2]!.id}`);
        await expect(reviewer).toContainText("Profile missing", { timeout: 30_000 });
        await expect(form.getByTestId("team-run-start")).toBeDisabled();
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(form).toHaveCount(0);

        await profiles.replace([
          ...EDITED_PROFILES.slice(0, 2),
          { ...ORIGINAL_PROFILES[2]!, model: "removed-model" },
        ]);
        await page.getByTestId(`team-run-open-${getServerId()}-${teamId}`).click();
        const unavailableForm = page.getByTestId("team-run-form-sheet");
        const unavailableReviewer = unavailableForm.getByTestId(
          `team-run-role-${authored.roles[2]!.id}`,
        );
        await expect(unavailableReviewer).toContainText("Model unavailable", {
          timeout: 30_000,
        });
        await unavailableForm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(unavailableForm).toHaveCount(0);

        await profiles.replace(EDITED_PROFILES);
        await page.getByTestId(`team-run-open-${getServerId()}-${teamId}`).click();
        const repairedForm = page.getByTestId("team-run-form-sheet");
        await chooseSelectOption(
          page,
          repairedForm.getByTestId("team-run-workspace-field"),
          `team-run-workspace-${workspace.workspaceId}`,
        );
        await repairedForm
          .getByTestId("team-run-objective")
          .fill("Prove repaired profiles are admitted.");
        const repairedReviewerStatus = repairedForm.locator(
          `[data-testid^="team-run-role-status-${authored.roles[2]!.id}-"]`,
        );
        await expectTestId(
          repairedReviewerStatus,
          `team-run-role-status-${authored.roles[2]!.id}-ready`,
        );
        await expect(repairedForm.getByTestId("team-run-start")).toBeEnabled();
      });
    } finally {
      if (teamId) await removeTeam(client, teamId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await workspace.cleanup();
      await profiles.restore();
    }
  });

  test("surfaces a failed step and cancels active work from the Team Run UI", async ({ page }) => {
    test.setTimeout(90_000);
    const profiles = await seedAgentProfiles([
      {
        id: "failure-check",
        name: "Failure check",
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
      },
      {
        id: "slow-runner",
        name: "Slow runner",
        provider: "mock",
        model: "one-minute-stream",
        modeId: "load-test",
      },
    ]);
    const workspace = await seedWorkspace({
      repoPrefix: "teams-run-states-",
      title: "Teams run states",
    });
    const client = await connectTeamsClient();
    const teamIds: string[] = [];

    try {
      const failedTeam = await client.createTeam(
        oneRoleTeam({
          name: "Failure Team",
          profileId: "failure-check",
          roleInstructions: "Emit a synthetic turn failure.",
        }),
      );
      teamIds.push(failedTeam.team.id);
      const cancelTeam = await client.createTeam(
        oneRoleTeam({
          name: "Cancellation Team",
          profileId: "slow-runner",
          roleInstructions: "Keep working until canceled.",
        }),
      );
      teamIds.push(cancelTeam.team.id);

      await openTeams(page);

      await test.step("a deterministic provider failure reaches the Run detail", async () => {
        await openTeam(page, failedTeam.team.id);
        await startRun(page, {
          teamId: failedTeam.team.id,
          workspaceId: workspace.workspaceId,
          objective: "Expose a failed Team step.",
        });
        await expect(page.getByTestId("team-run-status")).toContainText("Failed", {
          timeout: 30_000,
        });
        await expect(page.getByTestId("team-run-step-work")).toContainText("Failed");
        await expect(page.getByTestId("team-run-step-work")).toContainText(
          "Requested mock provider failure",
        );
      });

      await test.step("cancel confirmation stops an active run", async () => {
        await page.getByRole("button", { name: "Back", exact: true }).first().click();
        await openTeam(page, cancelTeam.team.id);
        await startRun(page, {
          teamId: cancelTeam.team.id,
          workspaceId: workspace.workspaceId,
          objective: "Cancel this active Team Run.",
        });
        await expect(page.getByTestId("team-run-status")).toContainText("Running", {
          timeout: 30_000,
        });

        const confirmation = acceptNextDialog(page);
        await page.getByTestId("team-run-cancel").click();
        expect(await confirmation).toContain("Stop the active work for Cancellation Team?");

        await expect(page.getByTestId("team-run-status")).toContainText("Canceled", {
          timeout: 30_000,
        });
        await expect(page.getByTestId("team-run-step-work")).toContainText("Canceled");
      });
    } finally {
      for (const teamId of teamIds) {
        await removeTeam(client, teamId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await workspace.cleanup();
      await profiles.restore();
    }
  });

  test("keeps Team identity and availability host-qualified", async ({ page }) => {
    test.setTimeout(180_000);
    const duplicateDaemon = await startIsolatedHostDaemon("srv_teams_duplicate");
    const emptyDaemon = await startIsolatedHostDaemon("srv_teams_empty");
    const oldDaemon = await startIsolatedHostDaemon("srv_teams_old", {
      publishedVersion: "0.2.5",
    });
    const primaryProfiles = await seedAgentProfiles([ORIGINAL_PROFILES[0]!]);
    const duplicateProfiles = await seedAgentProfiles([ORIGINAL_PROFILES[0]!], {
      port: duplicateDaemon.port,
    });
    const emptyProfiles = await seedAgentProfiles(
      [
        {
          id: "empty-host-profile",
          name: "Empty host profile",
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        },
      ],
      { port: emptyDaemon.port },
    );
    const primaryClient = await connectTeamsClient();
    const duplicateClient = await connectTeamsClient({ port: duplicateDaemon.port });
    let primaryTeamId: string | null = null;

    try {
      const definition = oneRoleTeam({
        name: "Host-qualified Team",
        profileId: ORIGINAL_PROFILES[0]!.id,
        roleInstructions: "Keep Team identity scoped to its host.",
      });
      const primaryTeam = await primaryClient.createTeam(definition);
      const duplicateTeam = await duplicateClient.createTeam(definition);
      primaryTeamId = primaryTeam.team.id;
      await rewriteTeamId(duplicateDaemon.paseoHome, duplicateTeam.team.id, primaryTeam.team.id);

      await gotoAppShell(page);
      await addConnectedHostsAndReload(
        page,
        [
          {
            serverId: duplicateDaemon.serverId,
            label: "Duplicate Team host",
            port: duplicateDaemon.port,
          },
          {
            serverId: emptyDaemon.serverId,
            label: "Profiles-only host",
            port: emptyDaemon.port,
          },
          {
            serverId: oldDaemon.serverId,
            label: "Old host",
            port: oldDaemon.port,
          },
        ],
        { primaryLabel: "Primary Team host" },
      );
      await page.locator('[data-testid="sidebar-teams"]:visible').first().click();
      await expect(page.getByTestId("teams-list")).toBeVisible({ timeout: 30_000 });

      const primaryRow = page.getByTestId(`team-row-${getServerId()}-${primaryTeam.team.id}`);
      const duplicateRow = page.getByTestId(
        `team-row-${duplicateDaemon.serverId}-${primaryTeam.team.id}`,
      );
      await expect(primaryRow).toBeVisible({ timeout: 30_000 });
      await expect(duplicateRow).toBeVisible({ timeout: 30_000 });

      const emptyHost = page.getByTestId(`teams-host-${emptyDaemon.serverId}`);
      await expect(emptyHost).toContainText("Online", { timeout: 30_000 });
      await expect(emptyHost).toContainText("No Teams on this host");

      const oldHost = page.getByTestId(`teams-host-${oldDaemon.serverId}`);
      await expect(oldHost).toContainText("Update required", { timeout: 30_000 });
      await expect(oldHost).toContainText("This host needs an update before it can manage Teams.");

      await duplicateDaemon.close();
      const offlineHost = page.getByTestId(`teams-host-${duplicateDaemon.serverId}`);
      await expect(offlineHost).toContainText(/Offline|Error/, { timeout: 30_000 });
      await expect(duplicateRow).toBeVisible();
      await duplicateRow.click();
      await expect(page.getByTestId("team-detail-readonly")).toContainText(
        "This Team is read-only until its host is online.",
        { timeout: 30_000 },
      );
    } finally {
      if (primaryTeamId) {
        await removeTeam(primaryClient, primaryTeamId).catch(() => undefined);
      }
      await Promise.allSettled([
        primaryClient.close(),
        duplicateClient.close(),
        primaryProfiles.restore(),
        duplicateProfiles.restore(),
        emptyProfiles.restore(),
        duplicateDaemon.close(),
        emptyDaemon.close(),
        oldDaemon.close(),
      ]);
    }
  });
});

async function rewriteTeamId(
  paseoHome: string,
  currentTeamId: string,
  replacementTeamId: string,
): Promise<void> {
  const definitionsDir = path.join(paseoHome, "teams", "definitions");
  const currentPath = path.join(definitionsDir, `${currentTeamId}.json`);
  const replacementPath = path.join(definitionsDir, `${replacementTeamId}.json`);
  const definition = JSON.parse(await readFile(currentPath, "utf8")) as { id: string };
  await writeFile(replacementPath, `${JSON.stringify({ ...definition, id: replacementTeamId })}\n`);
  await unlink(currentPath);
}

async function expectTestId(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.getAttribute("data-testid"), { timeout: 30_000 }).toBe(expected);
}

async function acceptNextDialog(page: Page): Promise<string> {
  const dialog = await page.waitForEvent("dialog");
  const message = dialog.message();
  await dialog.accept();
  return message;
}

async function openTeams(page: Page): Promise<void> {
  await gotoAppShell(page);
  const teams = page.locator('[data-testid="sidebar-teams"]:visible').first();
  await expect(teams).toBeVisible({ timeout: 30_000 });
  await teams.click();
  await expect(page.getByTestId("teams-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`teams-host-${getServerId()}`)).toContainText("Online", {
    timeout: 30_000,
  });
}

async function authorPlanImplementReviewTeam(
  page: Page,
  client: TeamsDaemonClient,
): Promise<TeamDefinitionDto> {
  await page.getByTestId("teams-new").click();
  const form = page.getByTestId("team-form-sheet");
  await expect(form).toBeVisible();
  await form.getByTestId("team-form-name").fill("Delivery Team");
  await form
    .getByTestId("team-form-instructions")
    .fill("Complete the objective in workflow order.");

  await form.getByTestId("team-form-add-role").click();
  await form.getByTestId("team-form-add-role").click();
  const roleIds = await dynamicCardIds(form, "team-form-role-", [
    "team-form-role-name-",
    "team-form-role-profile-",
    "team-form-role-instructions-",
  ]);
  expect(roleIds).toHaveLength(3);
  const roleDrafts = [
    {
      name: "Plan",
      profileId: "architect",
      instructions: "Emit synthetic plan approval.",
    },
    { name: "Implement", profileId: "builder", instructions: "Implement the approved plan." },
    { name: "Review", profileId: "reviewer", instructions: "Review the implementation." },
  ];
  for (const [index, roleId] of roleIds.entries()) {
    const draft = roleDrafts[index]!;
    await form.getByTestId(`team-form-role-name-${roleId}`).fill(draft.name);
    await form.getByTestId(`team-form-role-instructions-${roleId}`).fill(draft.instructions);
    await chooseSelectOption(
      page,
      form.getByTestId(`team-form-role-profile-${roleId}`),
      `team-form-profile-${draft.profileId}`,
    );
  }

  await form.getByTestId("team-form-add-step").click();
  await form.getByTestId("team-form-add-step").click();
  const stepIds = await dynamicCardIds(form, "team-form-step-", [
    "team-form-step-role-",
    "team-form-step-instructions-",
    "team-form-step-up-",
    "team-form-step-down-",
  ]);
  expect(stepIds).toHaveLength(3);

  // Author Plan → Review → Implement, then prove the visible reorder control fixes it.
  await chooseRole(page, form, stepIds[1]!, "Review");
  await chooseRole(page, form, stepIds[2]!, "Implement");
  await form.getByTestId(`team-form-step-up-${stepIds[2]}`).click();

  await expect(form.getByTestId("team-form-save")).toBeEnabled();
  await form.getByTestId("team-form-save").click();
  await expect(form).toHaveCount(0, { timeout: 30_000 });

  await expect
    .poll(
      async () => (await client.listTeams()).teams.some((team) => team.name === "Delivery Team"),
      { timeout: 30_000 },
    )
    .toBe(true);
  const team = (await client.listTeams()).teams.find(
    (candidate) => candidate.name === "Delivery Team",
  );
  if (!team) throw new Error("Delivery Team was not persisted");
  return team;
}

async function openTeam(page: Page, teamId: string): Promise<void> {
  await page.getByTestId(`team-row-${getServerId()}-${teamId}`).click();
  await expect(page.getByTestId(`team-detail-${getServerId()}-${teamId}`)).toBeVisible({
    timeout: 30_000,
  });
}

async function startRun(
  page: Page,
  input: { teamId: string; workspaceId: string; objective: string },
): Promise<void> {
  await page.getByTestId(`team-run-open-${getServerId()}-${input.teamId}`).click();
  const form = page.getByTestId("team-run-form-sheet");
  await chooseSelectOption(
    page,
    form.getByTestId("team-run-workspace-field"),
    `team-run-workspace-${input.workspaceId}`,
  );
  await form.getByTestId("team-run-objective").fill(input.objective);
  await expect(form.getByTestId("team-run-start")).toBeEnabled({ timeout: 30_000 });
  await form.getByTestId("team-run-start").click();
  await expect(page.getByTestId("team-run-status")).toBeVisible({ timeout: 30_000 });
}

function oneRoleTeam(input: {
  name: string;
  profileId: string;
  roleInstructions: string;
}): TeamDefinitionInputDto {
  return {
    name: input.name,
    instructions: "Exercise one Team Run terminal state.",
    roles: [
      {
        id: "worker",
        name: "Worker",
        instructions: input.roleInstructions,
        profileId: input.profileId,
      },
    ],
    workflow: [{ id: "work", roleId: "worker", instructions: null }],
  };
}

async function chooseRole(
  page: Page,
  form: Locator,
  stepId: string,
  roleName: string,
): Promise<void> {
  await form.getByTestId(`team-form-step-role-${stepId}`).getByRole("button").click();
  await page
    .getByTestId("combobox-desktop-container")
    .getByRole("button", { name: roleName, exact: true })
    .click();
}

async function chooseSelectOption(page: Page, field: Locator, optionTestId: string): Promise<void> {
  await field.getByRole("button").click();
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(optionTestId).click();
}

async function dynamicCardIds(
  form: Locator,
  prefix: string,
  nestedPrefixes: string[],
): Promise<string[]> {
  const testIds = await form
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  return testIds
    .filter((testId): testId is string => Boolean(testId))
    .filter((testId) => !nestedPrefixes.some((nested) => testId.startsWith(nested)))
    .map((testId) => testId.slice(prefix.length));
}
