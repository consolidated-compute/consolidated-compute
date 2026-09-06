import { ForgeRepositoryHostSchema } from "@getpaseo/protocol/forge-repositories";
import type { AssignmentFormHostOption } from "@/assignments/form-model";
import type { Repository, RepositoryWorkItem } from "./data";

export interface BrowserState {
  host: AssignmentFormHostOption | null;
  site: string;
  repositoryQuery: string;
  repository: Repository | null;
  workQuery: string;
  kind: RepositoryWorkItem["kind"];
  workState: "open" | "closed" | "all";
  selection: { kind: "preview" | "create"; item: RepositoryWorkItem } | null;
}

export const INITIAL_BROWSER_STATE: BrowserState = {
  host: null,
  site: "github.com",
  repositoryQuery: "",
  repository: null,
  workQuery: "",
  kind: "issue",
  workState: "open",
  selection: null,
};

export type BrowserAction =
  | { type: "host"; host: AssignmentFormHostOption }
  | { type: "repository-search"; site: string; query: string }
  | { type: "repository"; repository: Repository | null }
  | { type: "work-search"; query: string }
  | { type: "kind"; kind: BrowserState["kind"] }
  | { type: "work-state"; workState: BrowserState["workState"] }
  | { type: "preview"; item: RepositoryWorkItem }
  | { type: "create" }
  | { type: "close" };

export function normalizeGitHubSite(site: string): string | null {
  const normalized = site.trim().toLowerCase();
  return ForgeRepositoryHostSchema.safeParse(normalized).success ? normalized : null;
}

export function reduceBrowserState(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case "host":
      if (state.host?.serverId === action.host.serverId) return { ...state, host: action.host };
      return { ...INITIAL_BROWSER_STATE, host: action.host };
    case "repository-search": {
      const site = normalizeGitHubSite(action.site);
      if (!site) return state;
      return {
        ...state,
        site,
        repositoryQuery: action.query.trim(),
        repository: null,
        selection: null,
        workQuery: "",
      };
    }
    case "repository":
      if (
        state.repository &&
        action.repository &&
        state.repository.id === action.repository.id &&
        state.repository.host === action.repository.host
      )
        return { ...state, repository: action.repository };
      return { ...state, repository: action.repository, workQuery: "", selection: null };
    case "work-search":
      return { ...state, workQuery: action.query.trim(), selection: null };
    case "kind":
      return { ...state, kind: action.kind, selection: null };
    case "work-state":
      return { ...state, workState: action.workState, selection: null };
    case "preview":
      return { ...state, selection: { kind: "preview", item: action.item } };
    case "create":
      return state.selection
        ? { ...state, selection: { ...state.selection, kind: "create" } }
        : state;
    case "close":
      return { ...state, selection: null };
  }
}
