import assert from "node:assert/strict";

export const GITHUB_WORK_CHECKLIST_TERMS = [
  "GitHub Work",
  "Assignment",
  "worktree",
  "security preview",
  "Artifacts",
  "Host gh authentication is required",
  "Hub is optional",
  "human",
];

// Both the local assertion and the provider-run script use the same requirements.
// These fixed phrases contain only words and spaces; word boundaries reject
// incidental substrings such as Hub in GitHub and gh in through.
const REQUIREMENTS = GITHUB_WORK_CHECKLIST_TERMS.map(
  (term) => new RegExp(`\\b${term.replaceAll(" ", "\\s+")}\\b`, "i"),
);

export function assertGithubWorkChecklist(checklist: string) {
  const normalized = checklist.replaceAll("`", "");
  for (const requirement of REQUIREMENTS) {
    assert.match(normalized, requirement);
  }
}

export function buildGithubWorkChecklistReviewScript(file: string): string {
  return [
    'const assert = require("node:assert/strict");',
    `const checklist = require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8");`,
    'const normalized = checklist.replaceAll("`", "");',
    `for (const requirement of [${REQUIREMENTS.join(",")}]) assert.match(normalized, requirement);`,
    'console.log("CHECKLIST_TEST_PASS");',
  ].join("\n");
}
