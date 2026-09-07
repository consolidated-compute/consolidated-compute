import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertGithubWorkChecklist,
  buildGithubWorkChecklistReviewScript,
} from "./github-work-checklist";

const JOURNEY =
  "Open GitHub Work, create an Assignment and worktree, inspect the security preview, go through Artifacts, and leave merge to a human.";

async function runReviewer(checklist: string) {
  const root = await mkdtemp(path.join(tmpdir(), "github-work-checklist-"));
  try {
    const file = path.join(root, "checklist.md");
    await writeFile(file, checklist);
    return spawnSync(process.execPath, ["-e", buildGithubWorkChecklistReviewScript(file)], {
      encoding: "utf8",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each([
  ["incidental gh and Hub substrings", JOURNEY],
  ["missing host authentication", `${JOURNEY} Hub is optional.`],
  ["missing Hub optionality", `${JOURNEY} Host gh authentication is required.`],
  ["bare gh and Hub mentions", `${JOURNEY} Use gh and Hub.`],
  ["required Hub", `${JOURNEY} Host gh authentication is required. Hub is required.`],
  ["GitHub instead of Hub", `${JOURNEY} Host gh authentication is required. GitHub is optional.`],
  ["optional authentication", `${JOURNEY} Host gh authentication is optional. Hub is optional.`],
])("rejects %s in both proof checks", async (_name, checklist) => {
  expect(() => assertGithubWorkChecklist(checklist)).toThrow();
  const result = await runReviewer(checklist);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("AssertionError");
  expect(result.stdout).not.toContain("CHECKLIST_TEST_PASS");
});

it.each([
  `${JOURNEY} Host gh authentication is required. Hub is optional.`,
  `${JOURNEY} Host \`gh\` authentication is required. \`Hub\` is optional.`,
  `${JOURNEY} HOST GH AUTHENTICATION\nIS REQUIRED. HUB IS OPTIONAL.`,
])(
  "accepts explicit instructions and prints success only after checking: %s",
  async (checklist) => {
    expect(() => assertGithubWorkChecklist(checklist)).not.toThrow();
    const result = await runReviewer(checklist);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("CHECKLIST_TEST_PASS\n");
  },
);
