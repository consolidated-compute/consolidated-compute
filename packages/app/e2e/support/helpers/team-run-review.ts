import { expect, type Page } from "@playwright/test";

export interface TeamRunReviewTarget {
  serverId: string;
  assignmentId: string;
  runId: string;
  workspaceId: string;
}

export function teamRunReviewDetail(page: Page, target: TeamRunReviewTarget) {
  return page
    .getByTestId(`team-run-detail-${target.serverId}-${target.runId}`)
    .filter({ visible: true });
}

export async function openAssignmentRunForReview(page: Page, target: TeamRunReviewTarget) {
  await page.locator('[data-testid="sidebar-assignments"]:visible').click();
  await page.getByTestId(`assignment-row-${target.serverId}-${target.assignmentId}`).click();
  const assignment = page
    .getByTestId(`assignment-detail-${target.serverId}-${target.assignmentId}`)
    .filter({ visible: true });
  await assignment
    .getByTestId(`assignment-run-${target.serverId}-${target.assignmentId}-${target.runId}`)
    .click();
  await expect(teamRunReviewDetail(page, target)).toBeVisible();
}

export async function openTeamRunAgentForReview(
  page: Page,
  target: TeamRunReviewTarget,
  step: { stepId: string; agentId: string },
) {
  await teamRunReviewDetail(page, target).getByTestId(`team-run-step-agent-${step.stepId}`).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/h/${target.serverId}/workspace/${target.workspaceId}`,
  );
  await expect(
    page.getByTestId(`workspace-tab-agent_${step.agentId}`).filter({ visible: true }).first(),
  ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(
    page.getByTestId("assistant-message").filter({ visible: true }).first(),
  ).toBeVisible();
}

export async function openTeamRunChangesForReview(page: Page, target: TeamRunReviewTarget) {
  await teamRunReviewDetail(page, target).getByTestId("team-run-review-changes").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/h/${target.serverId}/workspace/${target.workspaceId}`,
  );
  const changes = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(changes).toBeVisible({ timeout: 30_000 });
  await expect(changes.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
  return changes;
}
