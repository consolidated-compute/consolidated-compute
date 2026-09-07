import { expect, test } from "../../app/e2e/support/fixtures";
import { buildSeededHost } from "../../app/e2e/support/helpers/daemon-registry";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { prepareGithubWorkRun } from "../../app/e2e/support/helpers/github-work-journey";
import { startGithubWorkProof } from "../../app/e2e/support/helpers/github-work-proof";
import { startRealElectronRenderer, type RealElectronRenderer } from "./support/real-electron";

// Explicit real-host target: host gh and the Spark catalog, but no agent turns.
test("real Electron completes GitHub Work preflight without starting an agent", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(240_000);
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

    const { assignment, workspace, preview } = await prepareGithubWorkRun(page, proof, testInfo, {
      // Real Electron does not use the browser fixture's host reseeding.
      reloadAssignment: async () => {
        await page.reload();
      },
    });
    expect((await proof.client.listTeamRuns()).runs).toEqual([]);
    expect((await proof.client.fetchAgents()).entries).toEqual([]);
    await testInfo.attach("electron-preflight", {
      body: JSON.stringify({ assignment, workspace, preview, agentTurns: 0 }, null, 2),
      contentType: "application/json",
    });
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
});
