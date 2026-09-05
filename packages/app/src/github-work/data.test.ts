import { describe, expect, it } from "vitest";
import { repositoryWorkToAssignmentReference, type RepositoryWorkItem } from "./data";

const item: RepositoryWorkItem = {
  repository: { forge: "github", host: "github.com", id: "R_123" },
  id: "I_123",
  kind: "issue",
  number: 132,
  title: "Browse GitHub work",
  url: "https://github.com/example/project/issues/132",
  state: "OPEN",
  body: "External body must not become execution instructions",
  bodyTruncated: true,
  labels: ["feature"],
  updatedAt: "2026-09-05T00:00:00Z",
};

describe("GitHub Work Assignment references", () => {
  it("bounds display titles and rejects incompatible identity or URLs before offering Save", () => {
    expect(repositoryWorkToAssignmentReference({ ...item, title: "x".repeat(600) })?.title).toBe(
      "x".repeat(512),
    );
    expect(
      repositoryWorkToAssignmentReference({ ...item, url: "mailto:operator@example.com" }),
    ).toBeNull();
    expect(repositoryWorkToAssignmentReference({ ...item, id: "x".repeat(2048) })).toBeNull();
  });
  it("copies only bounded reference metadata, qualified by the forge host", () => {
    expect(repositoryWorkToAssignmentReference(item)).toEqual({
      sourceId: "github",
      sourceLabel: "GitHub",
      resourceType: "issue",
      resourceId: "github.com:R_123:I_123",
      identifier: "#132",
      title: "Browse GitHub work",
      url: item.url,
    });
  });
});
