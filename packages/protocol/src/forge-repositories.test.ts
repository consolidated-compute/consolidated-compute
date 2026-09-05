import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("checkout-independent repository discovery wire contract", () => {
  it("accepts repository and work reads without cwd and keeps existing checkout search", () => {
    const requests = [
      {
        type: "forge.repositories.search.request",
        forge: "github",
        host: "github.com",
        limit: 50,
        requestId: "r1",
      },
      {
        type: "forge.repositories.search_work.request",
        repository: { forge: "github", host: "github.com", id: "R_repo" },
        kind: "issue",
        cursor: "next",
        requestId: "r2",
      },
      { type: "forge.search.request", cwd: "/repo", query: "bug", requestId: "legacy" },
    ];
    expect(requests.map((request) => SessionInboundMessageSchema.parse(request))).toEqual(requests);
  });

  it.each(["forge.repositories.search.response", "forge.repositories.search_work.response"])(
    "compiles %s in the generated client validator",
    (type) => {
      const response = { type, payload: { items: [], nextCursor: null, requestId: "r1" } };
      expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
      expect(validateWSOutboundMessage({ type: "session", message: response }).success).toBe(true);
      expect(
        validateWSOutboundMessage({
          type: "session",
          message: { ...response, payload: { ...response.payload, nextCursor: 12 } },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects oversized pages and URL-shaped hosts at the inbound boundary", () => {
    const request = {
      type: "forge.repositories.search.request",
      forge: "github",
      host: "github.com",
      requestId: "r1",
    };
    expect(SessionInboundMessageSchema.safeParse({ ...request, limit: 51 }).success).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({ ...request, host: "github.com@attacker.test" })
        .success,
    ).toBe(false);
  });
});
