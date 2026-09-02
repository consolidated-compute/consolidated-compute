/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { TeamRunSupervisionPanel } from "./team-run-supervision-panel";

const { navigation, stateQuery, eventsQuery } = vi.hoisted(() => ({
  navigation: { push: vi.fn() },
  stateQuery: {
    data: {
      runId: "run-1",
      revision: 4,
      status: "awaiting_human",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "supervisor-agent",
      completedWorkItems: 1,
      totalWorkItems: 2,
      humanRequest: {
        id: "human-1",
        revision: 2,
        kind: "approval",
        title: "Approve the exception",
        detail: "Inspect the exact evidence before continuing.",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: ["supervisor"],
        agentIds: ["supervisor-agent"],
        stepIds: ["supervisor-turn"],
        artifactIds: ["artifact-1"],
        createdAt: "2026-09-01T12:01:00.000Z",
      },
      updatedAt: "2026-09-01T12:01:00.000Z",
    },
    supported: true,
    canLoad: true,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  eventsQuery: {
    supported: true,
    canLoad: true,
    isLoading: false,
    isError: false,
    error: null,
    events: [
      {
        id: "event-1",
        sequence: 1,
        kind: "future.supervision.event",
        title: "Future event remains visible",
        detail: "The app does not need to know this event kind.",
        decisionId: "decision-1",
        actionId: null,
        workItemId: "work-1",
        attemptId: null,
        humanRequestId: "human-1",
        roleIds: ["supervisor"],
        agentIds: ["supervisor-agent"],
        stepIds: ["supervisor-turn"],
        artifactIds: ["artifact-1"],
        createdAt: "2026-09-01T12:01:00.000Z",
      },
    ],
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({ permissionIcon: {}, spinner: {} }) },
}));

vi.mock("lucide-react-native", () => ({
  Bot: () => <span />,
  RefreshCw: () => <span />,
  ShieldAlert: () => <span />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("expo-router", () => ({
  router: navigation,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress} data-testid={testID}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => <span /> }));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));

vi.mock("./team-supervision-response-sheet", () => ({
  TeamSupervisionResponseSheet: ({ request }: { request: { title: string } }) => (
    <div data-testid="response-sheet">{request.title}</div>
  ),
}));

vi.mock("./use-team-run-supervision", () => ({
  useTeamRunSupervision: () => stateQuery,
  useTeamRunSupervisionEvents: () => eventsQuery,
}));

const run: TeamRunDto = {
  id: "run-1",
  teamId: "team-1",
  teamRevision: 1,
  idempotencyKey: "run-key",
  teamSnapshot: {
    id: "team-1",
    revision: 1,
    name: "Delivery",
    instructions: "Ship safely",
    roles: [
      {
        id: "supervisor",
        name: "Supervisor",
        instructions: "Coordinate",
        profileId: "supervisor-profile",
      },
      {
        id: "worker",
        name: "Worker",
        instructions: "Implement",
        profileId: "worker-profile",
      },
    ],
    workflow: [{ id: "work", roleId: "worker", instructions: null }],
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  },
  objective: "Ship the feature",
  workspace: {
    workspaceId: "workspace-1",
    projectId: "project-1",
    cwd: "/repo",
    displayName: "main",
  },
  steps: [
    {
      snapshot: {
        stepId: "work-attempt-1",
        roleId: "worker",
        roleName: "Worker",
        roleInstructions: "Implement",
        stepInstructions: null,
        resolvedLaunch: {
          profileId: "worker-profile",
          provider: "codex",
          model: "gpt-5.6",
          modeId: null,
          thinkingOptionId: null,
          featureValues: {},
        },
      },
      state: {
        status: "waiting_for_permission",
        plannedAgentId: "worker-agent",
        agentId: "worker-agent",
        startedAt: "2026-09-01T12:00:00.000Z",
      },
    },
  ],
  supervision: {
    status: "awaiting_human",
    supervisorRoleId: "supervisor",
    supervisorAgentId: "supervisor-agent",
    completedWorkItems: 1,
    totalWorkItems: 2,
    pendingHumanRequest: {
      id: "human-1",
      kind: "approval",
      title: "Approve the exception",
      revision: 2,
    },
    updatedAt: "2026-09-01T12:01:00.000Z",
  },
  state: {
    status: "waiting_for_permission",
    startedAt: "2026-09-01T12:00:00.000Z",
  },
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:01:00.000Z",
};

describe("TeamRunSupervisionPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    navigation.push.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps requests, unknown activity, exact references, and provider permissions inspectable", () => {
    render(<TeamRunSupervisionPanel serverId="host-a" run={run} enabled />);

    expect(screen.getByTestId("team-run-supervision-summary").textContent).toContain(
      "teams.runs.supervision.needsReview",
    );
    expect(screen.getByTestId("team-run-supervision-event-event-1").textContent).toContain(
      "Future event remains visible",
    );
    expect(screen.getByTestId("team-run-supervision-event-event-1").textContent).toContain(
      "artifact-1",
    );

    fireEvent.click(screen.getByTestId("team-run-supervision-review"));
    expect(screen.getByTestId("response-sheet").textContent).toContain("Approve the exception");

    fireEvent.click(screen.getByText("teams.runs.supervision.permission.openAgent"));
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining("worker-agent"));
  });
});
