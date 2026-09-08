import { expect, type Page, type TestInfo } from "@playwright/test";
import { reloadPreservingHostRegistry } from "./hosts";
import {
  startGithubWorkProof,
  saveGithubWorkProofTeam,
  GITHUB_WORK_PROOF_OBJECTIVE,
} from "./github-work-proof";
import { chooseAddProjectMethod } from "./add-project-flow";

// Callers open GitHub Work with the proof host registered in their browser or
// real Electron context. The shared journey stops before any agent turns.
export async function prepareGithubWorkRun(
  page: Page,
  proof: Awaited<ReturnType<typeof startGithubWorkProof>>,
  testInfo: TestInfo,
  options?: { reloadAssignment?: (assignmentId: string) => Promise<void> },
) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("github-work-host-field").getByRole("button").click();
  await page.getByTestId(`github-work-host-${proof.serverId}`).click();
  await page.getByTestId("github-work-site").fill("unconfigured.invalid");
  await page.getByTestId("github-work-repositories-submit").click();
  await expect(page.getByTestId("github-work-error")).toContainText("gh auth login");
  await page.getByTestId("github-work-site").fill("github.com");
  await page
    .getByTestId("github-work-repositories-search")
    .fill("consolidated-compute/consolidated-compute");
  await page.getByTestId("github-work-repositories-submit").click();
  const repository = page
    .locator('[data-testid^="github-work-repository-"]')
    .filter({ hasText: "consolidated-compute/consolidated-compute" });
  await expect(repository).toHaveCount(1);
  expect((await proof.client.fetchWorkspaces()).entries).toEqual([]);
  await repository.click();
  // The proof issue remains selectable after its objective is completed on GitHub.
  await page.getByTestId("github-work-all").click();
  await page.getByTestId("github-work-work-search").fill('"prove issue" in:title');
  await page.getByTestId("github-work-work-submit").click();
  await page.locator('[data-testid^="github-work-item-"]').filter({ hasText: "#135" }).click();
  await expect(page.getByTestId("github-work-body")).toContainText("Golden flow");
  const issueScreenshot = testInfo.outputPath("real-github-issue.png");
  await page.screenshot({ path: issueScreenshot });
  await testInfo.attach("real-github-issue", {
    path: issueScreenshot,
    contentType: "image/png",
  });
  await page.getByTestId("github-work-create-assignment").click();
  await page.getByTestId("assignment-form-objective").fill(GITHUB_WORK_PROOF_OBJECTIVE);
  await page.getByTestId("assignment-form-save").click();
  await expect(page).toHaveURL(/\/assignments\/[^/]+\/asgn_/);
  const assignmentId = new URL(page.url()).pathname.split("/").at(-1)!;
  const { assignment } = await proof.client.getAssignment(assignmentId);
  expect(assignment.workItem?.url).toBe(
    "https://github.com/consolidated-compute/consolidated-compute/issues/135",
  );
  expect(assignment.objective).toBe(GITHUB_WORK_PROOF_OBJECTIVE);
  expect(JSON.stringify(assignment)).not.toContain("Golden flow");
  expect((await proof.client.fetchWorkspaces()).entries).toEqual([]);
  if (options?.reloadAssignment) {
    await options.reloadAssignment(assignmentId);
  } else {
    await reloadPreservingHostRegistry(page);
  }
  await expect(page.getByTestId(`assignment-detail-${proof.serverId}-${assignmentId}`)).toBeVisible(
    { timeout: 30_000 },
  );

  await proof.prepareCheckout();
  const { team } = await saveGithubWorkProofTeam(proof.client, proof.checkout);
  await page.getByTestId(`assignment-create-workspace-${proof.serverId}-${assignmentId}`).click();
  await expect(page.getByTestId("host-picker-trigger")).toHaveCount(0);
  await expect(page.getByTestId("message-input-root")).toHaveCount(0);
  await page.getByTestId("new-workspace-project-picker-trigger").click();
  await page.getByTestId("new-workspace-project-picker-add-project").click();
  await chooseAddProjectMethod(page, "directory-search");
  await page.getByTestId("add-project-flow-input").fill(proof.checkout);
  await page.getByTestId("add-project-flow-input").press("Enter");
  await expect(page).toHaveURL(/\/new\?.*projectId=/);
  expect(new URL(page.url()).searchParams.get("assignmentId")).toBe(assignmentId);
  expect(new URL(page.url()).searchParams.get("serverId")).toBe(proof.serverId);
  // Navigation can retain the previous setup screen hidden in the route stack.
  await expect(
    page.locator('[data-testid="workspace-create-isolation-trigger"]:visible'),
  ).toContainText("New worktree");
  await page.locator('[data-testid="assignment-workspace-create"]:visible').click();
  await expect(page).toHaveURL(/\/assignments\/[^/]+\/asgn_[^?]+\?workspaceId=/, {
    timeout: 60_000,
  });
  const workspaces = (await proof.client.fetchWorkspaces()).entries;
  expect(workspaces).toHaveLength(1);
  const workspace = workspaces[0]!;
  expect(workspace.workspaceDirectory).not.toBe(proof.checkout);
  expect(workspace.projectRootPath).toBe(proof.checkout);
  expect(new URL(page.url()).pathname).toBe(`/assignments/${proof.serverId}/${assignmentId}`);
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(workspace.id);
  expect((await proof.client.fetchAgents()).entries).toEqual([]);
  expect((await proof.client.listTeamRuns()).runs).toEqual([]);
  expect((await proof.client.getAssignment(assignmentId)).assignment).toEqual(assignment);
  if (options?.reloadAssignment) {
    await options.reloadAssignment(assignmentId);
  } else {
    await reloadPreservingHostRegistry(page);
  }
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(workspace.id);
  await page.getByTestId(`assignment-run-open-${proof.serverId}-${assignmentId}`).click();
  await page.getByTestId(`assignment-team-${proof.serverId}-${team.id}`).click();
  await expect(page.getByTestId("team-run-workspace-field")).toContainText(workspace.name);
  await page.getByTestId("team-run-mode-supervised").click();
  await page.getByTestId("team-run-supervisor-field").click();
  await page.getByTestId("team-run-supervisor-supervisor").click();
  await expect(page.getByTestId("team-run-start")).toBeEnabled({ timeout: 60_000 });
  const { preview } = await proof.client.previewTeamRun({
    teamId: team.id,
    expectedRevision: team.revision,
    workspaceId: workspace.id,
  });
  expect(
    preview.roles.map(({ resolvedLaunch }) => ({
      model: resolvedLaunch.model,
      thinkingOptionId: resolvedLaunch.thinkingOptionId,
    })),
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      model: "gpt-5.3-codex-spark",
      thinkingOptionId: "low",
    })),
  );
  await expect(page.getByTestId("team-run-security-preview-fingerprint")).toContainText(
    preview.fingerprint,
  );
  const previewScreenshot = testInfo.outputPath("real-security-preview.png");
  await page.screenshot({ path: previewScreenshot });
  await testInfo.attach("real-security-preview", {
    path: previewScreenshot,
    contentType: "image/png",
  });
  return { assignment, team, workspace, preview };
}
