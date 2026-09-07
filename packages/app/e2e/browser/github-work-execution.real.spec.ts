import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "../support/fixtures";
import { addConnectedHostAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { prepareGithubWorkRun } from "../support/helpers/github-work-journey";
import { assertGithubWorkChecklist } from "../support/helpers/github-work-checklist";
import {
  GITHUB_WORK_PROOF_FILE,
  GITHUB_WORK_PROOF_MODEL,
  startGithubWorkProof,
} from "../support/helpers/github-work-proof";

// Explicit real-provider target. Never retry this paid proof or substitute a model.
test.describe.configure({ retries: 0 });

test("executes real GitHub Work through supervised Artifacts and a reviewable diff", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const proof = await startGithubWorkProof();
  let lastRun: TeamRunDto | null = null;
  try {
    await page.goto("/github-work");
    await addConnectedHostAndReload(page, { ...proof, label: "GitHub proof host" });
    const { assignment, workspace } = await prepareGithubWorkRun(page, proof, testInfo);
    await page.getByTestId("team-run-start").click();
    await expect(page).toHaveURL(/\/teams\/[^/]+\/[^/]+\/runs\//);
    const runId = new URL(page.url()).pathname.split("/").at(-1)!;
    const deadline = Date.now() + 420_000;
    lastRun = (await proof.client.getTeamRun(runId)).run;
    while (["queued", "running"].includes(lastRun.state.status)) {
      if (Date.now() > deadline) throw new Error("Spark proof exceeded its seven-minute budget");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const next = (await proof.client.getTeamRun(runId)).run;
      if (next.supervision?.pendingHumanRequest) {
        lastRun = next;
        throw new Error("Spark proof unexpectedly requested human intervention");
      }
      if (
        JSON.stringify(next.steps.map((step) => step.state.status)) !==
        JSON.stringify(lastRun.steps.map((step) => step.state.status))
      ) {
        console.log(
          "GitHub Work proof",
          next.state.status,
          next.steps.map((step) => `${step.snapshot.roleId}:${step.state.status}`).join(", "),
        );
      }
      lastRun = next;
    }
    expect(lastRun.state.status, JSON.stringify(lastRun.state)).toBe("succeeded");
    expect(lastRun.assignmentSnapshot).toEqual(assignment);
    expect(lastRun.supervision?.status).toBe("completed");
    const workers = lastRun.steps.filter((step) => step.snapshot.roleId !== "supervisor");
    expect(workers.map((step) => step.snapshot.roleId)).toEqual(["planner", "builder", "reviewer"]);
    for (const step of lastRun.steps) {
      expect(step.snapshot.resolvedLaunch).toMatchObject({
        provider: "codex",
        model: GITHUB_WORK_PROOF_MODEL,
        thinkingOptionId: "low",
        securityPosture: { nativeDelegation: { status: "enforced" } },
      });
      expect(step.state.status).toBe("succeeded");
    }
    const { artifacts, nextCursor } = await proof.client.listAssignmentArtifacts({
      assignmentId: assignment.id,
      limit: 100,
    });
    expect(nextCursor).toBeNull();
    expect(artifacts).toHaveLength(3);
    const outputs = workers.map((step) => {
      const artifact = artifacts.find((item) => item.id === step.snapshot.outputArtifact?.id);
      if (!artifact || step.state.status !== "succeeded") throw new Error("Missing worker output");
      expect(artifact).toMatchObject({
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        producer: {
          teamRunId: runId,
          stepId: step.snapshot.stepId,
          roleId: step.snapshot.roleId,
          agentId: step.state.agentId,
        },
        truncated: false,
      });
      expect(artifact.content.trim().length).toBeGreaterThan(0);
      return artifact;
    });
    expect(workers.map((step) => step.snapshot.inputArtifactIds)).toEqual([
      [],
      [outputs[0]!.id],
      [outputs[0]!.id, outputs[1]!.id],
    ]);
    // Verify the actual provider-visible prompts, not only frozen reference metadata.
    for (const step of workers) {
      if (step.state.status !== "succeeded") throw new Error("Worker did not succeed");
      const timeline = await proof.client.fetchAgentTimeline(step.state.agentId, {
        direction: "tail",
        projection: "canonical",
        limit: 100,
      });
      expect(timeline.hasOlder).toBe(false);
      const prompt = timeline.entries
        .flatMap(({ item }) => (item.type === "user_message" ? [item.text] : []))
        .join("\n");
      for (const inputId of step.snapshot.inputArtifactIds ?? []) {
        const artifact = outputs.find((item) => item.id === inputId)!;
        expect(prompt).toContain(`ID: ${inputId}`);
        expect(prompt).toContain(artifact.content);
      }
      await testInfo.attach(`${step.snapshot.roleId}-timeline`, {
        body: JSON.stringify(timeline, null, 2),
        contentType: "application/json",
      });
    }
    const reviewer = workers[2]!;
    if (reviewer.state.status !== "succeeded") throw new Error("Reviewer did not succeed");
    const reviewTimeline = await proof.client.fetchAgentTimeline(reviewer.state.agentId, {
      direction: "tail",
      projection: "canonical",
      limit: 100,
    });
    expect(
      reviewTimeline.entries
        .flatMap(({ item }) =>
          item.type === "tool_call" &&
          item.status === "completed" &&
          item.detail.type === "shell" &&
          item.detail.exitCode === 0
            ? [item.detail.output ?? ""]
            : [],
        )
        .join("\n"),
    ).toContain("CHECKLIST_TEST_PASS");
    const checklist = await readFile(
      path.join(workspace.workspaceDirectory, GITHUB_WORK_PROOF_FILE),
      "utf8",
    );
    assertGithubWorkChecklist(checklist);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: workspace.workspaceDirectory,
        encoding: "utf8",
      }).trim(),
    ).toBe(`?? ${GITHUB_WORK_PROOF_FILE}`);
    const diff = await proof.client.getCheckoutDiff(workspace.workspaceDirectory, {
      mode: "uncommitted",
    });
    expect(diff.error).toBeNull();
    expect(diff.files).toHaveLength(1);
    expect(JSON.stringify(diff.files)).toContain(GITHUB_WORK_PROOF_FILE);
    await testInfo.attach("reviewable-diff", {
      body: JSON.stringify(diff, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach(GITHUB_WORK_PROOF_FILE, {
      body: checklist,
      contentType: "text/markdown",
    });
    await testInfo.attach("artifacts", {
      body: JSON.stringify(artifacts, null, 2),
      contentType: "application/json",
    });
    await reloadPreservingHostRegistry(page);
    await expect(page.getByTestId("team-run-status-succeeded")).toBeVisible();
    for (const artifact of artifacts) {
      await expect(
        page.getByTestId(`assignment-artifact-${proof.serverId}-${assignment.id}-${artifact.id}`),
      ).toContainText(artifact.producer.agentId);
    }
    await page.screenshot({ path: testInfo.outputPath("completed-team-run.png"), fullPage: true });
    await page.locator('[data-testid="sidebar-assignments"]:visible').click();
    await page.getByTestId(`assignment-row-${proof.serverId}-${assignment.id}`).click();
    await expect(
      page
        .getByTestId(`assignment-detail-${proof.serverId}-${assignment.id}`)
        .getByTestId(`assignment-artifact-${proof.serverId}-${assignment.id}-${outputs[2]!.id}`),
    ).toContainText(GITHUB_WORK_PROOF_FILE);
    expect(
      (await proof.client.listAssignmentArtifacts({ assignmentId: assignment.id, limit: 100 }))
        .artifacts,
    ).toEqual(artifacts);
    expect((await proof.client.getAssignment(assignment.id)).assignment.state.status).toBe("open");
    await page.screenshot({
      path: testInfo.outputPath("assignment-artifacts.png"),
      fullPage: true,
    });
  } finally {
    try {
      await testInfo.attach("team-run-and-usage", {
        body: JSON.stringify(lastRun, null, 2),
        contentType: "application/json",
      });
    } finally {
      await proof.cleanup();
    }
  }
});
