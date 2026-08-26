/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamRunFormSheet } from "./team-run-form-sheet";

const { formModel, sheetState, submissionState } = vi.hoisted(() => {
  const team: TeamDefinitionDto = {
    id: "team-1",
    revision: 1,
    name: "Delivery",
    instructions: "Ship carefully",
    roles: [],
    workflow: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  const state = {
    serverId: "host-a",
    team,
    workspaces: [],
    selectedWorkspaceId: "workspace-1",
    selectedWorkspaceDisplay: { label: "Main" },
    selectedWorkspaceCwd: "/repo",
    catalogGeneration: 0,
    objective: "Ship it",
    roleResolutions: [],
    validationIssue: null,
    canSubmit: true,
    submission: {
      serverId: "host-a",
      teamId: "team-1",
      expectedRevision: 1,
      idempotencyKey: "admission-1",
      objective: "Ship it",
      workspaceId: "workspace-1",
    },
    submitError: null,
  };
  return {
    formModel: {
      getState: () => state,
      subscribe: () => () => undefined,
      close: vi.fn(),
      applyWorkspaces: vi.fn(),
      applyProfiles: vi.fn(),
      applyProviderCatalog: vi.fn(),
      applyFeatureCatalog: vi.fn(),
      setWorkspace: vi.fn(),
      setObjective: vi.fn(),
      setSubmitError: vi.fn(),
    },
    sheetState: {
      dismissible: true,
      onClose: null as (() => void) | null,
    },
    submissionState: {
      pending: false,
      cancelCompletion: vi.fn(),
      startPress: vi.fn(),
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: Record<string, unknown>) => unknown) =>
      factory({
        spacing: { 1: 4, 3: 12, 6: 24 },
        borderRadius: { lg: 8 },
        fontSize: { sm: 13, base: 15 },
        fontWeight: { medium: "500" },
        colors: {
          foreground: "#fff",
          foregroundMuted: "#aaa",
          foregroundExtraMuted: "#888",
          border: "#444",
          surface1: "#111",
          success: "#0f0",
          error: "#f00",
        },
      }),
  },
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useHostWorkspaces: () => [],
}));

vi.mock("@/agent-profiles", () => ({
  useAgentProfiles: () => ({ profiles: [] }),
}));

vi.mock("./use-team-run-form-model", () => ({
  useTeamRunFormModel: () => formModel,
}));

vi.mock("./use-team-run-form-provider-snapshot", () => ({
  useTeamRunFormProviderSnapshot: () => undefined,
}));

vi.mock("./use-team-run-form-feature-catalogs", () => ({
  useTeamRunFormFeatureCatalogs: () => ({ connected: true }),
}));

vi.mock("./use-team-run-form-submission", () => ({
  useTeamRunFormSubmission: () => submissionState,
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    dismissible,
    footer,
    onClose,
  }: {
    children: ReactNode;
    dismissible?: boolean;
    footer?: ReactNode;
    onClose: () => void;
  }) => {
    sheetState.dismissible = dismissible ?? true;
    sheetState.onClose = onClose;
    return (
      <section>
        <button type="button" data-testid="sheet-dismiss" onClick={onClose}>
          Dismiss
        </button>
        {children}
        {footer}
      </section>
    );
  },
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
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormTextInput: () => null,
}));

vi.mock("@/components/ui/select-field", () => ({
  SelectField: () => null,
}));

describe("TeamRunFormSheet", () => {
  const team = formModel.getState().team;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    submissionState.pending = false;
    submissionState.cancelCompletion.mockReset();
    submissionState.startPress.mockReset();
    sheetState.dismissible = true;
    sheetState.onClose = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("blocks every delegated sheet dismissal while Start is pending", () => {
    const onClose = vi.fn();
    const onStarted = vi.fn();
    const view = render(
      <TeamRunFormSheet serverId="host-a" team={team} onClose={onClose} onStarted={onStarted} />,
    );

    fireEvent.click(screen.getByTestId("team-run-start"));
    expect(submissionState.startPress).toHaveBeenCalledOnce();

    submissionState.pending = true;
    view.rerender(
      <TeamRunFormSheet serverId="host-a" team={team} onClose={onClose} onStarted={onStarted} />,
    );
    expect(sheetState.dismissible).toBe(false);
    expect((screen.getByText("common.actions.cancel") as HTMLButtonElement).disabled).toBe(true);

    act(() => sheetState.onClose?.());
    expect(onClose).not.toHaveBeenCalled();
    expect(submissionState.cancelCompletion).not.toHaveBeenCalled();

    submissionState.pending = false;
    view.rerender(
      <TeamRunFormSheet serverId="host-a" team={team} onClose={onClose} onStarted={onStarted} />,
    );
    expect(sheetState.dismissible).toBe(true);
    act(() => sheetState.onClose?.());
    expect(submissionState.cancelCompletion).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
