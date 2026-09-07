import { test } from "../../app/e2e/support/fixtures";
import { prepareGithubWorkRun } from "../../app/e2e/support/helpers/github-work-journey";
import { executeGithubWorkRun } from "../../app/e2e/support/helpers/github-work-execution";
import { withGithubWorkElectron } from "./support/github-work-electron";

// Opt-in real-provider target. One Spark/low run; no retries or model fallback.
test.describe.configure({ retries: 0 });
test.use({ trace: "on" });

test("real Electron executes GitHub Work through supervised Artifacts and Workspace review", async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(600_000);
  await withGithubWorkElectron(fixturePage, testInfo, async (page, proof) => {
    const prepared = await prepareGithubWorkRun(page, proof, testInfo, {
      reloadAssignment: async () => {
        await page.reload();
      },
    });
    await executeGithubWorkRun(page, proof, testInfo, prepared, () => page.reload());
  });
});
