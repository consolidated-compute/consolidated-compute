import { test, expect } from "playwright/test";

test("the CC architecture guide is discoverable and readable on desktop and compact web", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/docs");
  await page
    .getByRole("link", { name: "Architecture", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/architecture$/);
  await expect(page).toHaveTitle("Consolidated Compute architecture - Consolidated Compute Docs");
  await expect(page.locator("h2#one-daemon-two-layers")).toBeVisible();
  const diagram = page.locator(".docs-prose pre").first();
  await expect(diagram).toContainText("Daemon from the CC checkout");
  await expect(diagram).toContainText("CC:");
  await expect(diagram).toContainText("Assignments, Teams, Artifacts");
  await expect(diagram).toContainText("Paseo:");
  await expect(diagram).toContainText("Agent Profiles, Workspaces");
  await expect(page.getByRole("link", { name: "View this page on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/architecture.md",
  );
  await page.screenshot({ path: testInfo.outputPath("architecture-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs");
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page
    .getByRole("link", { name: "Architecture", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/architecture$/);
  await page.reload();
  await expect(page).toHaveTitle("Consolidated Compute architecture - Consolidated Compute Docs");
  await expect(page.locator("h2#optional-hub")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator(".docs-prose pre")
      .evaluateAll((elements) =>
        elements.map((element) => element.scrollWidth <= element.clientWidth),
      ),
  ).toEqual([true, true]);
  await page.screenshot({ path: testInfo.outputPath("architecture-compact.png"), fullPage: true });

  const markdown = await request.get("/docs/architecture.md");
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  expect(await markdown.text()).toContain("## Optional Hub");
  expect(errors).toEqual([]);
});
