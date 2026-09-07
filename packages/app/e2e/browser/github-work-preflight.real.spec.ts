import { expect, test } from "../support/fixtures";
import { addConnectedHostAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import {
  startGithubWorkProof,
  saveGithubWorkProofTeam,
  GITHUB_WORK_PROOF_OBJECTIVE,
} from "../support/helpers/github-work-proof";
import { chooseAddProjectMethod } from "../support/helpers/add-project-flow";

// Opt-in real-host preflight for #135. Stop before Start: no agent turns or GitHub writes.
test("completes real GitHub Work preflight without starting an agent", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const proof = await startGithubWorkProof();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/github-work");
    await addConnectedHostAndReload(page, { ...proof, label: "GitHub proof host" });
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
    await reloadPreservingHostRegistry(page);
    await expect(
      page.getByTestId(`assignment-detail-${proof.serverId}-${assignmentId}`),
    ).toBeVisible({ timeout: 30_000 });

    await proof.prepareCheckout();
    const { team } = await saveGithubWorkProofTeam(proof.client, proof.checkout);
    await page.getByTestId("sidebar-add-project").click();
    await page.getByTestId(`add-project-flow-host-${proof.serverId}`).click();
    await chooseAddProjectMethod(page, "directory-search");
    await page.getByTestId("add-project-flow-input").fill(proof.checkout);
    await page.getByTestId("add-project-flow-input").press("Enter");
    await expect(page).toHaveURL(/\/new\?.*projectId=/);
    await page.getByTestId("workspace-create-isolation-trigger").click();
    await page.getByTestId("workspace-create-isolation-worktree").click();
    await page
      .getByTestId("message-input-root")
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
    const workspaces = (await proof.client.fetchWorkspaces()).entries;
    expect(workspaces).toHaveLength(1);
    const workspace = workspaces[0]!;
    expect(workspace.workspaceDirectory).not.toBe(proof.checkout);
    await page.locator('[data-testid="sidebar-assignments"]:visible').click();
    await page.getByTestId(`assignment-row-${proof.serverId}-${assignmentId}`).click();
    await page.getByTestId(`assignment-run-open-${proof.serverId}-${assignmentId}`).click();
    await page.getByTestId(`assignment-team-${proof.serverId}-${team.id}`).click();
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
  } finally {
    await proof.cleanup();
  }
});
