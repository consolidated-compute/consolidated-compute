import { expect, test, type Page, type TestInfo } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { openCommandCenter } from "../../app/e2e/support/helpers/command-center";
import { buildSeededHost } from "../../app/e2e/support/helpers/daemon-registry";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { addConnectedHostAndReload } from "../../app/e2e/support/helpers/hosts";
import {
  OPERATIONS_RUNTIME_NODE_COUNT,
  seedOperationsRuntimeScenario,
} from "../../app/e2e/support/helpers/operations-runtime-scenario";
import { openSettingsSection } from "../../app/e2e/support/helpers/settings";
import { startRealElectronRenderer } from "./support/real-electron";
import { installDesktopRuntime } from "./support/runtime";

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

async function expectVisualNodeCount(page: Page, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const managed = await page.locator('[data-testid^="visual-agent-"]').count();
      const provider = await page.locator('[data-testid^="visual-provider-subagent-"]').count();
      return managed + provider;
    })
    .toBe(expected);
}

async function closeCompactSidebar(page: Page): Promise<void> {
  const close = page.getByTestId("sidebar-close");
  await expect(close).not.toBeVisible({ timeout: 10_000 });
}

async function useDarkLargeInterfaceText(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.locator('[data-testid="sidebar-settings"]:visible').click();
  await expect(page).toHaveURL(/\/settings$/);
  await openSettingsSection(page, "appearance");
  await page.getByLabel(/^Theme:/).click();
  await page.getByText("Dark", { exact: true }).click();
  const interfaceSize = page.getByLabel("Interface font size");
  await interfaceSize.fill("21");
  await interfaceSize.press("Tab");
  await expect(interfaceSize).toHaveValue("21");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.locator('[data-testid="sidebar-operations"]:visible').click();
  await expect(page).toHaveURL(/\/operations$/, { timeout: 10_000 });
  await closeCompactSidebar(page);
}

test("desktop runtime proves the 15-node Operations and Visual contract", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const scenario = await seedOperationsRuntimeScenario(page, {
    prefix: "desktop-operations",
    primaryWorkspaceTitle: "Desktop primary workspace",
    secondaryWorkspaceTitle: "Desktop secondary workspace",
    primaryHostLabel: "Desktop primary host",
    secondaryHostLabel: "Desktop secondary host",
  });

  try {
    await installDesktopRuntime(page, {
      serverId: scenario.primaryServerId,
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await page.setViewportSize(WIDE_VIEWPORT);
    await gotoAppShell(page);
    expect(scenario.primaryFixture.providerSnapshotRequestCount()).toBe(0);
    await addConnectedHostAndReload(page, {
      serverId: scenario.secondaryDaemon.serverId,
      label: scenario.secondaryHostLabel,
      port: scenario.secondaryDaemon.port,
      primaryLabel: scenario.primaryHostLabel,
    });

    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("Operations");
    await panel.getByRole("button", { name: "Operations", exact: true }).click();
    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
    await expectSummaryTotal(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await expect
      .poll(() => scenario.primaryFixture.providerSnapshotRequestCount(), { timeout: 30_000 })
      .toBe(1);
    await expect
      .poll(() => scenario.secondaryFixture.providerSnapshotRequestCount(), { timeout: 30_000 })
      .toBe(1);
    await expect(page.getByText("Nested helper", { exact: true })).toBeVisible();
    await expect(page.getByText("Review the primary host changes", { exact: true })).toBeVisible();
    await capture(page, testInfo, "operations-desktop-wide");

    await page.locator('[data-testid="sidebar-visual"]:visible').click();
    await expect(page).toHaveURL(/\/visual$/);
    await expect(page.getByTestId("visual-layout-wide")).toBeVisible({ timeout: 30_000 });
    await expectVisualNodeCount(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await expect(
      page.getByTestId(
        `visual-agent-${scenario.secondaryDaemon.serverId}-${scenario.secondaryAgent.id}`,
      ),
    ).toHaveAccessibleName(
      "Open Secondary host worker. mock. Working. Desktop secondary workspace. Desktop secondary host",
    );
    await capture(page, testInfo, "visual-desktop-wide");

    await page.setViewportSize(COMPACT_VIEWPORT);
    await expect(page.getByTestId("visual-layout-compact")).toBeVisible({ timeout: 30_000 });
    const compactOverflow = await page.getByTestId("visual-scroll").evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    }));
    expect(compactOverflow.scrollHeight).toBeGreaterThan(compactOverflow.clientHeight);
    expect(compactOverflow.scrollWidth).toBeLessThanOrEqual(compactOverflow.clientWidth + 1);
    await capture(page, testInfo, "visual-desktop-compact");

    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.locator('[data-testid="sidebar-operations"]:visible').click();
    await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
    await closeCompactSidebar(page);
    await expectSummaryTotal(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await capture(page, testInfo, "operations-desktop-compact");

    await useDarkLargeInterfaceText(page);
    await expect(page.getByTestId("operations-screen")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.locator('[data-testid="sidebar-visual"]:visible').click();
    await expect(page.getByTestId("visual-layout-compact")).toBeVisible({ timeout: 30_000 });
    await closeCompactSidebar(page);
    await expectVisualNodeCount(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await capture(page, testInfo, "visual-desktop-dark-large-text-compact");
  } finally {
    await scenario.cleanup();
  }
});

test("real Electron retains the 15-node Visual contract", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(300_000);
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME was not configured by the desktop fixture");
  const metroPort = Number(process.env.E2E_METRO_PORT);
  if (!Number.isInteger(metroPort) || metroPort <= 0) {
    throw new Error("E2E_METRO_PORT was not configured by Playwright global setup");
  }
  await expect(fixturePage.locator("body")).toBeAttached();

  const electron = await startRealElectronRenderer({
    daemonPort: getE2EDaemonPort(),
    metroPort,
    paseoHome,
    artifactDir: testInfo.outputPath("real-electron"),
  });
  let scenario: Awaited<ReturnType<typeof seedOperationsRuntimeScenario>> | null = null;

  try {
    const page = electron.page;
    scenario = await seedOperationsRuntimeScenario(page, {
      prefix: "real-electron-operations",
      primaryWorkspaceTitle: "Electron primary workspace",
      secondaryWorkspaceTitle: "Electron secondary workspace",
      primaryHostLabel: "Electron primary host",
      secondaryHostLabel: "Electron secondary host",
    });
    const nowIso = new Date().toISOString();
    const hosts = [
      buildSeededHost({
        serverId: scenario.primaryServerId,
        label: scenario.primaryHostLabel,
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        nowIso,
      }),
      buildSeededHost({
        serverId: scenario.secondaryDaemon.serverId,
        label: scenario.secondaryHostLabel,
        endpoint: `127.0.0.1:${scenario.secondaryDaemon.port}`,
        nowIso,
      }),
    ];
    await page.addInitScript((seededHosts) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify(seededHosts));
    }, hosts);

    const desktopStatus = await page.evaluate(() =>
      window.paseoDesktop?.invoke("desktop_daemon_status"),
    );
    expect(desktopStatus).toMatchObject({ serverId: scenario.primaryServerId, status: "running" });

    await page.setViewportSize(WIDE_VIEWPORT);
    await page.reload();
    const visualLink = page.locator('[data-testid="sidebar-visual"]:visible');
    await expect(visualLink).toBeVisible({ timeout: 30_000 });
    await visualLink.click();
    await expect(page).toHaveURL(/\/visual$/);
    await expect(page.getByTestId("visual-layout-wide")).toBeVisible({ timeout: 30_000 });
    await expectVisualNodeCount(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await expect(
      page.getByTestId(
        `visual-agent-${scenario.secondaryDaemon.serverId}-${scenario.secondaryAgent.id}`,
      ),
    ).toHaveAccessibleName(
      "Open Secondary host worker. mock. Working. Electron secondary workspace. Electron secondary host",
    );
    await capture(page, testInfo, "visual-electron-wide");

    await page.setViewportSize(COMPACT_VIEWPORT);
    await expect(page.getByTestId("visual-layout-compact")).toBeVisible({ timeout: 30_000 });
    const compactOverflow = await page.getByTestId("visual-scroll").evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    }));
    expect(compactOverflow.scrollHeight).toBeGreaterThan(compactOverflow.clientHeight);
    expect(compactOverflow.scrollWidth).toBeLessThanOrEqual(compactOverflow.clientWidth + 1);
    await capture(page, testInfo, "visual-electron-compact");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const key = "@paseo:app-settings";
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...stored, theme: "dark", uiBaseFontSize: 21 }));
    });
    await page.reload();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect(visualLink).toBeVisible({ timeout: 30_000 });
    await visualLink.click();
    await expect(page).toHaveURL(/\/visual$/);
    await closeCompactSidebar(page);
    await expect(page.getByTestId("visual-layout-compact")).toBeVisible({ timeout: 30_000 });
    await expectVisualNodeCount(page, OPERATIONS_RUNTIME_NODE_COUNT);
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
      .toBe(true);
    await capture(page, testInfo, "visual-electron-dark-large-text-compact");
  } finally {
    await scenario?.cleanup();
    await electron.stop();
  }
});
