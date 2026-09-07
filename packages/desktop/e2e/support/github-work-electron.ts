import { expect, type Page, type TestInfo } from "@playwright/test";
import { buildSeededHost } from "../../../app/e2e/support/helpers/daemon-registry";
import { getE2EDaemonPort } from "../../../app/e2e/support/helpers/daemon-port";
import { startGithubWorkProof } from "../../../app/e2e/support/helpers/github-work-proof";
import { startRealElectronRenderer, type RealElectronRenderer } from "./real-electron";

export async function withGithubWorkElectron(
  fixturePage: Page,
  testInfo: TestInfo,
  exercise: (page: Page, proof: Awaited<ReturnType<typeof startGithubWorkProof>>) => Promise<void>,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("Desktop fixture did not configure E2E_PASEO_HOME");
  const metroPort = Number(process.env.E2E_METRO_PORT);
  if (!Number.isInteger(metroPort) || metroPort <= 0) {
    throw new Error("Desktop fixture did not configure E2E_METRO_PORT");
  }
  await expect(fixturePage.locator("body")).toBeAttached();
  let proof: Awaited<ReturnType<typeof startGithubWorkProof>> | null = null;
  let electron: RealElectronRenderer | null = null;
  try {
    proof = await startGithubWorkProof();
    electron = await startRealElectronRenderer({
      daemonPort: getE2EDaemonPort(),
      metroPort,
      paseoHome,
      artifactDir: testInfo.outputPath("real-electron"),
    });
    const page = electron.page;
    page.setDefaultTimeout(30_000);
    await expect(page.getByTestId("menu-button")).toBeVisible();
    const host = buildSeededHost({
      serverId: proof.serverId,
      label: "GitHub proof host",
      endpoint: `127.0.0.1:${proof.port}`,
      password: proof.password,
      nowIso: new Date().toISOString(),
    });
    await page.evaluate((seededHost) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    }, host);
    await page.reload();
    await page.locator('[data-testid="sidebar-github-work"]:visible').click();

    await exercise(page, proof);
  } catch (error) {
    if (electron) {
      await testInfo.attach("electron-failure", {
        body: await electron.page.screenshot(),
        contentType: "image/png",
      });
      await testInfo.attach("electron-failure-page", {
        body: `${electron.page.url()}\n${await electron.page.locator("body").innerText()}`,
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    try {
      await electron?.stop();
    } finally {
      await proof?.cleanup();
    }
  }
}
