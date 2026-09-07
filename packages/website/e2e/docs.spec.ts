import { test, expect } from "playwright/test";

test("CC docs preserve identity, source ownership, and metadata through navigation and reload", async ({
  page,
  context,
}, testInfo) => {
  const externalRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === "43131") {
      await route.continue();
    } else {
      externalRequests.push(url.href);
      await route.abort();
    }
  });

  const response = await page.goto("/docs/capabilities");
  expect(response?.status()).toBe(200);
  // A dev optimizer reload can interrupt navigation even after the HTML is ready.
  // Exercise the built site, never Vite's development client.
  await expect(page.locator('script[src*="tanstack-start-dev-client-entry"]')).toHaveCount(0);
  await expect(page).toHaveTitle("Capabilities and evidence - Consolidated Compute Docs");
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
    "content",
    "Consolidated Compute",
  );
  await expect(
    page.locator('meta[property="og:image"], meta[name="twitter:image"], link[rel="canonical"]'),
  ).toHaveCount(0);
  await expect(page.locator('script[src*="plausible.io"]')).toHaveCount(0);
  const source = page.getByRole("link", { name: "View this page on GitHub" });
  await expect(source).toHaveAttribute(
    "href",
    "https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/capabilities.md",
  );
  await expect(
    page.locator(".docs-source-footer").getByRole("link", { name: "Paseo", exact: true }),
  ).toHaveAttribute("href", "https://github.com/getpaseo/paseo");
  await page.screenshot({ path: testInfo.outputPath("cc-docs-desktop.png") });

  await page
    .getByRole("link", { name: "Consolidated Compute", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Documentation", exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/?$/);
  await expect(page).toHaveTitle(
    "Getting started with Consolidated Compute - Consolidated Compute Docs",
  );
  await page
    .getByRole("link", { name: "First Team Run", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/github-work$/);
  await expect(page).toHaveTitle("GitHub Work → your first Team Run - Consolidated Compute Docs");
  await page.reload();
  await expect(source).toHaveAttribute(
    "href",
    "https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/github-work.md",
  );
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
    "content",
    "Consolidated Compute",
  );
  await expect(page.locator('script[src*="plausible.io"]')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("compact docs menu navigates between CC guides and preserves raw Markdown access", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs");
  await expect(
    page.getByRole("link", { name: "Consolidated Compute", exact: true }).filter({ visible: true }),
  ).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page
    .getByRole("link", { name: "Capabilities and evidence", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/capabilities$/);
  await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Capabilities and evidence - Consolidated Compute Docs");
  await page.screenshot({ path: testInfo.outputPath("cc-docs-compact.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const markdown = await request.get("/docs/capabilities.md");
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  expect(await markdown.text()).toContain("# Capabilities and evidence");
});
