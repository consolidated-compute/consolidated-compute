import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { installOperationsHostFixture } from "../support/helpers/operations-host-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  seedParentWithCrossWorkspaceSubagent,
  seedParentWithSubagent,
} from "../support/helpers/subagents";

const WIDE_VIEWPORT = { width: 1280, height: 900 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function expectSummaryTotal(page: Page, expected: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const values = await Promise.all(
          ["working", "attention", "idle"].map(async (bucket) => {
            const text = await page.getByTestId(`operations-summary-${bucket}`).textContent();
            return Number.parseInt(text ?? "0", 10);
          }),
        );
        return values.reduce((total, value) => total + value, 0);
      },
      { timeout: 30_000 },
    )
    .toBe(expected);
}

async function reloadWithoutResettingHosts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Expected an e2e seed nonce before reloading Operations.");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  });
  await page.reload();
}

async function expectProviderSnapshotRequests(
  fixture: Awaited<ReturnType<typeof installOperationsHostFixture>>,
  expected: number,
): Promise<void> {
  await expect
    .poll(() => fixture.providerSnapshotRequestCount(), { timeout: 30_000 })
    .toBe(expected);
}

async function useDarkLargeInterfaceText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = "@paseo:app-settings";
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...stored, theme: "dark", uiBaseFontSize: 21 }));
  });
}

test.describe("Operations", () => {
  test.describe.configure({ timeout: 300_000 });

  test("keeps managed work visible when an older daemon lacks provider activity", async ({
    page,
  }) => {
    const serverId = getServerId();
    const workspace = await seedWorkspace({
      repoPrefix: "operations-old-daemon-",
      title: "Older daemon workspace",
    });

    try {
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Managed work from older daemon",
        modeId: "load-test",
        model: "ten-second-stream",
      });
      const fixture = await installOperationsHostFixture(page, {
        port: getE2EDaemonPort(),
        providerSubagents: [],
        providerSubagentActivitySupported: false,
      });

      await gotoAppShell(page);
      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("Operations");
      await panel.getByRole("button", { name: "Operations", exact: true }).click();

      await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`operations-agent-${serverId}-${agent.id}`)).toBeVisible();
      await expect(page.getByTestId("operations-provider-subagents-partial")).toBeVisible();
      expect(fixture.providerSnapshotRequestCount()).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows a multi-host hierarchy and navigates from every app entry point", async ({
    page,
  }, testInfo) => {
    const primaryServerId = getServerId();
    const primary = await seedWorkspace({
      repoPrefix: "operations-primary-",
      title: "Primary operations workspace",
    });
    const secondaryDaemon = await startIsolatedHostDaemon("operations-secondary");
    const secondary = await seedWorkspace({
      repoPrefix: "operations-secondary-",
      title: "Secondary operations workspace",
      port: secondaryDaemon.port,
    });

    try {
      const sameWorkspace = await seedParentWithSubagent(primary, {
        parentTitle: "Primary parent",
        childTitle: "Nested helper",
      });
      const crossWorkspace = await seedParentWithCrossWorkspaceSubagent(primary, {
        parentTitle: "Release parent",
        childTitle: "Cross-workspace helper",
      });
      const secondaryAgent = await secondary.client.createAgent({
        provider: "mock",
        cwd: secondary.repoPath,
        workspaceId: secondary.workspaceId,
        title: "Secondary host worker",
        modeId: "load-test",
        model: "five-minute-stream",
        initialPrompt: "stay running",
      });
      await secondary.client.waitForAgentUpsert(
        secondaryAgent.id,
        (snapshot) => snapshot.status === "running",
        15_000,
      );
      const reviewAgent = await primary.client.createAgent({
        provider: "mock",
        cwd: primary.repoPath,
        workspaceId: primary.workspaceId,
        title: "Completed work to review",
        modeId: "load-test",
        model: "ten-second-stream",
        featureValues: { mockAssistantResponse: "Ready for review." },
        initialPrompt: "Complete this work for review.",
      });
      const completedReview = await primary.client.waitForFinish(reviewAgent.id, 15_000);
      expect(completedReview.status).toBe("idle");

      const now = new Date().toISOString();
      const duplicateProviderSubagentId = "duplicate-provider-child";
      const primaryFixture = await installOperationsHostFixture(page, {
        port: getE2EDaemonPort(),
        providerSubagents: [
          {
            id: duplicateProviderSubagentId,
            parentAgentId: sameWorkspace.parent.id,
            provider: "codex",
            title: "Provider-native reviewer",
            description: "Review the primary host changes",
            status: "failed",
            createdAt: now,
            updatedAt: now,
            toolCallId: "primary-provider-call",
            subtitle: "Primary host native child",
          },
        ],
      });
      const secondaryFixture = await installOperationsHostFixture(page, {
        port: secondaryDaemon.port,
        providerSubagents: [
          {
            id: duplicateProviderSubagentId,
            parentAgentId: secondaryAgent.id,
            provider: "claude",
            title: "Provider-native explorer",
            description: "Inspect the secondary host",
            status: "completed",
            createdAt: now,
            updatedAt: now,
            toolCallId: "secondary-provider-call",
            subtitle: "Secondary host native child",
          },
        ],
      });

      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
      expect(primaryFixture.providerSnapshotRequestCount()).toBe(0);
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Secondary operations host",
        port: secondaryDaemon.port,
        primaryLabel: "Primary operations host",
      });

      await test.step("Command Center opens the global route", async () => {
        const panel = await openCommandCenter(page);
        await panel.getByTestId("command-center-input").fill("Operations");
        await panel.getByRole("button", { name: "Operations", exact: true }).click();
        await expect(page).toHaveURL(/\/operations$/);
        await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
        await expectProviderSnapshotRequests(primaryFixture, 1);
        await expectProviderSnapshotRequests(secondaryFixture, 1);

        await reloadWithoutResettingHosts(page);
        await expect(page).toHaveURL(/\/operations$/);
        await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
      });

      await test.step("wide view groups projects, workspaces, agents, and subagents", async () => {
        await expectSummaryTotal(page, 8);
        await expectProviderSnapshotRequests(primaryFixture, 2);
        await expectProviderSnapshotRequests(secondaryFixture, 2);
        await expect(
          page.getByTestId(`operations-workspace-${primaryServerId}-${primary.workspaceId}`),
        ).toBeVisible();
        await expect(
          page.getByTestId(
            `operations-workspace-${secondaryDaemon.serverId}-${secondary.workspaceId}`,
          ),
        ).toBeVisible();

        const nestedChildren = page.getByTestId(
          `operations-agent-children-${primaryServerId}-${sameWorkspace.parent.id}`,
        );
        await expect(
          nestedChildren.getByTestId(
            `operations-agent-${primaryServerId}-${sameWorkspace.child.id}`,
          ),
        ).toBeVisible();

        const crossWorkspaceRow = page.getByTestId(
          `operations-agent-${primaryServerId}-${crossWorkspace.child.id}`,
        );
        await expect(crossWorkspaceRow).toContainText("Release parent");
        await expect(
          page.getByTestId(`operations-agent-${secondaryDaemon.serverId}-${secondaryAgent.id}`),
        ).toBeVisible();
        await expect(
          page.getByTestId(`operations-agent-${primaryServerId}-${reviewAgent.id}`),
        ).toContainText("Attention");
        await expect(
          page.getByTestId(
            `operations-provider-subagent-${primaryServerId}-${sameWorkspace.parent.id}-${duplicateProviderSubagentId}`,
          ),
        ).toContainText("Failed");
        await expect(
          page.getByTestId(
            `operations-provider-subagent-${primaryServerId}-${sameWorkspace.parent.id}-${duplicateProviderSubagentId}`,
          ),
        ).toHaveAccessibleName(
          "Review the primary host changes. Provider subagent. Failed. Primary host native child",
        );
        await expect(
          page.getByTestId(
            `operations-provider-subagent-${secondaryDaemon.serverId}-${secondaryAgent.id}-${duplicateProviderSubagentId}`,
          ),
        ).toContainText("Idle");
        await capture(page, testInfo, "operations-wide");
      });

      await test.step("workspace and agent drill-down return through the desktop sidebar", async () => {
        await page
          .getByTestId(`operations-workspace-${secondaryDaemon.serverId}-${secondary.workspaceId}`)
          .getByRole("button", { name: /^Open workspace Secondary operations workspace\./ })
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            `/h/${secondaryDaemon.serverId}/workspace/${encodeURIComponent(secondary.workspaceId)}`,
          ),
          { timeout: 30_000 },
        );
        await page.locator('[data-testid="sidebar-operations"]:visible').click();
        await expect(page).toHaveURL(/\/operations$/);

        const secondaryAgentRow = page.getByTestId(
          `operations-agent-${secondaryDaemon.serverId}-${secondaryAgent.id}`,
        );
        await secondaryAgentRow.focus();
        await secondaryAgentRow.press("Enter");
        await expect(page).toHaveURL(
          new RegExp(
            `/h/${secondaryDaemon.serverId}/workspace/${encodeURIComponent(secondary.workspaceId)}`,
          ),
          { timeout: 30_000 },
        );
        await page.locator('[data-testid="sidebar-operations"]:visible').click();
        await expect(page).toHaveURL(/\/operations$/);
      });

      await test.step("compact sidebar preserves the same global route", async () => {
        await page.setViewportSize(COMPACT_VIEWPORT);
        await expect(page.getByTestId("operations-screen")).toBeVisible();
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        const compactOperations = page.locator('[data-testid="sidebar-operations"]:visible');
        await expect(compactOperations).toBeVisible();
        await page.locator('[data-testid="sidebar-sessions"]:visible').click();
        await expect(page).toHaveURL(/\/sessions$/);

        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        await page.locator('[data-testid="sidebar-operations"]:visible').click();
        await expect(page).toHaveURL(/\/operations$/);
        await expect(page.getByTestId("sidebar-close")).not.toBeVisible();
        await expectSummaryTotal(page, 8);
        await expect(page.getByTestId("operations-refresh")).toBeVisible();
        await capture(page, testInfo, "operations-compact");
      });

      await test.step("dark theme and large interface text preserve the compact hierarchy", async () => {
        await useDarkLargeInterfaceText(page);
        await reloadWithoutResettingHosts(page);
        await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
        await expectSummaryTotal(page, 8);
        await expect(
          page.getByTestId(
            `operations-provider-subagent-${secondaryDaemon.serverId}-${secondaryAgent.id}-${duplicateProviderSubagentId}`,
          ),
        ).toBeVisible();
        await capture(page, testInfo, "operations-dark-large-text-compact");
      });

      await test.step("an online directory failure keeps cached host data visible", async () => {
        secondaryFixture.failAgentDirectoryRequests();
        await page.getByTestId("operations-refresh").click();
        await expect(page.getByTestId("operations-refresh-failed")).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByTestId("operations-partial-hosts")).toBeVisible();
        await expect(
          page.getByTestId(`operations-agent-${secondaryDaemon.serverId}-${secondaryAgent.id}`),
        ).toContainText("Last known");

        secondaryFixture.restoreAgentDirectoryRequests();
        await page.getByTestId("operations-refresh").click();
        await expect(page.getByTestId("operations-refresh-failed")).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(page.getByTestId("operations-partial-hosts")).toHaveCount(0);
      });

      await test.step("an offline host keeps cached data and failed refresh visible", async () => {
        await secondaryDaemon.close();
        await expect(page.getByTestId("operations-partial-hosts")).toBeVisible({
          timeout: 30_000,
        });
        await page.getByTestId("operations-refresh").click();
        await expect(page.getByTestId("operations-refresh-failed")).toBeVisible({
          timeout: 30_000,
        });
      });
    } finally {
      await secondary.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
      await primary.cleanup().catch(() => undefined);
    }
  });
});
