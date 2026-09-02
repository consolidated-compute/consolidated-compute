import { expect, type Page } from "@playwright/test";
import { allowPermission, waitForPermissionPrompt } from "./permissions";
import type { SupervisedTeamSurfaceScenario } from "./supervised-team-scenario";

export async function exerciseSupervisedTeamSurface(
  page: Page,
  scenario: SupervisedTeamSurfaceScenario,
  capture?: (name: string) => Promise<void>,
): Promise<void> {
  const assignmentsLink = page.locator('[data-testid="sidebar-assignments"]:visible').first();
  await expect(assignmentsLink).toBeVisible({ timeout: 30_000 });
  await assignmentsLink.click();

  const assignmentIdentity = `${scenario.serverId}-${scenario.assignmentId}`;
  await page.getByTestId(`assignment-row-${assignmentIdentity}`).click();
  await expect(page.getByTestId(`assignment-detail-${assignmentIdentity}`)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId(`assignment-run-${assignmentIdentity}-${scenario.runId}`).click();
  await expect(page.getByTestId("team-run-status")).toContainText("Waiting for permission", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("team-run-provider-permission")).toBeVisible();
  await capture?.("supervised-provider-permission");

  await page.getByTestId("team-run-provider-permission-open-agent").click();
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 30_000 },
  );
  await expect(
    page.getByTestId(`workspace-tab-agent_${scenario.workerAgentId}`).first(),
  ).toBeVisible({ timeout: 30_000 });
  await waitForPermissionPrompt(page);
  await allowPermission(page);
  await page.goBack();

  await expect(page.getByTestId("team-run-supervision-review")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("team-run-supervision-summary")).toContainText("Needs review");
  await capture?.("supervised-human-checkpoint");
  await page.getByTestId("team-run-supervision-review").click();

  const responseSheet = page.getByTestId("team-supervision-response-sheet");
  await expect(responseSheet).toBeVisible();
  await responseSheet.getByTestId("team-supervision-response-action-field").click();
  await page.getByTestId("team-supervision-response-action-continue").click();
  await responseSheet
    .getByTestId("team-supervision-response-note")
    .fill("Approved through the supervised Team Run.");
  await responseSheet.getByTestId("team-supervision-response-submit").click();

  await expect(responseSheet).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("team-run-status")).toContainText("Succeeded", {
    timeout: 30_000,
  });
  const activity = page.getByTestId("team-run-supervision-activity");
  await expect(activity).toContainText("Human response: Continue");
  await expect(activity).toContainText("Approved through the supervised Team Run.");
  await capture?.("supervised-completed");
}
