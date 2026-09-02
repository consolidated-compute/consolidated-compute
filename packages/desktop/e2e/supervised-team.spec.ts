import { expect, test, type TestInfo } from "../../app/e2e/support/fixtures";
import { buildSeededHost } from "../../app/e2e/support/helpers/daemon-registry";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import {
  startSupervisedTeamSurfaceScenario,
  type SupervisedTeamSurfaceScenario,
} from "../../app/e2e/support/helpers/supervised-team-scenario";
import { exerciseSupervisedTeamSurface } from "../../app/e2e/support/helpers/supervised-team-ui";
import { startRealElectronRenderer, type RealElectronRenderer } from "./support/real-electron";

test("real Electron resolves provider permission and a durable supervised checkpoint", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(180_000);
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME was not configured by the desktop fixture");
  const metroPort = Number(process.env.E2E_METRO_PORT);
  if (!Number.isInteger(metroPort) || metroPort <= 0) {
    throw new Error("E2E_METRO_PORT was not configured by Playwright global setup");
  }
  await expect(fixturePage.locator("body")).toBeAttached();

  let scenario: SupervisedTeamSurfaceScenario | null = null;
  let electron: RealElectronRenderer | null = null;
  try {
    scenario = await startSupervisedTeamSurfaceScenario({
      serverId: "srv_supervised_electron_surface",
    });
    electron = await startRealElectronRenderer({
      daemonPort: getE2EDaemonPort(),
      metroPort,
      paseoHome,
      artifactDir: testInfo.outputPath("real-electron"),
    });
    const page = electron.page;
    await expect(page.getByTestId("menu-button")).toBeVisible({ timeout: 30_000 });
    const host = buildSeededHost({
      serverId: scenario.serverId,
      label: "Supervised Electron host",
      endpoint: `127.0.0.1:${scenario.port}`,
      nowIso: new Date().toISOString(),
      password: scenario.password,
    });
    await page.addInitScript((seededHost) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    }, host);
    await page.reload();

    await exerciseSupervisedTeamSurface(page, scenario, (name) => capture(page, testInfo, name));
  } finally {
    await electron?.stop();
    await scenario?.cleanup();
  }
});

async function capture(
  page: RealElectronRenderer["page"],
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}
