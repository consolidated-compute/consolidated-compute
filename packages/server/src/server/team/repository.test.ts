import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { PersistedTeamDefinition, PersistedTeamRunRecord } from "./model.js";
import {
  TEAM_RUN_PAGE_MAX_LIMIT,
  TeamRepository,
  TeamHasActiveRunError,
  TeamRepositoryIdError,
  TeamRevisionConflictError,
  TeamRunPageError,
  TeamStorageCorruptError,
  type CreateTeamDefinitionInput,
  type CreateTeamRunInput,
  type TeamRepositoryChange,
} from "./repository.js";

const firstTimestamp = "2026-08-25T12:00:00.000Z";
const secondTimestamp = "2026-08-25T12:01:00.000Z";
const firstAgentId = "28c954c9-f75c-49d6-8477-900c99a6dc0b";
const secondAgentId = "6fcf0340-95e6-49eb-8e01-4c95da99884e";

function createDefinitionInput(): CreateTeamDefinitionInput {
  return {
    name: "Delivery team",
    instructions: "Ship the objective with a separate review step.",
    roles: [
      {
        id: "role_builder",
        name: "Builder",
        instructions: "Implement and verify the requested change.",
        profileId: "profile_builder",
      },
      {
        id: "role_reviewer",
        name: "Reviewer",
        instructions: "Review the implementation for correctness.",
        profileId: "profile_reviewer",
      },
    ],
    workflow: [
      { id: "step_build", roleId: "role_builder", instructions: null },
      {
        id: "step_review",
        roleId: "role_reviewer",
        instructions: "Report only actionable findings.",
      },
    ],
  };
}

function createRunInput(
  definition: PersistedTeamDefinition,
  idempotencyKey = "start-1",
): CreateTeamRunInput {
  const roles = new Map(definition.roles.map((role) => [role.id, role]));
  return {
    teamId: definition.id,
    expectedRevision: definition.revision,
    idempotencyKey,
    objective: "Deliver the requested repository change.",
    workspace: {
      workspaceId: "wks_0123456789abcdef",
      projectId: "prj_0123456789abcdef",
      cwd: "/repo/worktree",
      displayName: "feature/teams",
    },
    steps: definition.workflow.map((workflowStep) => {
      const role = roles.get(workflowStep.roleId);
      if (!role) throw new Error(`Missing role ${workflowStep.roleId}`);
      return {
        snapshot: {
          stepId: workflowStep.id,
          roleId: role.id,
          roleName: role.name,
          roleInstructions: role.instructions,
          stepInstructions: workflowStep.instructions,
          resolvedLaunch: {
            profileId: role.profileId,
            provider: role.id === "role_builder" ? "codex" : "claude",
            model: role.id === "role_builder" ? "gpt-5.6" : null,
            modeId: role.id === "role_builder" ? "workspace-write" : null,
            thinkingOptionId: role.id === "role_builder" ? "high" : null,
            featureValues: role.id === "role_builder" ? { web_search: true } : {},
          },
        },
        state: { status: "pending" as const },
      };
    }),
  };
}

function succeededRunState(run: PersistedTeamRunRecord) {
  const agentIds = [firstAgentId, secondAgentId];
  return {
    state: {
      status: "succeeded" as const,
      startedAt: firstTimestamp,
      endedAt: secondTimestamp,
    },
    steps: run.steps.map((step, index) => {
      const timestamp = index === 0 ? firstTimestamp : secondTimestamp;
      return {
        ...step,
        state: {
          status: "succeeded" as const,
          plannedAgentId: agentIds[index]!,
          agentId: agentIds[index]!,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      };
    }),
  };
}

describe("TeamRepository definitions", () => {
  let paseoHome: string;
  let currentTimestamp: string;
  let repository: TeamRepository;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "team-repository-test-"));
    currentTimestamp = firstTimestamp;
    repository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates definitions and reloads them after restart", async () => {
    const created = await repository.createDefinition(createDefinitionInput());

    expect(created).toMatchObject({
      id: expect.stringMatching(/^team_[0-9a-f]{16}$/),
      revision: 1,
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });

    const reloaded = new TeamRepository({ paseoHome });
    await expect(reloaded.getDefinition(created.id)).resolves.toEqual(created);
    await expect(reloaded.listDefinitions()).resolves.toEqual({
      definitions: [created],
      issues: [],
    });
  });

  test("keeps definitions visible when their host profile is missing", async () => {
    const input = createDefinitionInput();
    input.roles[0] = { ...input.roles[0]!, profileId: "profile_deleted_later" };

    const created = await repository.createDefinition(input);

    await expect(new TeamRepository({ paseoHome }).listDefinitions()).resolves.toEqual({
      definitions: [created],
      issues: [],
    });
  });

  test("patches one definition field without replacing the remaining record", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;

    const updated = await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Release team" },
    });

    expect(updated).toEqual({
      ...created,
      name: "Release team",
      revision: 2,
      updatedAt: secondTimestamp,
    });
    await expect(new TeamRepository({ paseoHome }).getDefinition(created.id)).resolves.toEqual(
      updated,
    );
  });

  test("serializes concurrent updates so exactly one stale revision fails", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;

    const outcomes = await Promise.allSettled([
      repository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { name: "First update" },
      }),
      repository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { instructions: "Second update" },
      }),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<PersistedTeamDefinition> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TeamRevisionConflictError);
    expect(rejected[0]?.reason).toMatchObject({
      code: "team_revision_conflict",
      teamId: created.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    await expect(repository.getDefinition(created.id)).resolves.toEqual(fulfilled[0]?.value);
  });

  test("serializes stale-revision updates across repository instances", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    let releaseFirstWrite: (() => void) | null = null;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEntered: (() => void) | null = null;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteEntered = resolve;
    });
    const firstRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(secondTimestamp),
      writeJson: async (filePath, value) => {
        firstWriteEntered?.();
        await firstWriteBlocked;
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const secondRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(secondTimestamp),
    });

    const firstUpdate = firstRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "First instance" },
    });
    await firstWriteStarted;
    const secondUpdate = secondRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Second instance" },
    });
    releaseFirstWrite?.();
    const outcomes = await Promise.allSettled([firstUpdate, secondUpdate]);

    expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "team_revision_conflict", actualRevision: 2 },
    });
    await expect(repository.getDefinition(created.id)).resolves.toMatchObject({
      name: "First instance",
      revision: 2,
    });
  });

  test("reports unknown and corrupt files without hiding healthy definitions", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    const definitionsDir = join(paseoHome, "teams", "definitions");
    await writeFile(join(definitionsDir, "broken.json"), '{"id":', "utf8");
    await writeFile(join(definitionsDir, "notes.txt"), "unexpected", "utf8");

    const listed = await repository.listDefinitions();

    expect(listed.definitions).toEqual([created]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "definitions",
        fileName: "broken.json",
        kind: "invalid_record",
      }),
      expect.objectContaining({
        collection: "definitions",
        fileName: "notes.txt",
        kind: "unknown_file",
      }),
    ]);
  });

  test("notifies observers only after durable definition changes", async () => {
    const changes: TeamRepositoryChange[] = [];
    const unsubscribe = repository.subscribe((change) => changes.push(change));
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;
    const updated = await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Observed update" },
    });
    await repository.deleteDefinition({ teamId: created.id, expectedRevision: 2 });
    unsubscribe();
    await repository.createDefinition({
      ...createDefinitionInput(),
      name: "Unobserved team",
    });

    expect(changes).toEqual([
      { type: "definition_created", definition: created },
      { type: "definition_updated", definition: updated },
      { type: "definition_deleted", teamId: created.id, revision: 2 },
    ]);
  });

  test("rejects deletion with a stale revision", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Second revision" },
    });

    await expect(
      repository.deleteDefinition({ teamId: created.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(TeamRevisionConflictError);
    await expect(repository.getDefinition(created.id)).resolves.toMatchObject({ revision: 2 });
  });

  test("retains the previous record when an atomic update is interrupted", async () => {
    let interruptNextWrite = false;
    const interruptedRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      writeJson: async (filePath, value) => {
        if (interruptNextWrite) {
          await writeFile(`${filePath}.interrupted.tmp`, '{"partial":', "utf8");
          throw new Error("simulated interruption before rename");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const changes: TeamRepositoryChange[] = [];
    interruptedRepository.subscribe((change) => changes.push(change));
    const created = await interruptedRepository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;
    interruptNextWrite = true;

    await expect(
      interruptedRepository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { name: "Incomplete update" },
      }),
    ).rejects.toThrow("simulated interruption before rename");

    await expect(interruptedRepository.getDefinition(created.id)).resolves.toEqual(created);
    expect(changes).toEqual([{ type: "definition_created", definition: created }]);

    interruptNextWrite = false;
    const recovered = await interruptedRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Recovered update" },
    });
    expect(recovered).toMatchObject({ name: "Recovered update", revision: 2 });
  });

  test("reports unknown directories in the definitions collection", async () => {
    await mkdir(join(paseoHome, "teams", "definitions", "nested"), { recursive: true });

    const listed = await repository.listDefinitions();

    expect(listed.definitions).toEqual([]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "definitions",
        fileName: "nested",
        kind: "unknown_file",
      }),
    ]);
  });

  test("rejects path-shaped IDs at the repository boundary", async () => {
    await expect(repository.getDefinition("../outside")).rejects.toBeInstanceOf(
      TeamRepositoryIdError,
    );
    await expect(repository.getRun("../../outside")).rejects.toMatchObject({
      code: "invalid_team_repository_id",
      entityId: "../../outside",
    });
  });
});

describe("TeamRepository runs", () => {
  let paseoHome: string;
  let currentTimestamp: string;
  let repository: TeamRepository;
  let definition: PersistedTeamDefinition;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "team-run-repository-test-"));
    currentTimestamp = firstTimestamp;
    repository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
    definition = await repository.createDefinition(createDefinitionInput());
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("durably creates a queued run with the accepted Team snapshot", async () => {
    const run = await repository.createRun(createRunInput(definition));

    expect(run).toMatchObject({
      id: expect.stringMatching(/^trun_[0-9a-f]{16}$/),
      teamId: definition.id,
      teamRevision: 1,
      idempotencyKey: "start-1",
      teamSnapshot: definition,
      state: { status: "queued" },
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    await expect(new TeamRepository({ paseoHome }).getRun(run.id)).resolves.toEqual(run);
  });

  test("returns one run for concurrent starts with the same idempotency key", async () => {
    const input = createRunInput(definition);

    const [first, second] = await Promise.all([
      repository.createRun(input),
      repository.createRun(input),
    ]);

    expect(second).toEqual(first);
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [first], issues: [] });
  });

  test("creates distinct runs for different idempotency keys", async () => {
    const first = await repository.createRun(createRunInput(definition, "start-1"));
    const second = await repository.createRun(createRunInput(definition, "start-2"));

    expect(second.id).not.toBe(first.id);
    await expect(repository.listRuns()).resolves.toMatchObject({
      runs: expect.arrayContaining([first, second]),
      issues: [],
    });
  });

  test("rejects a stale Team revision before creating a new run", async () => {
    await repository.updateDefinition({
      teamId: definition.id,
      expectedRevision: 1,
      patch: { name: "New revision" },
    });

    await expect(repository.createRun(createRunInput(definition))).rejects.toMatchObject({
      code: "team_revision_conflict",
      teamId: definition.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [], issues: [] });
  });

  test("returns an idempotent run after the Team revision changes", async () => {
    const run = await repository.createRun(createRunInput(definition));
    await repository.updateDefinition({
      teamId: definition.id,
      expectedRevision: 1,
      patch: { name: "New revision" },
    });

    await expect(repository.createRun(createRunInput(definition))).resolves.toEqual(run);
  });

  test("rejects deletion while the Team owns an active run", async () => {
    const run = await repository.createRun(createRunInput(definition));

    await expect(
      repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 }),
    ).rejects.toEqual(new TeamHasActiveRunError(definition.id, run.id));
    await expect(repository.getDefinition(definition.id)).resolves.toEqual(definition);
  });

  test("deletes a Team after completion while preserving its run snapshot", async () => {
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;
    const completed = await repository.updateRun(run.id, (current) => succeededRunState(current));

    await repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 });

    const reloaded = new TeamRepository({ paseoHome });
    await expect(reloaded.getDefinition(definition.id)).resolves.toBeNull();
    await expect(reloaded.getRun(run.id)).resolves.toEqual(completed);
    expect(completed.teamSnapshot).toEqual(definition);
  });

  test("preserves frozen snapshots when an updater mutates its input", async () => {
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;

    const updated = await repository.updateRun(run.id, (current) => {
      current.teamSnapshot.name = "Rewritten Team";
      current.workspace.displayName = "rewritten/workspace";
      current.steps[0]!.snapshot.roleName = "Rewritten role";
      current.steps[1]!.snapshot.resolvedLaunch.model = "rewritten-model";
      return succeededRunState(current);
    });

    expect(updated.teamSnapshot).toEqual(run.teamSnapshot);
    expect(updated.workspace).toEqual(run.workspace);
    expect(updated.steps.map((step) => step.snapshot)).toEqual(
      run.steps.map((step) => step.snapshot),
    );
    await expect(repository.getRun(run.id)).resolves.toEqual(updated);
  });

  test("notifies observers after durable run creation and updates", async () => {
    const changes: TeamRepositoryChange[] = [];
    repository.subscribe((change) => changes.push(change));
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;
    const completed = await repository.updateRun(run.id, (current) => succeededRunState(current));

    expect(changes.slice(-2)).toEqual([
      { type: "run_created", run },
      { type: "run_updated", run: completed },
    ]);
  });

  test("reports corrupt run files without hiding healthy history", async () => {
    const run = await repository.createRun(createRunInput(definition));
    const runsDir = join(paseoHome, "teams", "runs");
    await writeFile(join(runsDir, "broken.json"), "not-json", "utf8");

    const listed = await repository.listRuns();

    expect(listed.runs).toEqual([run]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "runs",
        fileName: "broken.json",
        kind: "invalid_record",
      }),
    ]);
  });

  test("lists runs newest-first with restart-stable cursor pagination", async () => {
    const runs: PersistedTeamRunRecord[] = [];
    for (let minute = 0; minute < 5; minute += 1) {
      currentTimestamp = `2026-08-25T12:0${minute}:00.000Z`;
      runs.push(await repository.createRun(createRunInput(definition, `start-${minute}`)));
    }

    const firstPage = await repository.listRuns({ limit: 2 });
    expect(firstPage.runs).toEqual([runs[4], runs[3]]);
    expect(firstPage.nextCursor).not.toBeNull();

    const reloaded = new TeamRepository({ paseoHome });
    const secondPage = await reloaded.listRuns({ cursor: firstPage.nextCursor!, limit: 2 });
    expect(secondPage.runs).toEqual([runs[2], runs[1]]);
    expect(secondPage.nextCursor).not.toBeNull();

    const finalPage = await reloaded.listRuns({ cursor: secondPage.nextCursor!, limit: 2 });
    expect(finalPage).toEqual({ runs: [runs[0]], nextCursor: null, issues: [] });
  });

  test("orders offset timestamps by their instant across cursor pages", async () => {
    const older = await repository.createRun(createRunInput(definition, "older"));
    const newer = await repository.createRun(createRunInput(definition, "newer"));
    const runsDir = join(paseoHome, "teams", "runs");
    await writeJsonFileAtomic(join(runsDir, `${older.id}.json`), {
      ...older,
      createdAt: "2026-08-25T13:00:00.000+01:00",
      updatedAt: "2026-08-25T13:00:00.000+01:00",
    });
    await writeJsonFileAtomic(join(runsDir, `${newer.id}.json`), {
      ...newer,
      createdAt: "2026-08-25T12:30:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
    });

    const firstPage = await repository.listRuns({ limit: 1 });
    expect(firstPage.runs.map((run) => run.id)).toEqual([newer.id]);
    const secondPage = await repository.listRuns({ cursor: firstPage.nextCursor!, limit: 1 });
    expect(secondPage.runs.map((run) => run.id)).toEqual([older.id]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test("binds a run cursor to its Team filter", async () => {
    currentTimestamp = "2026-08-25T12:02:00.000Z";
    await repository.createRun(createRunInput(definition, "start-2"));
    currentTimestamp = "2026-08-25T12:03:00.000Z";
    await repository.createRun(createRunInput(definition, "start-3"));
    const page = await repository.listRuns({ limit: 1 });

    await expect(
      repository.listRuns({ teamId: definition.id, cursor: page.nextCursor!, limit: 1 }),
    ).rejects.toEqual(new TeamRunPageError("Team Run cursor does not match the Team filter"));
  });

  test("rejects run page sizes outside the bounded range", async () => {
    await expect(repository.listRuns({ limit: 0 })).rejects.toBeInstanceOf(TeamRunPageError);
    await expect(
      repository.listRuns({ limit: TEAM_RUN_PAGE_MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(TeamRunPageError);
  });

  test("fails closed when corruption prevents a complete idempotency check", async () => {
    const runsDir = join(paseoHome, "teams", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "broken.json"), "not-json", "utf8");

    await expect(repository.createRun(createRunInput(definition))).rejects.toBeInstanceOf(
      TeamStorageCorruptError,
    );
    await expect(
      repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(TeamStorageCorruptError);
  });

  test("reports a leftover atomic temp file without blocking new runs", async () => {
    const runsDir = join(paseoHome, "teams", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, ".interrupted.tmp"), "partial", "utf8");

    const run = await repository.createRun(createRunInput(definition));
    const listed = await repository.listRuns();

    expect(listed.runs).toEqual([run]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "runs",
        fileName: ".interrupted.tmp",
        kind: "unknown_file",
      }),
    ]);
  });
});
