import { expect, test, type Page, type TestInfo } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { openCommandCenter } from "../../app/e2e/support/helpers/command-center";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { installOperationsHostFixture } from "../../app/e2e/support/helpers/operations-host-fixture";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { seedParentWithSubagent } from "../../app/e2e/support/helpers/subagents";
import { installDesktopRuntime } from "./support/runtime";

const WIDE_VIEWPORT = { width: 1280, height: 900 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test("desktop runtime keeps Operations comprehensible at wide and compact sizes", async ({
  page,
}, testInfo) => {
  const serverId = getServerId();
  const workspace = await seedWorkspace({
    repoPrefix: "desktop-operations-",
    title: "Desktop operations workspace",
  });

  try {
    const related = await seedParentWithSubagent(workspace, {
      parentTitle: "Desktop parent",
      childTitle: "Desktop nested helper",
    });
    const fixture = await installOperationsHostFixture(page, {
      port: getE2EDaemonPort(),
      providerSubagents: [
        {
          id: "desktop-provider-child",
          parentAgentId: related.parent.id,
          provider: "codex",
          title: "Desktop native reviewer",
          description: "Review the desktop work",
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          toolCallId: "desktop-provider-call",
          subtitle: "Provider-native child",
        },
      ],
    });
    await installDesktopRuntime(page, {
      serverId,
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });

    await page.setViewportSize(WIDE_VIEWPORT);
    await gotoAppShell(page);
    expect(fixture.providerSnapshotRequestCount()).toBe(0);
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("Operations");
    await panel.getByRole("button", { name: "Operations", exact: true }).click();

    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => fixture.providerSnapshotRequestCount(), { timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Desktop nested helper", { exact: true })).toBeVisible();
    await expect(page.getByText("Review the desktop work", { exact: true })).toBeVisible();
    await capture(page, testInfo, "operations-desktop-wide");

    await page.setViewportSize(COMPACT_VIEWPORT);
    await expect(page.getByTestId("operations-screen")).toBeVisible();
    await expect(page.getByTestId("operations-refresh")).toBeVisible();
    await expect(page.getByText("Desktop nested helper", { exact: true })).toBeVisible();
    await capture(page, testInfo, "operations-desktop-compact");
  } finally {
    await workspace.cleanup();
  }
});
