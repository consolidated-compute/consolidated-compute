import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { expect, test } from "../../app/e2e/support/fixtures";
import {
  openChangesTreePanel,
  openPullRequestPanel,
} from "../../app/e2e/support/helpers/workspace-tabs";
import { withGithubWorkElectron } from "./support/github-work-electron";

const REPOSITORY = "consolidated-compute/consolidated-compute";
const source = path.resolve(__dirname, "../../..");
const PublishedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string().min(1),
  headRefName: z.string().min(1),
  headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
  baseRefName: z.string().min(1),
  state: z.literal("OPEN"),
  isDraft: z.boolean(),
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
}

// Run on a published CC feature branch. This target only reads GitHub and
// creates disposable local state; publication and merge stay operator actions.
test.describe.configure({ retries: 0 });
test.use({ trace: "on" });

test("real Electron reads back the operator-published PR and its exact checkout", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(180_000);
  const branch = git(source, ["branch", "--show-current"]);
  expect(branch).toMatch(/^codex\//);
  const head = git(source, ["rev-parse", "HEAD"]);
  const published = PublishedPullRequestSchema.parse(
    JSON.parse(
      execFileSync(
        "gh",
        [
          "pr",
          "view",
          branch,
          "--repo",
          REPOSITORY,
          "--json",
          "number,url,title,headRefName,headRefOid,baseRefName,state,isDraft",
        ],
        { cwd: source, encoding: "utf8", timeout: 30_000 },
      ),
    ),
  );
  expect(published).toMatchObject({
    headRefName: branch,
    headRefOid: head,
    baseRefName: "main",
    url: `https://github.com/${REPOSITORY}/pull/${published.number}`,
  });

  await withGithubWorkElectron(fixturePage, testInfo, async (page, proof) => {
    git(source, ["clone", "--shared", "--no-checkout", source, proof.checkout]);
    git(proof.checkout, ["checkout", "-B", branch, head]);
    git(proof.checkout, ["remote", "set-url", "origin", `https://github.com/${REPOSITORY}.git`]);
    // A local clone inherits the source checkout's current branch as origin/HEAD.
    // Use GitHub's real base so Commits compares the published feature against main.
    git(proof.checkout, [
      "fetch",
      "--no-tags",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
    ]);
    git(proof.checkout, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const { workspace, error } = await proof.client.createWorkspace({
      source: { kind: "directory", path: proof.checkout },
      title: "Operator publication proof",
    });
    expect(error).toBeNull();
    if (!workspace) throw new Error("Publication proof Workspace was not created");
    const status = await proof.client.checkoutPrStatus(proof.checkout);
    expect(status.error).toBeNull();
    expect(status.status).toMatchObject({
      number: published.number,
      url: published.url,
      title: published.title,
      isMerged: false,
    });

    await page.goto(new URL(`/h/${proof.serverId}/workspace/${workspace.id}`, page.url()).href);
    await openPullRequestPanel(page);
    await expect(
      page.getByTestId("workspace-tab-pull_request").filter({ visible: true }).first(),
    ).toHaveAttribute("aria-selected", "true");
    const pane = page.getByTestId("pr-pane").filter({ visible: true });
    await expect(pane.getByTestId("pr-pane-title")).toHaveText(
      `${published.title} #${published.number}`,
    );
    await expect(pane.getByTestId("pr-pane-state")).toHaveText(
      published.isDraft ? "Draft" : "Open",
    );
    await expect(pane).toContainText(REPOSITORY);
    await expect(pane.getByTestId("pr-pane-view-pr")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("published-pull-request.png") });

    await openChangesTreePanel(page);
    await page.getByRole("button", { name: /Commits/i }).click();
    const shortHead = git(proof.checkout, ["log", "-1", "--format=%h"]);
    const commit = page.getByTestId(`commit-row-${shortHead}`).filter({ visible: true });
    await expect(commit).toContainText(git(proof.checkout, ["log", "-1", "--format=%s"]));
    await commit.click();
    await expect(
      page.getByTestId(`workspace-tab-commit_diff_${head}`).filter({ visible: true }).first(),
    ).toHaveAttribute("aria-selected", "true");
    const diff = page.getByTestId("commit-diff-panel").filter({ visible: true });
    await expect(diff.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(diff.getByTestId("diff-file-0")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("published-commit-diff.png") });

    await openPullRequestPanel(page);
    await page.reload();
    await expect(pane.getByTestId("pr-pane-title")).toHaveText(
      `${published.title} #${published.number}`,
      { timeout: 30_000 },
    );
    expect(git(proof.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(proof.checkout, ["status", "--porcelain"])).toBe("");
    expect((await proof.client.fetchAgents()).entries).toEqual([]);
    expect((await proof.client.listTeamRuns()).runs).toEqual([]);
    await testInfo.attach("operator-publication", {
      body: JSON.stringify({ published, workspace, status, agentTurns: 0 }, null, 2),
      contentType: "application/json",
    });
  });
});
