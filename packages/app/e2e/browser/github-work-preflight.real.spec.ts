import { test } from "../support/fixtures";
import { startGithubWorkProof } from "../support/helpers/github-work-proof";
import { prepareGithubWorkRun } from "../support/helpers/github-work-journey";

// Opt-in real-host preflight for #135. Stop before Start: no agent turns or GitHub writes.
test("completes real GitHub Work preflight without starting an agent", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const proof = await startGithubWorkProof();
  try {
    await prepareGithubWorkRun(page, proof, testInfo);
  } finally {
    await proof.cleanup();
  }
});
