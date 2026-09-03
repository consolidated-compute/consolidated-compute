import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionInputDto } from "@getpaseo/protocol/team/types";
import type { Locator, Page } from "@playwright/test";
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
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

const PROFILE: AgentProfile = {
  id: "scheduled-team-worker",
  name: "Scheduled Team worker",
  provider: "mock",
  model: "ten-second-stream",
  modeId: "load-test",
};

interface ScheduleClient {
  scheduleList(): Promise<{
    schedules: Array<{ id: string; name: string | null }>;
    error: string | null;
  }>;
  scheduleInspect(input: { id: string }): Promise<{
    schedule: {
      name: string | null;
      runs: Array<{ status: string; teamRunId?: string | null; error: string | null }>;
    } | null;
    error: string | null;
  }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

function teamDefinition(): TeamDefinitionInputDto {
  return {
    name: "Scheduled Delivery Team",
    instructions: "Complete the scheduled Assignment.",
    roles: [
      {
        id: "worker",
        name: "Worker",
        instructions: "Return the requested result.",
        profileId: PROFILE.id,
      },
    ],
    workflow: [{ id: "work", roleId: "worker", instructions: null }],
  };
}

async function choose(page: Page, trigger: Locator, optionTestId: string): Promise<void> {
  await trigger.click();
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(optionTestId).click();
}

async function findSchedule(client: ScheduleClient, name: string) {
  return (await client.scheduleList()).schedules.find((schedule) => schedule.name === name) ?? null;
}

test.describe("Assignment Team Run schedules", () => {
  test("authors, operates, inspects, and follows durable Team Run occurrences", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const profileSeed = await seedAgentProfiles([PROFILE]);
    const workspace = await seedWorkspace({
      repoPrefix: "scheduled-team-run-",
      title: "Scheduled main",
    });
    const assignments: AssignmentsDaemonClient = await connectAssignmentsClient();
    const teams = await connectTeamsClient();
    const createdAssignment = await assignments.createAssignment({
      title: `Scheduled Assignment ${Date.now()}`,
      objective: "Produce a durable scheduled Team Run.",
      workItem: null,
    });
    const createdTeam = await teams.createTeam(teamDefinition());
    const scheduleClient = workspace.client as unknown as ScheduleClient;
    const scheduleName = `Scheduled Team proof ${Date.now()}`;
    let scheduleId: string | null = null;

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page.goto(buildSchedulesRoute());

      await page.getByTestId("schedules-empty-new").click();
      const form = page.getByTestId("schedule-form-sheet");
      await expect(form).toBeVisible();
      await form.getByTestId("schedule-target-assignment-team-run").click();
      await choose(
        page,
        form.getByTestId("schedule-assignment-trigger"),
        `schedule-assignment-option-${createdAssignment.assignment.id}`,
      );
      await choose(
        page,
        form.getByTestId("schedule-team-trigger"),
        `schedule-team-option-${createdTeam.team.id}`,
      );
      await choose(
        page,
        form.getByTestId("schedule-workspace-trigger"),
        `schedule-workspace-option-${workspace.workspaceId}`,
      );
      await expect(form.getByTestId("schedule-team-role-worker")).toContainText("Ready", {
        timeout: 30_000,
      });
      await form.getByLabel("Schedule name").fill(scheduleName);
      await expect(form.getByTestId("schedule-form-submit")).toBeEnabled({ timeout: 30_000 });
      await form.getByTestId("schedule-form-submit").click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });

      await expect.poll(() => findSchedule(scheduleClient, scheduleName)).not.toBeNull();
      scheduleId = (await findSchedule(scheduleClient, scheduleName))?.id ?? null;
      if (!scheduleId) throw new Error("Scheduled Team Run was not persisted");
      const row = page.getByTestId(`schedule-row-${scheduleId}`);
      await expect(row).toContainText(createdAssignment.assignment.title, { timeout: 30_000 });
      await expect(row).toContainText(createdTeam.team.name);
      await expect(row).toContainText("Scheduled main");

      await row.click();
      await expect(form.getByTestId("schedule-latest-occurrence")).toContainText(
        "This schedule has not run yet.",
      );
      await form.getByRole("button", { name: "Open Assignment" }).click();
      await expect(
        page.getByTestId(`assignment-detail-${getServerId()}-${createdAssignment.assignment.id}`),
      ).toBeVisible({ timeout: 30_000 });

      await page.goto(buildSchedulesRoute());
      await page.getByTestId(`schedule-row-${scheduleId}`).click();
      await form.getByLabel("Schedule name").fill(`${scheduleName} edited`);
      await form.getByTestId("schedule-form-submit").click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          async () => (await scheduleClient.scheduleInspect({ id: scheduleId! })).schedule?.name,
        )
        .toBe(`${scheduleName} edited`);

      await page.getByTestId(`schedule-kebab-${scheduleId}`).click();
      await page.getByTestId(`schedule-menu-pause-${scheduleId}`).click();
      await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toContainText("Paused");
      await page.getByTestId(`schedule-kebab-${scheduleId}`).click();
      await page.getByTestId(`schedule-menu-resume-${scheduleId}`).click();
      await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toContainText("Active");

      await page.getByTestId(`schedule-kebab-${scheduleId}`).click();
      await page.getByTestId(`schedule-menu-run-${scheduleId}`).click();
      let teamRunId: string | null = null;
      await expect
        .poll(
          async () => {
            const inspected = await scheduleClient.scheduleInspect({ id: scheduleId! });
            teamRunId = inspected.schedule?.runs.at(-1)?.teamRunId ?? null;
            return teamRunId;
          },
          { timeout: 30_000 },
        )
        .not.toBeNull();

      await page.getByTestId(`schedule-row-${scheduleId}`).click();
      await expect(form.getByTestId("schedule-latest-occurrence")).toContainText("succeeded", {
        timeout: 30_000,
      });
      await form.getByRole("button", { name: "Open Team Run" }).click();
      await expect(page.getByTestId(`team-run-detail-${getServerId()}-${teamRunId}`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("team-run-status")).toContainText("Succeeded", {
        timeout: 70_000,
      });

      await page.goto(buildSchedulesRoute());
      await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toBeVisible();
      await page.getByTestId(`schedule-kebab-${scheduleId}`).click();
      await Promise.all([
        page.waitForEvent("dialog").then((dialog) => dialog.accept()),
        page.getByTestId(`schedule-menu-delete-${scheduleId}`).click(),
      ]);
      await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toHaveCount(0, {
        timeout: 30_000,
      });
      scheduleId = null;
    } finally {
      if (scheduleId)
        await scheduleClient.scheduleDelete({ id: scheduleId }).catch(() => undefined);
      const latestAssignment = await assignments.getAssignment(createdAssignment.assignment.id);
      if (latestAssignment.assignment.state.status === "open") {
        await assignments
          .completeAssignment({
            assignmentId: latestAssignment.assignment.id,
            expectedRevision: latestAssignment.assignment.revision,
          })
          .catch(() => undefined);
      }
      await removeTeam(teams, createdTeam.team.id).catch(() => undefined);
      await assignments.close().catch(() => undefined);
      await teams.close().catch(() => undefined);
      await workspace.cleanup();
      await profileSeed.restore();
    }
  });
});
