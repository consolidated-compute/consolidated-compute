import { expect, test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts, openSettingsHostSection } from "../support/helpers/settings";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { execFileSync } from "node:child_process";
import path from "node:path";

test("sets up browser host security and reconnects only after confirmed restart", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const daemon = await startIsolatedHostDaemon("security-setup-browser", {
    environment: { NODE_ENV: "development", PASEO_PASSWORD: undefined },
  });
  try {
    await seedSavedSettingsHosts(page, [
      {
        serverId: daemon.serverId,
        label: "Security setup host",
        endpoint: `127.0.0.1:${daemon.port}`,
      },
    ]);
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, daemon.serverId, "host");
    await page.getByTestId("host-security-open").click();
    await page.getByTestId("host-security-password").fill("isolated-browser-password");
    await page.getByTestId("host-security-confirm").fill("isolated-browser-password");
    await expect(page.getByTestId("host-security-save")).toBeDisabled();
    await page.getByTestId("host-security-code").fill("invalid-code");
    await page.getByTestId("host-security-save").click();
    await expect(page.getByTestId("host-security-error")).toBeVisible();
    const output = execFileSync(
      process.execPath,
      [
        path.resolve(__dirname, "../../../cli/dist/index.js"),
        "daemon",
        "setup-code",
        "--home",
        daemon.paseoHome,
      ],
      { encoding: "utf8" },
    );
    const code = output.match(/^[a-f0-9]{48}$/m)?.[0];
    if (!code) throw new Error("CLI did not return a setup code");
    await page.getByTestId("host-security-code").fill(code);
    await page.getByTestId("host-security-save").click();
    await expect(page.getByTestId("host-security-restart")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("host-security-saved.png") });
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(200);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("host-security-restart").click();
    await expect(
      page.getByText("Host reconnected with security enabled.", { exact: true }),
    ).toBeVisible({ timeout: 40_000 });
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(401);
  } finally {
    await daemon.close();
  }
});

test("explains the environment-password override without offering ineffective setup", async ({
  page,
}) => {
  const password = "isolated-environment-password";
  const daemon = await startIsolatedHostDaemon("security-override-browser", {
    environment: { NODE_ENV: "development", PASEO_PASSWORD: password },
  });
  try {
    await seedSavedSettingsHosts(page, [
      {
        serverId: daemon.serverId,
        label: "Override host",
        endpoint: `127.0.0.1:${daemon.port}`,
        password,
      },
    ]);
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, daemon.serverId, "host");
    await expect(
      page.getByText(
        "Remove PASEO_PASSWORD from the host launcher and restart safely before setup.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByTestId("host-security-open")).toHaveCount(0);
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(401);
  } finally {
    await daemon.close();
  }
});
