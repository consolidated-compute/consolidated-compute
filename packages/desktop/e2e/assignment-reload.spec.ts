import { expect, test } from "../../app/e2e/support/fixtures";
import {
  connectAssignmentsClient,
  type AssignmentsDaemonClient,
} from "../../app/e2e/support/helpers/assignments";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../../app/e2e/support/helpers/daemon-websocket-gate";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { startRealElectronRenderer, type RealElectronRenderer } from "./support/real-electron";

test("real Electron retains the exact Assignment through reload and delayed reconnect", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(180_000);
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("Desktop fixture did not configure E2E_PASEO_HOME");
  const metroPort = Number(process.env.E2E_METRO_PORT);
  if (!Number.isInteger(metroPort) || metroPort <= 0) {
    throw new Error("Desktop fixture did not configure E2E_METRO_PORT");
  }
  await expect(fixturePage.locator("body")).toBeAttached();
  let client: AssignmentsDaemonClient | null = null;
  let electron: RealElectronRenderer | null = null;
  let gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>> | null = null;
  try {
    client = await connectAssignmentsClient();
    const { assignment } = await client.createAssignment({
      title: "Keep this Assignment open",
      objective: "Preserve this exact destination across desktop bootstrap.",
      workItem: null,
    });
    await client.createAssignment({
      title: "Another Assignment must not replace the destination",
      objective: "Make automatic list selection distinguishable from route restoration.",
      workItem: null,
    });
    electron = await startRealElectronRenderer({
      daemonPort: getE2EDaemonPort(),
      metroPort,
      paseoHome,
      artifactDir: testInfo.outputPath("real-electron"),
    });
    const page = electron.page;
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-testid="sidebar-assignments"]:visible').click();
    const identity = `${getServerId()}-${assignment.id}`;
    await page.getByTestId(`assignment-row-${identity}`).click();
    const detail = page.getByTestId(`assignment-detail-${identity}`);
    await expect(detail).toContainText(assignment.objective);
    const assignmentUrl = page.url();

    await page.reload();
    await expect(detail).toContainText(assignment.objective, { timeout: 30_000 });
    await expect(page).toHaveURL(assignmentUrl);
    await page.screenshot({ path: testInfo.outputPath("assignment-reloaded.png") });

    gate = await installDaemonWebSocketGate(page);
    await gate.drop();
    await page.reload();
    await gate.waitForBlockedConnection();
    await expect(page.getByTestId("assignments-new")).toBeDisabled({ timeout: 30_000 });
    await expect(page).toHaveURL(assignmentUrl);
    await page.screenshot({ path: testInfo.outputPath("assignment-offline.png") });
    gate.restore();
    await expect(detail).toContainText(assignment.objective, { timeout: 30_000 });
    await expect(page).toHaveURL(assignmentUrl);
    await expect(page.getByTestId(`assignment-edit-${identity}`)).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("assignment-reconnected.png") });
  } catch (error) {
    if (electron) {
      await electron.page.screenshot({ path: testInfo.outputPath("electron-failure.png") });
      await testInfo.attach("electron-failure-page", {
        body: `${electron.page.url()}\n${await electron.page.locator("body").innerText()}`,
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    gate?.restore();
    try {
      await electron?.stop();
    } finally {
      await client?.close();
    }
  }
});
