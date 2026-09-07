import { test } from "../support/fixtures";
import { addConnectedHostAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { prepareGithubWorkRun } from "../support/helpers/github-work-journey";
import { executeGithubWorkRun } from "../support/helpers/github-work-execution";
import { startGithubWorkProof } from "../support/helpers/github-work-proof";

// Explicit real-provider target. Never retry this paid proof or substitute a model.
test.describe.configure({ retries: 0 });

test("executes real GitHub Work through supervised Artifacts and a reviewable diff", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const proof = await startGithubWorkProof();
  try {
    await page.goto("/github-work");
    await addConnectedHostAndReload(page, { ...proof, label: "GitHub proof host" });
    const prepared = await prepareGithubWorkRun(page, proof, testInfo);
    await executeGithubWorkRun(page, proof, testInfo, prepared, () =>
      reloadPreservingHostRegistry(page),
    );
  } finally {
    await proof.cleanup();
  }
});
