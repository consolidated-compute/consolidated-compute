import { describe, expect, it } from "vitest";
import {
  INITIAL_BROWSER_STATE,
  normalizeGitHubSite,
  reduceBrowserState,
  type BrowserState,
} from "./browser-state";

const selected: BrowserState = {
  ...INITIAL_BROWSER_STATE,
  host: { serverId: "laptop", label: "My laptop" },
  site: "github.example.com",
  repositoryQuery: "private",
  repository: {
    id: "R_1",
    forge: "github",
    host: "github.example.com",
    fullName: "org/private",
    url: "https://github.example.com/org/private",
    cloneUrl: "https://github.example.com/org/private",
    visibility: "private",
    archived: false,
    updatedAt: "2026-09-05",
  },
  workQuery: "label:bug",
  kind: "change_request",
  workState: "closed",
  selection: {
    kind: "preview",
    item: {
      id: "I_1",
      repository: { forge: "github", host: "github.example.com", id: "R_1" },
      kind: "issue",
      number: 1,
      title: "Fix",
      url: "https://github.example.com/org/private/issues/1",
      state: "open",
      body: "Do not persist",
      bodyTruncated: false,
      labels: [],
      updatedAt: "2026-09-05",
    },
  },
};

describe("GitHub Work browsing scope", () => {
  it("keeps applied filters when reselecting the current host or repository", () => {
    expect(
      reduceBrowserState(selected, {
        type: "host",
        host: { serverId: "laptop", label: "Renamed laptop" },
      }),
    ).toEqual({ ...selected, host: { serverId: "laptop", label: "Renamed laptop" } });
    expect(
      reduceBrowserState(selected, { type: "repository", repository: selected.repository }),
    ).toEqual(selected);
  });
  it("drops every repository, query, and selected item when the daemon host changes", () => {
    expect(
      reduceBrowserState(selected, {
        type: "host",
        host: { serverId: "desktop", label: "Desktop" },
      }),
    ).toEqual({ ...INITIAL_BROWSER_STATE, host: { serverId: "desktop", label: "Desktop" } });
  });
  it("drops downstream selection when the GitHub hostname or repository changes", () => {
    const changed = reduceBrowserState(selected, {
      type: "repository-search",
      site: " GITHUB.COM ",
      query: " new ",
    });
    expect(changed).toMatchObject({
      site: "github.com",
      repositoryQuery: "new",
      repository: null,
      workQuery: "",
      selection: null,
    });
    expect(reduceBrowserState(selected, { type: "repository", repository: null })).toMatchObject({
      repository: null,
      workQuery: "",
      selection: null,
    });
  });
  it("rejects URL and path inputs without changing the applied catalog", () => {
    expect(normalizeGitHubSite("https://github.com/path")).toBeNull();
    expect(
      reduceBrowserState(selected, { type: "repository-search", site: "bad/host", query: "query" }),
    ).toBe(selected);
  });
  it("retains the selected snapshot when opening creation, and clears it when filters change", () => {
    expect(reduceBrowserState(selected, { type: "create" }).selection).toEqual({
      ...selected.selection,
      kind: "create",
    });
    expect(reduceBrowserState(selected, { type: "kind", kind: "issue" }).selection).toBeNull();
    expect(
      reduceBrowserState(selected, { type: "work-search", query: "new" }).selection,
    ).toBeNull();
  });
});
