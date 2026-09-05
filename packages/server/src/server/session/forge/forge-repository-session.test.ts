import { describe, expect, it } from "vitest";
import { ForgeRepositorySession } from "./forge-repository-session.js";
import {
  ForgeRepositoryDiscoveryError,
  type ForgeRepositoryDiscovery,
} from "../../../services/forge-repository-discovery.js";
import type { SessionOutboundMessage } from "../../messages.js";

function fixture(discovery: ForgeRepositoryDiscovery | null) {
  const emitted: Array<{ message: SessionOutboundMessage; source?: object }> = [];
  const session = new ForgeRepositorySession({
    resolve: () => discovery,
    emit: (message, source) => {
      emitted.push({ message, source });
    },
  });
  return { session, emitted };
}

describe("repository discovery session", () => {
  it("correlates both pages to the requesting socket rather than broadcasting to legacy clients", async () => {
    const { session, emitted } = fixture({
      searchRepositories: async () => ({ items: [], nextCursor: "next" }),
      searchWork: async () => ({ items: [], nextCursor: null }),
    });
    const source = {};
    await session.handle(
      {
        type: "forge.repositories.search.request",
        forge: "github",
        host: "github.com",
        requestId: "r1",
      },
      source,
    );
    await session.handle(
      {
        type: "forge.repositories.search_work.request",
        repository: { forge: "github", host: "github.com", id: "R_repo" },
        kind: "issue",
        requestId: "r2",
      },
      source,
    );
    expect(emitted).toEqual([
      {
        message: {
          type: "forge.repositories.search.response",
          payload: { items: [], nextCursor: "next", requestId: "r1" },
        },
        source,
      },
      {
        message: {
          type: "forge.repositories.search_work.response",
          payload: { items: [], nextCursor: null, requestId: "r2" },
        },
        source,
      },
    ]);
  });

  it("returns an explicit unsupported error for adapters without discovery", async () => {
    const { session, emitted } = fixture(null);
    await session.handle({
      type: "forge.repositories.search.request",
      forge: "gitlab",
      host: "gitlab.com",
      requestId: "r1",
    });
    expect(emitted[0].message).toEqual({
      type: "rpc_error",
      payload: {
        requestType: "forge.repositories.search.request",
        requestId: "r1",
        code: "forge_discovery_unsupported",
        error: "Repository discovery is unavailable for gitlab on this host.",
      },
    });
  });

  it("preserves actionable provider errors and request correlation", async () => {
    const { session, emitted } = fixture({
      searchRepositories: async () => {
        throw new ForgeRepositoryDiscoveryError("rate_limited", "Retry later.");
      },
      searchWork: async () => {
        throw new Error("unused");
      },
    });
    await session.handle({
      type: "forge.repositories.search.request",
      forge: "github",
      host: "github.com",
      requestId: "r1",
    });
    expect(emitted[0].message).toEqual({
      type: "rpc_error",
      payload: {
        requestType: "forge.repositories.search.request",
        requestId: "r1",
        code: "forge_discovery_rate_limited",
        error: "Retry later.",
      },
    });
  });
});
