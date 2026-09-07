import { test, expect } from "playwright/test";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`CC homepage leads to source setup and evidence at ${viewport.width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const externalRequests: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:43131") {
        await route.continue();
      } else {
        externalRequests.push(url.href);
        await route.abort();
      }
    });

    expect((await page.goto("/"))?.status()).toBe(200);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/A harness for\s*your harness\./);
    await expect(page).toHaveTitle("Consolidated Compute — A harness for your harness");
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      "content",
      "Consolidated Compute",
    );
    await expect(
      page.locator(
        'meta[property="og:image"], meta[name="twitter:image"], link[rel="canonical"], script[src*="plausible.io"], script[src*="tanstack-start-dev-client-entry"]',
      ),
    ).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
      "href",
      "https://github.com/consolidated-compute/consolidated-compute",
    );
    await expect(page.getByRole("link", { name: "Paseo", exact: true })).toHaveAttribute(
      "href",
      "https://github.com/getpaseo/paseo",
    );
    await expect(page.getByRole("link", { name: "Apache-2.0 license" })).toHaveAttribute(
      "href",
      "https://github.com/consolidated-compute/consolidated-compute/blob/main/LICENSE",
    );
    await expect(
      page.locator(
        'a[href*="apps.apple.com"], a[href*="play.google.com"], a[href="/download"], a[href*="getpaseo/paseo/releases"]',
      ),
    ).toHaveCount(0);

    const screenshot = page.getByRole("img", { name: /A Consolidated Compute Team Run/ });
    await expect(screenshot).toHaveAttribute("src", "/cc/team-run-electron.png");
    await screenshot.evaluate((element: HTMLImageElement) => element.decode());
    expect(
      await screenshot.evaluate((element: HTMLImageElement) => [
        element.naturalWidth,
        element.naturalHeight,
      ]),
    ).toEqual([1440, 1000]);
    await page.screenshot({
      path: testInfo.outputPath(`cc-home-${viewport.width}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.getByRole("link", { name: "Start from source", exact: true }).click();
    await expect(page).toHaveTitle(
      "Getting started with Consolidated Compute - Consolidated Compute Docs",
    );
    await page.goBack();
    await expect(heading).toHaveText(/A harness for\s*your harness\./);
    await page.getByRole("link", { name: "Run your first Team", exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/github-work$/);
    await page.goBack();
    await nav.getByRole("link", { name: "Capabilities and evidence", exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/capabilities$/);
    await page.goBack();
    await page.getByRole("link", { name: "Distribution and compatibility", exact: true }).click();
    await expect(page).toHaveURL(/\/docs#distribution-and-compatibility$/);
    await page.goBack();
    await page.reload();
    await expect(page).toHaveTitle("Consolidated Compute — A harness for your harness");
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      "content",
      "Consolidated Compute",
    );
    await expect(page.locator('script[src*="plausible.io"]')).toHaveCount(0);
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
