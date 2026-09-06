import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  ForgeRepositorySearchInput,
  ForgeRepositoryWorkSearchInput,
} from "@getpaseo/protocol/forge-repositories";
import { repositoryQueryOptions, workQueryOptions } from "./queries";

describe("GitHub Work queries", () => {
  it("requests bounded provider pages without requiring a Workspace and isolates each host cache", async () => {
    const calls: ForgeRepositorySearchInput[] = [];
    const client = {
      async searchForgeRepositories(input: ForgeRepositorySearchInput) {
        calls.push(input);
        return { requestId: "test", items: [], nextCursor: input.cursor ? null : "second-page" };
      },
      async searchForgeRepositoryWork() {
        return { requestId: "unused", items: [], nextCursor: null };
      },
    };
    const cache = new QueryClient();
    try {
      const laptop = repositoryQueryOptions({
        client,
        serverId: "laptop",
        site: "github.com",
        query: "org:example",
        enabled: true,
      });
      await cache.fetchInfiniteQuery({ ...laptop, pages: 2 });
      expect(calls).toEqual([
        { forge: "github", host: "github.com", query: "org:example", limit: 25 },
        {
          forge: "github",
          host: "github.com",
          query: "org:example",
          limit: 25,
          cursor: "second-page",
        },
      ]);
      const desktop = repositoryQueryOptions({
        client,
        serverId: "desktop",
        site: "github.com",
        query: "org:example",
        enabled: true,
      });
      expect(cache.getQueryData(desktop.queryKey)).toBeUndefined();
      const enterprise = repositoryQueryOptions({
        client,
        serverId: "laptop",
        site: "github.example.com",
        query: "org:example",
        enabled: true,
      });
      expect(cache.getQueryData(enterprise.queryKey)).toBeUndefined();
    } finally {
      cache.clear();
    }
  });

  it("scopes work discovery to the selected stable repository, kind and state", async () => {
    const calls: ForgeRepositoryWorkSearchInput[] = [];
    const client = {
      async searchForgeRepositories() {
        return { requestId: "unused", items: [], nextCursor: null };
      },
      async searchForgeRepositoryWork(input: ForgeRepositoryWorkSearchInput) {
        calls.push(input);
        return { requestId: "test", items: [], nextCursor: null };
      },
    };
    const cache = new QueryClient();
    const repository = { forge: "github", host: "github.com", id: "R_1" };
    try {
      const options = workQueryOptions({
        client,
        serverId: "laptop",
        repository,
        kind: "change_request",
        state: "closed",
        query: "label:bug",
        enabled: true,
      });
      await cache.fetchInfiniteQuery(options);
      expect(calls).toEqual([
        { repository, kind: "change_request", state: "closed", query: "label:bug", limit: 25 },
      ]);
      expect(
        workQueryOptions({
          client,
          serverId: "laptop",
          repository: null,
          kind: "issue",
          state: "open",
          query: "",
          enabled: true,
        }).enabled,
      ).toBe(false);
      expect(
        workQueryOptions({
          client,
          serverId: "laptop",
          repository,
          kind: "issue",
          state: "open",
          query: "",
          enabled: false,
        }).enabled,
      ).toBe(false);
    } finally {
      cache.clear();
    }
  });
});
