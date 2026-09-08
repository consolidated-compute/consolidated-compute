import { expect, test } from "../../app/e2e/support/fixtures";
import { startIsolatedHostDaemon } from "../../app/e2e/support/helpers/isolated-host-daemon";
import { openSettingsHostSection } from "../../app/e2e/support/helpers/settings";
import { openSettings } from "../../app/e2e/support/helpers/app";
import { buildSeededHost } from "../../app/e2e/support/helpers/daemon-registry";
import { startRealElectronRenderer, type RealElectronRenderer } from "./support/real-electron";

test("configures the managed Electron host without a CLI setup code", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(150_000);
  const metroPort = Number(new URL(fixturePage.url()).port || process.env.E2E_METRO_PORT);
  const daemon = await startIsolatedHostDaemon("security-setup-electron", {
    environment: { NODE_ENV: "development", PASEO_PASSWORD: undefined, PASEO_DESKTOP_MANAGED: "1" },
  });
  let electron: RealElectronRenderer | null = null;
  try {
    electron = await startRealElectronRenderer({
      daemonPort: daemon.port,
      metroPort,
      paseoHome: daemon.paseoHome,
      artifactDir: testInfo.outputPath("electron"),
    });
    const page = electron.page;
    page.setDefaultTimeout(30_000);
    await expect(page.getByTestId("menu-button")).toBeVisible({ timeout: 30_000 });
    const host = buildSeededHost({
      serverId: daemon.serverId,
      label: "Managed security host",
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    await page.evaluate((value) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([value]));
    }, host);
    await page.reload();
    await openSettings(page);
    await openSettingsHostSection(page, daemon.serverId, "host");
    await page.getByTestId("host-security-open").click();
    await expect(page.getByTestId("host-security-code")).toHaveCount(0);
    await page.getByTestId("host-security-password").fill("isolated-electron-password");
    await page.getByTestId("host-security-confirm").fill("isolated-electron-password");
    await page.getByTestId("host-security-save").click();
    await expect(page.getByTestId("host-security-restart")).toBeVisible();
    await testInfo.attach("electron-security-saved", {
      body: await page.screenshot({ path: testInfo.outputPath("host-security-saved.png") }),
      contentType: "image/png",
    });
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(200);
    // The shared browser proof exercises restart confirmation. Here restart
    // the isolated process, then prove the real renderer retained credentials.
    await daemon.restart();
    await page.reload();
    await openSettingsHostSection(page, daemon.serverId, "host");
    await expect(page.getByTestId("host-security-open")).toHaveCount(0);
    await expect(page.getByTestId("host-security-form")).toHaveCount(0);
    await expect(
      page.getByTestId("host-page-identity").getByText("Online", { exact: true }),
    ).toBeVisible({
      timeout: 40_000,
    });
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(401);
  } catch (error) {
    if (electron) {
      await testInfo.attach("electron-page", {
        body: await electron.page.locator("body").innerText(),
        contentType: "text/plain",
      });
      await testInfo.attach("electron-screenshot", {
        body: await electron.page.screenshot(),
        contentType: "image/png",
      });
    }
    throw error;
  } finally {
    try {
      await electron?.stop();
    } finally {
      await daemon.close();
    }
  }
});
