/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScheduleInspection } from "./use-schedule-inspection";

const { client, queryOptions } = vi.hoisted(() => ({
  client: { scheduleInspect: vi.fn() },
  queryOptions: {
    current: null as null | {
      enabled?: boolean;
      queryKey?: readonly unknown[];
      refetchInterval?: number;
    },
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/data/query", () => ({
  useFetchQuery: (options: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
    refetchInterval?: number;
  }) => {
    queryOptions.current = options;
    return { data: undefined };
  },
}));

describe("useScheduleInspection", () => {
  afterEach(() => {
    cleanup();
    queryOptions.current = null;
  });

  it("polls while the occurrence panel is open before the first run fires", () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useScheduleInspection("host-a", "schedule-1", { enabled }),
      { initialProps: { enabled: true } },
    );

    expect(queryOptions.current).toMatchObject({
      enabled: true,
      queryKey: ["scheduleInspection", "host-a", "schedule-1"],
      refetchInterval: 5_000,
    });

    rerender({ enabled: false });
    expect(queryOptions.current?.enabled).toBe(false);
  });
});
