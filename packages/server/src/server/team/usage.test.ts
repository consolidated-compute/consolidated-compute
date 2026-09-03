import { describe, expect, test } from "vitest";

import type { PersistedTeamRunRecord } from "./model.js";
import { aggregateTeamRunUsage, snapshotTeamRunStepUsage } from "./usage.js";

describe("Team Run usage snapshots", () => {
  test("reports unavailable usage without inventing zero values", () => {
    expect(snapshotTeamRunStepUsage([undefined])).toEqual({ status: "unavailable" });
    expect(snapshotTeamRunStepUsage([{ inputTokens: Number.NaN }])).toEqual({
      status: "unavailable",
    });
  });

  test("aggregates additive usage and retains the latest context window reading", () => {
    expect(
      snapshotTeamRunStepUsage([
        {
          inputTokens: 10,
          cachedInputTokens: 4,
          outputTokens: 2,
          totalCostUsd: 0.01,
          contextWindowMaxTokens: 100_000,
          contextWindowUsedTokens: 10,
        },
        {
          inputTokens: 5,
          outputTokens: 3,
          totalCostUsd: 0.03,
          contextWindowMaxTokens: 100_000,
          contextWindowUsedTokens: 20,
        },
      ]),
    ).toEqual({
      status: "reported",
      inputTokens: 15,
      cachedInputTokens: 4,
      outputTokens: 5,
      totalCostUsd: 0.03,
      contextWindowMaxTokens: 100_000,
      contextWindowUsedTokens: 20,
    });
  });

  test("marks totals partial when a provider turn omits usage", () => {
    expect(snapshotTeamRunStepUsage([{ inputTokens: 7 }, undefined])).toEqual({
      status: "partial",
      inputTokens: 7,
    });
    expect(snapshotTeamRunStepUsage([{ totalCostUsd: 0.25 }, { inputTokens: 7 }])).toEqual({
      status: "reported",
      inputTokens: 7,
      totalCostUsd: 0.25,
    });
  });

  test("aggregates completed step usage and exposes unavailable coverage", () => {
    const steps = [
      {
        state: {
          status: "succeeded" as const,
          plannedAgentId: "b3112a42-7f32-4810-a2e0-8f747b5473c3",
          agentId: "b3112a42-7f32-4810-a2e0-8f747b5473c3",
          startedAt: "2026-09-02T12:00:00.000Z",
          endedAt: "2026-09-02T12:01:00.000Z",
          usage: { status: "reported" as const, inputTokens: 10, totalCostUsd: 0.01 },
        },
      },
      {
        state: {
          status: "failed" as const,
          plannedAgentId: "84d66a18-211f-4713-9c61-6ac728a56c12",
          agentId: "84d66a18-211f-4713-9c61-6ac728a56c12",
          startedAt: "2026-09-02T12:01:00.000Z",
          endedAt: "2026-09-02T12:02:00.000Z",
          error: "Provider failed without reporting usage.",
        },
      },
    ] as PersistedTeamRunRecord["steps"];

    expect(aggregateTeamRunUsage({ steps })).toEqual({
      status: "partial",
      reportedSteps: 1,
      unavailableSteps: 1,
      inputTokens: 10,
      totalCostUsd: 0.01,
    });
    expect(aggregateTeamRunUsage({ steps: [] })).toEqual({
      status: "unavailable",
      reportedSteps: 0,
      unavailableSteps: 0,
    });
  });

  test("retains the latest cumulative cost for a reused agent", () => {
    const reusedAgentId = "b3112a42-7f32-4810-a2e0-8f747b5473c3";
    const otherAgentId = "84d66a18-211f-4713-9c61-6ac728a56c12";
    const steps = [
      {
        state: {
          status: "succeeded" as const,
          plannedAgentId: reusedAgentId,
          agentId: reusedAgentId,
          startedAt: "2026-09-02T12:00:00.000Z",
          endedAt: "2026-09-02T12:01:00.000Z",
          usage: { status: "reported" as const, totalCostUsd: 0.25 },
        },
      },
      {
        state: {
          status: "succeeded" as const,
          plannedAgentId: reusedAgentId,
          agentId: reusedAgentId,
          startedAt: "2026-09-02T12:01:00.000Z",
          endedAt: "2026-09-02T12:02:00.000Z",
          usage: { status: "reported" as const, totalCostUsd: 0.5 },
        },
      },
      {
        state: {
          status: "succeeded" as const,
          plannedAgentId: otherAgentId,
          agentId: otherAgentId,
          startedAt: "2026-09-02T12:02:00.000Z",
          endedAt: "2026-09-02T12:03:00.000Z",
          usage: { status: "reported" as const, totalCostUsd: 0.2 },
        },
      },
    ] as PersistedTeamRunRecord["steps"];

    expect(aggregateTeamRunUsage({ steps })).toMatchObject({ totalCostUsd: 0.7 });
  });
});
