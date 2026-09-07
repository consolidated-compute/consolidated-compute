import { expect, test } from "../../app/e2e/support/fixtures";
import { prepareGithubWorkRun } from "../../app/e2e/support/helpers/github-work-journey";
import { withGithubWorkElectron } from "./support/github-work-electron";

// Explicit real-host target: host gh and the Spark catalog, but no agent turns.
test("real Electron completes GitHub Work preflight without starting an agent", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(240_000);
  await withGithubWorkElectron(fixturePage, testInfo, async (page, proof) => {
    const { assignment, workspace, preview } = await prepareGithubWorkRun(page, proof, testInfo, {
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
  });
});
