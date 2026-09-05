import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectAssignmentsClient } from "../support/helpers/assignments";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

test.use({ e2eGithubWorkFixture: true });

test("older hosts show the update gate without receiving new discovery RPCs", async ({ page }) => {
  // Load the ESM protocol through the same path as the seed client; a static
  // Playwright/CJS import would poison that client's module cache.
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../../../protocol/dist/messages.js"),
  ).href;
  const {
    WSOutboundMessageSchema,
    WSInboundMessageSchema,
    ServerInfoStatusPayloadSchema,
  }: typeof import("@getpaseo/protocol/messages") = await import(moduleUrl);
  let discoveryRequests = 0;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const parsed = WSInboundMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (
        parsed.success &&
        parsed.data.type === "session" &&
        parsed.data.message.type.startsWith("forge.repositories.")
      )
        discoveryRequests += 1;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (
        parsed.success &&
        parsed.data.type === "session" &&
        parsed.data.message.type === "status" &&
        parsed.data.message.payload.status === "server_info"
      ) {
        const envelope = parsed.data;
        const payload = ServerInfoStatusPayloadSchema.parse(parsed.data.message.payload);
        socket.send(
          JSON.stringify({
            ...envelope,
            message: {
              type: "status",
              payload: {
                ...payload,
                features: { ...payload.features, forgeRepositoryDiscovery: undefined },
              },
            },
          }),
        );
      } else server.send(raw);
    });
  });
  await page.goto("/github-work");
  await page.getByTestId("github-work-host-field").getByRole("button").click();
  await page.getByTestId(`github-work-host-${getServerId()}`).click();
  await expect(page.getByTestId("github-work-unavailable")).toHaveText(
    "Update this host to browse GitHub work",
  );
  await expect(page.getByTestId("github-work-site")).toHaveCount(0);
  expect(discoveryRequests).toBe(0);
});

async function selectHost(page: Page): Promise<void> {
  await page.getByTestId("github-work-host-field").getByRole("button").click();
  await page.getByTestId(`github-work-host-${getServerId()}`).click();
  await expect(page.getByTestId("github-work-repository-R_browser")).toBeVisible();
}

test("browse repository work and create an Assignment without a Workspace", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator('[data-testid="sidebar-github-work"]:visible').click();
  await selectHost(page);
  await expect(page.getByTestId("github-work-repository-R_other")).toHaveCount(0);
  await page.getByTestId("github-work-load-more").click();
  await expect(page.getByTestId("github-work-repository-R_other")).toBeVisible();
  await page.getByTestId("github-work-repository-R_browser").click();
  await expect(page.getByTestId("github-work-item-I_browser_1")).toBeVisible();
  await page.getByTestId("github-work-load-more").click();
  await expect(page.getByTestId("github-work-item-I_browser_2")).toBeVisible();
  await page.getByTestId("github-work-pull-requests").click();
  await expect(page.getByTestId("github-work-item-PR_browser_1")).toContainText(
    "Review the browser",
  );
  await expect(page.getByTestId("github-work-item-I_browser_1")).toHaveCount(0);
  await page.getByTestId("github-work-closed").click();
  await expect(page.getByTestId("github-work-item-PR_browser_1")).toContainText("closed");
  await page.getByTestId("github-work-item-PR_browser_1").click();
  const preview = page.getByTestId("github-work-preview");
  await expect(preview).toContainText("feature");
  await expect(preview.getByTestId("github-work-body")).toContainText("BODY_ONLY_SENTINEL");
  await expect(preview).toContainText("Preview truncated");
  await testInfo.attach("github-work-desktop", {
    body: await page.screenshot({ path: testInfo.outputPath("github-work-desktop.png") }),
    contentType: "image/png",
  });
  const popup = page.waitForEvent("popup");
  await page.route("https://github.com/fixture/browser/pull/1", (route) =>
    route.fulfill({ body: "GitHub source" }),
  );
  await page.getByTestId("github-work-open-source").click();
  const source = await popup;
  await expect(source).toHaveURL("https://github.com/fixture/browser/pull/1");
  await source.close();
  await page.getByTestId("github-work-create-assignment").click();
  const form = page.getByTestId("assignment-form-sheet");
  await expect(form.getByTestId("assignment-form-title")).toHaveValue("Review the browser");
  await expect(form.getByTestId("assignment-form-objective")).toHaveValue("");
  await expect(form.getByTestId("assignment-form-save")).toBeDisabled();
  await form
    .getByTestId("assignment-form-objective")
    .fill("Inspect the proposed change before choosing a Workspace");
  await form.getByTestId("assignment-form-save").click();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/\/assignments\/[^/]+\/asgn_/);
  const client = await connectAssignmentsClient();
  try {
    const assignmentId = new URL(page.url()).pathname.split("/").at(-1)!;
    const { assignment } = await client.getAssignment(assignmentId);
    expect(assignment.workItem).toEqual({
      sourceId: "github",
      sourceLabel: "GitHub",
      resourceType: "change_request",
      resourceId: "github.com:R_browser:PR_browser_1",
      identifier: "#1",
      title: "Review the browser",
      url: "https://github.com/fixture/browser/pull/1",
    });
    expect(assignment.objective).toBe("Inspect the proposed change before choosing a Workspace");
    expect(JSON.stringify(assignment)).not.toContain("BODY_ONLY_SENTINEL");
    expect((await e2eWorkerClient.fetchWorkspaces()).entries).toEqual([]);
  } finally {
    await client.close();
  }
});

test("compact browsing exposes authentication and search failures with recovery", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/github-work");
  await selectHost(page);
  await page.getByTestId("github-work-site").fill("unauthenticated.test");
  await page.getByTestId("github-work-repositories-submit").click();
  await expect(page.getByTestId("github-work-error")).toContainText("gh auth login");
  await page.getByTestId("github-work-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("github-work-error")).toContainText("gh auth login");
  await page.getByTestId("github-work-site").fill("github.com");
  await page.getByTestId("github-work-repositories-submit").click();
  await page.getByTestId("github-work-repository-R_browser").click();
  await expect(page.getByTestId("github-work-site")).toHaveCount(0);
  await page.getByTestId("github-work-work-search").fill("rate-limit");
  await page.getByTestId("github-work-work-submit").click();
  await expect(page.getByTestId("github-work-error")).toContainText("rate limit");
  await expect(page.getByText("No matching work", { exact: true })).toHaveCount(0);
  await page.getByTestId("github-work-work-search").fill("no-results");
  await page.getByTestId("github-work-work-submit").click();
  await expect(page.getByText("No matching work", { exact: true })).toBeVisible();
  await page.getByTestId("github-work-work-search").fill("");
  await page.getByTestId("github-work-work-submit").click();
  await page.getByTestId("github-work-item-I_browser_1").click();
  await expect(page.getByTestId("github-work-preview")).toBeVisible();
  await page.getByTestId("github-work-create-assignment").click({ trial: true });
  await testInfo.attach("github-work-compact", {
    body: await page.screenshot({ path: testInfo.outputPath("github-work-compact.png") }),
    contentType: "image/png",
  });
  await page
    .getByTestId("github-work-preview")
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page.getByTestId("github-work-back").click();
  await expect(page.getByTestId("github-work-site")).toHaveValue("github.com");
});
