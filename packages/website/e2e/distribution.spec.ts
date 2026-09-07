import { test, expect } from "playwright/test";

for (const path of [
  "/download",
  "/download/",
  "/download?channel=beta",
  "/download/?channel=beta",
]) {
  test(`inherited ${path} stays on the CC host and leads to source setup`, async ({
    page,
    request,
    context,
  }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe("/docs#distribution-and-compatibility");
    expect(response.headers()["cache-control"]).toBe("no-store");

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
    await page.goto(path);
    await expect(page).toHaveURL("/docs#distribution-and-compatibility");
    await expect(page).toHaveTitle(
      "Getting started with Consolidated Compute - Consolidated Compute Docs",
    );
    await expect(page.locator("h2#distribution-and-compatibility")).toBeInViewport();
    await expect(
      page.getByRole("link", { name: "Consolidated Compute repository", exact: true }),
    ).toHaveAttribute("href", "https://github.com/consolidated-compute/consolidated-compute");
    await expect(
      page.locator(
        'script[src*="plausible.io"], a[href*="getpaseo/paseo/releases"], a[href*="apps.apple.com"], a[href*="play.google.com"]',
      ),
    ).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL("/docs#distribution-and-compatibility");
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
}

for (const guide of [
  { slug: "docker", title: "Upstream Paseo Docker", nav: "Upstream Docker" },
  { slug: "updates", title: "Upstream Paseo updates", nav: "Upstream updates" },
]) {
  test(`${guide.slug} labels the upstream instructions and links to CC policy`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/docs/${guide.slug}`);
    await expect(page).toHaveTitle(`${guide.title} - Consolidated Compute Docs`);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: `Link to this section ${guide.title}`,
        exact: true,
      }),
    ).toBeVisible();
    const notice = page.locator(".docs-prose > p").first();
    await expect(notice).toHaveText(
      "This guide describes upstream Paseo. For Consolidated Compute, follow the distribution and compatibility guide.",
    );
    await expect(
      notice.getByRole("link", { name: "distribution and compatibility guide" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/consolidated-compute/consolidated-compute/blob/main/public-docs/index.md#distribution-and-compatibility",
    );
    await page.screenshot({ path: testInfo.outputPath(`${guide.slug}-scope.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect(
      page.getByRole("link", { name: guide.nav, exact: true }).filter({ visible: true }),
    ).toBeVisible();
    const markdown = await request.get(`/docs/${guide.slug}.md`);
    expect(markdown.status()).toBe(200);
    expect(await markdown.text()).toContain("This guide describes **upstream Paseo**.");
  });
}
