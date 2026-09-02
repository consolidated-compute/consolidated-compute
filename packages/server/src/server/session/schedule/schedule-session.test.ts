import { describe, expect, it } from "vitest";
import pino from "pino";
import { ScheduleSession } from "./schedule-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { ScheduleService } from "../../schedule/service.js";

function makeSession(
  schedule: { [K in keyof ScheduleService]?: unknown },
  options: {
    supportsAssignmentTeamSchedules?: boolean;
    supportedSources?: ReadonlySet<object>;
    assignmentTeamSchedulesAvailable?: boolean;
  } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const emissions: Array<{ message: SessionOutboundMessage; source: object | undefined }> = [];
  const session = new ScheduleSession({
    host: {
      emit: (message, source) => {
        emitted.push(message);
        emissions.push({ message, source });
      },
      supportsAssignmentTeamSchedules: (source) =>
        source && options.supportedSources
          ? options.supportedSources.has(source)
          : options.supportsAssignmentTeamSchedules === true,
    },
    scheduleService: createStub<ScheduleService>(schedule),
    logger: pino({ level: "silent" }),
    assignmentTeamSchedulesAvailable: options.assignmentTeamSchedulesAvailable === true,
  });
  return { session, emitted, emissions };
}

const assignmentTeamSchedule = {
  id: "team-schedule-1",
  name: "Daily triage",
  prompt: "Run the selected Assignment",
  cadence: { type: "cron" as const, expression: "0 9 * * *" },
  target: {
    type: "assignment-team-run" as const,
    teamId: "team-1",
    assignmentId: "assignment-1",
    workspaceId: "workspace-1",
  },
  status: "active" as const,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  nextRunAt: "2026-09-03T09:00:00.000Z",
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
};

describe("ScheduleSession", () => {
  it("schedule/create returns a summary with the runs stripped", async () => {
    const stored = {
      id: "s1",
      name: null,
      prompt: "p",
      cadence: { type: "every" as const, everyMs: 1000 },
      target: { type: "agent" as const, agentId: "a" },
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [
        {
          id: "run-1",
          scheduledFor: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          status: "running" as const,
          agentId: null,
          output: null,
          error: null,
        },
      ],
    };
    const { session, emitted } = makeSession({ create: async () => stored });

    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "sc1",
      prompt: "p",
      cadence: { type: "every", everyMs: 1000 },
      target: { type: "agent", agentId: "a" },
    });

    const response = findByType(emitted, "schedule/create/response");
    expect(response?.payload.schedule).toBeDefined();
    expect(response?.payload.schedule).not.toHaveProperty("runs");
    expect(response?.payload.schedule.id).toBe("s1");
  });

  it("schedule/create remaps a self target to an agent target before creating", async () => {
    let received: Parameters<ScheduleService["create"]>[0] | undefined;
    const stored = {
      id: "s2",
      name: null,
      prompt: "p",
      cadence: { type: "every" as const, everyMs: 1000 },
      target: { type: "agent" as const, agentId: "agent-9" },
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    };
    const { session, emitted } = makeSession({
      create: async (input: Parameters<ScheduleService["create"]>[0]) => {
        received = input;
        return stored;
      },
    });

    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "sc2",
      prompt: "p",
      cadence: { type: "every", everyMs: 1000 },
      target: { type: "self", agentId: "agent-9" },
    });

    expect(received?.target).toEqual({ type: "agent", agentId: "agent-9" });
    expect(findByType(emitted, "schedule/create/response")?.payload.error).toBeNull();
  });

  it("creates Assignment Team Run schedules only for capable clients", async () => {
    let received: Parameters<ScheduleService["create"]>[0] | undefined;
    const service = {
      create: async (input: Parameters<ScheduleService["create"]>[0]) => {
        received = input;
        return assignmentTeamSchedule;
      },
    };
    const incapable = makeSession(service, { assignmentTeamSchedulesAvailable: true });
    const request = {
      type: "schedule/create" as const,
      requestId: "team-schedule-create",
      prompt: "Run the selected Assignment",
      cadence: { type: "cron" as const, expression: "0 9 * * *" },
      target: assignmentTeamSchedule.target,
    };

    const unavailable = makeSession(service, { supportsAssignmentTeamSchedules: true });
    await unavailable.session.handleScheduleCreateRequest(request);
    expect(received).toBeUndefined();
    expect(findByType(unavailable.emitted, "rpc_error")?.payload.error).toContain(
      "Update the host",
    );

    await incapable.session.handleScheduleCreateRequest(request);

    expect(received).toBeUndefined();
    expect(findByType(incapable.emitted, "rpc_error")?.payload.code).toBe(
      "schedule_request_failed",
    );

    const capable = makeSession(service, {
      supportsAssignmentTeamSchedules: true,
      assignmentTeamSchedulesAvailable: true,
    });
    await capable.session.handleScheduleCreateRequest(request);

    expect(received?.target).toEqual(assignmentTeamSchedule.target);
    expect(
      findByType(capable.emitted, "schedule/create/response")?.payload.schedule?.target,
    ).toEqual(assignmentTeamSchedule.target);
  });

  it("filters Assignment Team Run schedules from legacy list responses", async () => {
    const ordinarySchedule = {
      ...assignmentTeamSchedule,
      id: "agent-schedule-1",
      target: { type: "agent" as const, agentId: "agent-1" },
    };
    const list = async () => [ordinarySchedule, assignmentTeamSchedule];

    const incapable = makeSession({ list });
    await incapable.session.handleScheduleListRequest({
      type: "schedule/list",
      requestId: "legacy-list",
    });
    expect(findByType(incapable.emitted, "schedule/list/response")?.payload.schedules).toEqual([
      expect.objectContaining({ id: ordinarySchedule.id }),
    ]);

    const capable = makeSession({ list }, { supportsAssignmentTeamSchedules: true });
    await capable.session.handleScheduleListRequest({
      type: "schedule/list",
      requestId: "capable-list",
    });
    expect(
      findByType(capable.emitted, "schedule/list/response")?.payload.schedules.map(
        (schedule) => schedule.id,
      ),
    ).toEqual([ordinarySchedule.id, assignmentTeamSchedule.id]);
  });

  it("projects and emits schedule responses for the requesting source", async () => {
    const ordinarySchedule = {
      ...assignmentTeamSchedule,
      id: "agent-schedule-1",
      target: { type: "agent" as const, agentId: "agent-1" },
    };
    const legacySource = {};
    const capableSource = {};
    const { session, emissions } = makeSession(
      { list: async () => [ordinarySchedule, assignmentTeamSchedule] },
      { supportedSources: new Set([capableSource]) },
    );

    await session.handleScheduleListRequest(
      { type: "schedule/list", requestId: "legacy-list" },
      legacySource,
    );
    await session.handleScheduleListRequest(
      { type: "schedule/list", requestId: "capable-list" },
      capableSource,
    );

    expect(emissions).toEqual([
      {
        source: legacySource,
        message: expect.objectContaining({
          type: "schedule/list/response",
          payload: expect.objectContaining({
            requestId: "legacy-list",
            schedules: [expect.objectContaining({ id: ordinarySchedule.id })],
          }),
        }),
      },
      {
        source: capableSource,
        message: expect.objectContaining({
          type: "schedule/list/response",
          payload: expect.objectContaining({
            requestId: "capable-list",
            schedules: [
              expect.objectContaining({ id: ordinarySchedule.id }),
              expect.objectContaining({ id: assignmentTeamSchedule.id }),
            ],
          }),
        }),
      },
    ]);
  });

  it("hides Assignment Team Run schedules from legacy inspect and mutation requests", async () => {
    let mutationCalls = 0;
    const { session, emitted } = makeSession({
      inspect: async () => assignmentTeamSchedule,
      logs: async () => {
        mutationCalls += 1;
        return [];
      },
      pause: async () => {
        mutationCalls += 1;
        return assignmentTeamSchedule;
      },
      resume: async () => {
        mutationCalls += 1;
        return assignmentTeamSchedule;
      },
      delete: async () => {
        mutationCalls += 1;
      },
      runOnce: async () => {
        mutationCalls += 1;
        return assignmentTeamSchedule;
      },
      update: async () => {
        mutationCalls += 1;
        return assignmentTeamSchedule;
      },
    });

    await session.handleScheduleInspectRequest({
      type: "schedule/inspect",
      requestId: "inspect",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleScheduleLogsRequest({
      type: "schedule/logs",
      requestId: "logs",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleSchedulePauseRequest({
      type: "schedule/pause",
      requestId: "pause",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleScheduleResumeRequest({
      type: "schedule/resume",
      requestId: "resume",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleScheduleDeleteRequest({
      type: "schedule/delete",
      requestId: "delete",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleScheduleRunOnceRequest({
      type: "schedule/run-once",
      requestId: "run-once",
      scheduleId: assignmentTeamSchedule.id,
    });
    await session.handleScheduleUpdateRequest({
      type: "schedule/update",
      requestId: "update",
      scheduleId: assignmentTeamSchedule.id,
      name: "Changed",
    });

    expect(mutationCalls).toBe(0);
    expect(emitted.filter((message) => message.type === "rpc_error")).toHaveLength(7);
    expect(
      emitted.some((message) =>
        [
          "schedule/inspect/response",
          "schedule/logs/response",
          "schedule/pause/response",
          "schedule/resume/response",
          "schedule/delete/response",
          "schedule/run-once/response",
          "schedule/update/response",
        ].includes(message.type),
      ),
    ).toBe(false);
  });
});
