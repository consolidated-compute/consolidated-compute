import { describe, expect, test } from "vitest";
import { normalizeHubRelationshipStatus } from "./normalize-hub-relationship.js";

describe("normalizeHubRelationshipStatus", () => {
  const base = {
    state: "connected" as const,
    daemonId: "daemon-1",
    hubOrigin: "https://hub.example",
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastError: null,
  };

  test("maps the legacy execution scope from an older daemon", () => {
    expect(normalizeHubRelationshipStatus({ ...base, scopes: ["hub.execution.*"] })).toMatchObject({
      permissions: ["hub.execute"],
    });
  });

  test("preserves semantic permissions from a current daemon", () => {
    expect(
      normalizeHubRelationshipStatus({
        ...base,
        scopes: [],
        permissions: ["workspace.read"],
      }),
    ).toMatchObject({ permissions: ["workspace.read"] });
  });
});
