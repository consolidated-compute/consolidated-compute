import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
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

test.describe("Operations", () => {
  test.describe.configure({ timeout: 300_000 });

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

      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
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

        await reloadWithoutResettingHosts(page);
        await expect(page).toHaveURL(/\/operations$/);
        await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
      });

      await test.step("wide view groups projects, workspaces, agents, and subagents", async () => {
        await expectSummaryTotal(page, 5);
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

        await page
          .getByTestId(`operations-agent-${secondaryDaemon.serverId}-${secondaryAgent.id}`)
          .click();
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
        await expectSummaryTotal(page, 5);
        await expect(page.getByTestId("operations-refresh")).toBeVisible();
        await capture(page, testInfo, "operations-compact");
      });

      await test.step("failed manual refresh remains visible", async () => {
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
