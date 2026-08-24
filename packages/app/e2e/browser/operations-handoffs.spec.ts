import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../support/fixtures";
import { expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { expectComposerEditable, submitMessage } from "../support/helpers/composer";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { expectPermissionActions, waitForPermissionPrompt } from "../support/helpers/permissions";
import { waitForQuestionPrompt } from "../support/helpers/questions";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedParentWithCrossWorkspaceSubagent } from "../support/helpers/subagents";

const WIDE_VIEWPORT = { width: 1280, height: 900 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function openOperations(page: Page): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill("Operations");
  await panel.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
}

async function returnToOperations(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-operations"]:visible').click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
}

async function expectActiveAgentStopped(page: Page, agentId: string): Promise<void> {
  const activeTab = page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true });
  await expect(activeTab.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /stop agent|canceling agent/i })).toHaveCount(0);
  await expectComposerEditable(page);
}

test.describe("Operations handoffs", () => {
  test.describe.configure({ timeout: 300_000 });

  test("uses canonical agent and workspace surfaces for every action", async ({
    page,
  }, testInfo) => {
    const primaryServerId = getServerId();
    const primary = await seedWorkspace({
      repoPrefix: "operations-handoffs-primary-",
      title: "Operations handoffs primary",
    });
    const secondaryDaemon = await startIsolatedHostDaemon("operations-handoffs-secondary");
    const secondary = await seedWorkspace({
      repoPrefix: "operations-handoffs-secondary-",
      title: "Operations handoffs secondary",
      port: secondaryDaemon.port,
    });

    try {
      const planAgent = await secondary.client.createAgent({
        provider: "mock",
        cwd: secondary.repoPath,
        workspaceId: secondary.workspaceId,
        title: "Plan approval handoff",
        modeId: "load-test",
        model: "ten-second-stream",
        initialPrompt: "Emit synthetic plan approval.",
      });
      const parkedPlan = await secondary.client.waitForFinish(planAgent.id, 15_000);
      expect(parkedPlan.status).toBe("permission");

      const questionAgent = await primary.client.createAgent({
        provider: "mock",
        cwd: primary.repoPath,
        workspaceId: primary.workspaceId,
        title: "Question handoff",
        modeId: "load-test",
        model: "ten-second-stream",
        initialPrompt: "Emit synthetic questions.",
      });
      const parkedQuestion = await primary.client.waitForFinish(questionAgent.id, 15_000);
      expect(parkedQuestion.status).toBe("permission");

      const runningAgent = await primary.client.createAgent({
        provider: "mock",
        cwd: primary.repoPath,
        workspaceId: primary.workspaceId,
        title: "Running handoff",
        modeId: "load-test",
        model: "five-minute-stream",
        initialPrompt: "stay running",
      });
      await primary.client.waitForAgentUpsert(
        runningAgent.id,
        (snapshot) => snapshot.status === "running",
        15_000,
      );

      const idleAgent = await primary.client.createAgent({
        provider: "mock",
        cwd: primary.repoPath,
        workspaceId: primary.workspaceId,
        title: "Idle handoff",
        modeId: "load-test",
        model: "ten-second-stream",
      });
      expect(idleAgent.status).toBe("idle");

      const relatedAgents = await seedParentWithCrossWorkspaceSubagent(primary, {
        parentTitle: "Cross-workspace parent",
        childTitle: "Cross-workspace child",
      });

      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Operations handoffs secondary",
        port: secondaryDaemon.port,
        primaryLabel: "Operations handoffs primary",
      });
      await openOperations(page);

      await test.step("wide view exposes navigation without mutation controls", async () => {
        await expect(
          page.getByTestId(`operations-agent-${secondaryDaemon.serverId}-${planAgent.id}`),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByTestId(`operations-agent-${primaryServerId}-${questionAgent.id}`),
        ).toBeVisible();
        await expect(page.getByTestId("permission-request-accept")).toHaveCount(0);
        await expect(page.getByTestId("permission-request-deny")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
        await capture(page, testInfo, "operations-handoffs-wide");
      });

      await test.step("workspace rows hand off to the existing workspace surface", async () => {
        await page
          .getByTestId(`operations-workspace-${primaryServerId}-${primary.workspaceId}`)
          .click();
        await expect(page).toHaveURL(
          new RegExp(`/h/${primaryServerId}/workspace/${encodeURIComponent(primary.workspaceId)}`),
          { timeout: 30_000 },
        );
        await returnToOperations(page);
      });

      await test.step("permission rows preserve plan details and provider actions", async () => {
        await page
          .getByTestId(`operations-agent-${secondaryDaemon.serverId}-${planAgent.id}`)
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            `/h/${secondaryDaemon.serverId}/workspace/${encodeURIComponent(secondary.workspaceId)}`,
          ),
          { timeout: 30_000 },
        );
        await expectAgentTabActive(page, planAgent.id);
        await waitForPermissionPrompt(page, 30_000);
        const planCard = page.getByTestId("permission-plan-card");
        await expect(planCard).toContainText(
          "Review the proposed plan before implementation starts.",
        );
        await expect(planCard).toContainText("Add the README note.");
        await expectPermissionActions(page, ["Implement", "Dismiss"]);
        await returnToOperations(page);
      });

      await test.step("question rows preserve the existing question form", async () => {
        await page.getByTestId(`operations-agent-${primaryServerId}-${questionAgent.id}`).click();
        await expectAgentTabActive(page, questionAgent.id);
        await waitForQuestionPrompt(page, 30_000);
        const questionCard = page.getByTestId("question-form-card").first();
        await expect(questionCard).toContainText("Which surface should this apply to?");
        await expect(questionCard.getByRole("radio", { name: "App", exact: true })).toBeVisible();
        await expect(
          questionCard.getByRole("radio", { name: "Desktop", exact: true }),
        ).toBeVisible();
        await returnToOperations(page);
      });

      await test.step("running rows hand off to the existing Stop action", async () => {
        await page.getByTestId(`operations-agent-${primaryServerId}-${runningAgent.id}`).click();
        await expectAgentTabActive(page, runningAgent.id);
        await expectAgentReadyToInterrupt(page);
        await page.getByRole("button", { name: "Stop agent", exact: true }).click();
        await expectActiveAgentStopped(page, runningAgent.id);
        await returnToOperations(page);
      });

      await test.step("idle rows hand off to the existing composer", async () => {
        const followUp = "Follow up from the canonical agent composer.";
        await page.getByTestId(`operations-agent-${primaryServerId}-${idleAgent.id}`).click();
        await expectAgentTabActive(page, idleAgent.id);
        await expectComposerEditable(page);
        await submitMessage(page, followUp);
        await expect(page.getByText(followUp, { exact: true })).toBeVisible({ timeout: 30_000 });
        await expectAgentReadyToInterrupt(page);
        await page.getByRole("button", { name: "Stop agent", exact: true }).click();
        await expectActiveAgentStopped(page, idleAgent.id);
        await returnToOperations(page);
      });

      await test.step("cross-workspace rows keep both agents in their owning workspaces", async () => {
        await page
          .getByTestId(`operations-agent-${primaryServerId}-${relatedAgents.child.id}`)
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            `/h/${primaryServerId}/workspace/${encodeURIComponent(relatedAgents.child.workspaceId)}`,
          ),
          { timeout: 30_000 },
        );
        await expectAgentTabActive(page, relatedAgents.child.id);
        await expect(
          page
            .getByTestId(`workspace-tab-agent_${relatedAgents.child.id}`)
            .filter({ visible: true }),
        ).toHaveCount(1);
        await returnToOperations(page);

        await page
          .getByTestId(`operations-agent-${primaryServerId}-${relatedAgents.parent.id}`)
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            `/h/${primaryServerId}/workspace/${encodeURIComponent(relatedAgents.parent.workspaceId)}`,
          ),
          { timeout: 30_000 },
        );
        await expectAgentTabActive(page, relatedAgents.parent.id);
        await expect(
          page
            .getByTestId(`workspace-tab-agent_${relatedAgents.parent.id}`)
            .filter({ visible: true }),
        ).toHaveCount(1);
        await returnToOperations(page);
      });

      await test.step("offline cached attention stays a read-only handoff", async () => {
        await secondaryDaemon.close();
        await expect(page.getByTestId("operations-partial-hosts")).toBeVisible({
          timeout: 30_000,
        });
        const cachedPlanRow = page.getByTestId(
          `operations-agent-${secondaryDaemon.serverId}-${planAgent.id}`,
        );
        await expect(cachedPlanRow).toContainText("Last known");
        await expect(cachedPlanRow.getByTestId("permission-request-accept")).toHaveCount(0);
        await expect(cachedPlanRow.getByTestId("permission-request-deny")).toHaveCount(0);
        await expect(
          cachedPlanRow.getByRole("button", { name: "Stop agent", exact: true }),
        ).toHaveCount(0);
      });

      await test.step("compact view keeps the same read-only handoff rows", async () => {
        await page.setViewportSize(COMPACT_VIEWPORT);
        await expect(page.getByTestId("operations-screen")).toBeVisible();
        await expect(
          page.getByTestId(`operations-agent-${primaryServerId}-${idleAgent.id}`),
        ).toBeVisible();
        await expect(
          page.getByTestId(`operations-agent-${secondaryDaemon.serverId}-${planAgent.id}`),
        ).toContainText("Last known");
        await capture(page, testInfo, "operations-handoffs-compact");
      });
    } finally {
      await secondary.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
      await primary.cleanup().catch(() => undefined);
    }
  });
});
