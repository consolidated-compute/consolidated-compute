import { rename } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import { connectAssignmentsClient } from "../support/helpers/assignments";
import { chooseAddProjectMethod } from "../support/helpers/add-project-flow";
import { addConnectedHostsAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";

test("creates an agent-free worktree on the Assignment host and returns after a retry", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  test.setTimeout(120_000);
  let repo: Awaited<ReturnType<typeof createTempGitRepo>> | null = null;
  let secondary: Awaited<ReturnType<typeof startIsolatedHostDaemon>> | null = null;
  let secondaryClient: Awaited<ReturnType<typeof connectSeedClient>> | null = null;
  let assignments: Awaited<ReturnType<typeof connectAssignmentsClient>> | null = null;
  let projectId: string | null = null;
  try {
    repo = await createTempGitRepo("assignment-workspace-setup");
    secondary = await startIsolatedHostDaemon("assignment-other-host");
    secondaryClient = await connectSeedClient({ port: secondary.port });
    assignments = await connectAssignmentsClient();
    const { assignment } = await assignments.createAssignment({
      title: "Prepare a checkout for this Assignment",
      objective: "Keep Workspace setup separate from Team Run admission.",
      workItem: null,
    });
    const serverId = getServerId();
    const assignmentPath = `/assignments/${serverId}/${assignment.id}`;
    await page.goto(assignmentPath);
    await addConnectedHostsAndReload(page, [
      { serverId: secondary.serverId, label: "Other host", port: secondary.port },
    ]);
    await page.getByTestId(`assignment-create-workspace-${serverId}-${assignment.id}`).click();
    await expect(page).toHaveURL(/\/new\?.*assignmentId=/);
    await expect(page.getByTestId("host-picker-trigger")).toHaveCount(0);
    await expect(page.getByTestId("message-input-root")).toHaveCount(0);
    await expect(page.getByTestId("assignment-workspace-create")).toBeDisabled();

    await page.getByTestId("new-workspace-project-picker-trigger").click();
    await page.getByTestId("new-workspace-project-picker-add-project").click();
    await chooseAddProjectMethod(page, "directory-search");
    await page.getByTestId("add-project-flow-input").fill(repo.path);
    await page.getByTestId("add-project-flow-input").press("Enter");
    await expect(page).toHaveURL(/\/new\?.*projectId=/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("assignmentId")).toBe(assignment.id);
    expect(url.searchParams.get("serverId")).toBe(serverId);
    projectId = url.searchParams.get("projectId");
    expect(
      (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
    ).toEqual([projectId]);
    await reloadPreservingHostRegistry(page);
    await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
      "New worktree",
    );
    const create = page.getByTestId("assignment-workspace-create");
    await expect(create).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("assignment-workspace-desktop.png") });

    const unavailablePath = `${repo.path}-unavailable`;
    await rename(repo.path, unavailablePath);
    try {
      await create.click();
      await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
      await expect(create).toBeEnabled();
      expect((await e2eWorkerClient.fetchWorkspaces()).entries).toEqual([]);
    } finally {
      await rename(unavailablePath, repo.path);
    }
    await create.click();
    await expect(page).toHaveURL(new RegExp(`${assignmentPath}$`), { timeout: 30_000 });
    await expect(
      page.getByText(
        "Workspace created. Select Run Team when you are ready to review its launch settings.",
        { exact: true },
      ),
    ).toBeVisible();
    const { entries } = await e2eWorkerClient.fetchWorkspaces();
    expect(entries).toHaveLength(1);
    expect(entries[0].projectRootPath).toBe(repo.path);
    expect(entries[0].workspaceDirectory).not.toBe(repo.path);
    expect((await e2eWorkerClient.fetchAgents()).entries).toEqual([]);
    expect((await e2eWorkerClient.listTerminals()).terminals).toEqual([]);
    expect((await secondaryClient.listProjects()).projects).toEqual([]);
    expect((await secondaryClient.fetchWorkspaces()).entries).toEqual([]);
    expect((await assignments.getAssignment(assignment.id)).assignment).toEqual(assignment);
  } finally {
    if (projectId) await e2eWorkerClient.removeProject(projectId);
    await assignments?.close();
    await secondaryClient?.close();
    await secondary?.close();
    await repo?.cleanup();
  }
});

test("compact setup returns to the Assignment without creating a Workspace", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  const assignments = await connectAssignmentsClient();
  try {
    const { assignment } = await assignments.createAssignment({
      title: "Return from compact Workspace setup",
      objective: "No launch or Workspace should be created when backing out.",
      workItem: null,
    });
    const serverId = getServerId();
    const assignmentPath = `/assignments/${serverId}/${assignment.id}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(assignmentPath);
    await page.getByTestId(`assignment-create-workspace-${serverId}-${assignment.id}`).click();
    await expect(page.getByTestId("assignment-workspace-create")).toBeDisabled();
    await expect(page.getByTestId("message-input-root")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("assignment-workspace-compact.png") });
    await page.getByRole("button", { name: "Back to Assignment", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${assignmentPath}$`));
    expect((await e2eWorkerClient.fetchWorkspaces()).entries).toEqual([]);
    expect((await e2eWorkerClient.fetchAgents()).entries).toEqual([]);

    await page.goto("/new");
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await expect(page.getByTestId("workspace-create-submit")).toBeVisible();
    await expect(page.getByTestId("assignment-workspace-create")).toHaveCount(0);
  } finally {
    await assignments.close();
  }
});
