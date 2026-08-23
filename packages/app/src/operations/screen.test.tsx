/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { focusState, useOperationsData } = vi.hoisted(() => ({
  focusState: { current: false },
  useOperationsData: vi.fn(() => ({
    hosts: [],
    projects: [],
    summary: { working: 0, attention: 0, idle: 0 },
    agentCount: 0,
    liveAgentCount: 0,
    isInitialLoading: false,
    isRevalidating: false,
    hasPartialData: false,
    refreshAll: vi.fn(async () => undefined),
  })),
}));

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => focusState.current,
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  ScrollView: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

vi.mock("lucide-react-native", () => ({
  RefreshCw: () => React.createElement("span"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ rightContent }: { rightContent?: React.ReactNode }) =>
    React.createElement("div", null, rightContent),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ testID }: { testID?: string }) => React.createElement("div", { "data-testid": testID }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span"),
}));

vi.mock("./rows", () => ({
  OperationsProjectRows: () => React.createElement("div"),
}));

vi.mock("./use-operations-data", () => ({ useOperationsData }));

import { OperationsScreen } from "./screen";

describe("OperationsScreen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("React", React);
    focusState.current = false;
    useOperationsData.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => root.render(<OperationsScreen />));
  }

  it("mounts the data tree only while the Operations route is focused", () => {
    render();
    expect(useOperationsData).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="operations-screen"]')).toBeNull();

    focusState.current = true;
    render();
    expect(useOperationsData).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="operations-screen"]')).not.toBeNull();

    focusState.current = false;
    render();
    expect(useOperationsData).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="operations-screen"]')).toBeNull();

    focusState.current = true;
    render();
    expect(useOperationsData).toHaveBeenCalledTimes(2);
  });
});
