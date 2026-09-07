import { describe, expect, it } from "vitest";
import { ccPageMeta, docsPageMeta, docsSourceUrl } from "./site-identity";

describe("CC site identity", () => {
  it("keeps the homepage title separate from the docs suffix", () => {
    expect(
      ccPageMeta("Consolidated Compute — A harness for your harness", "Operate agent teams."),
    ).toEqual({
      meta: [
        { title: "Consolidated Compute — A harness for your harness" },
        { name: "description", content: "Operate agent teams." },
        { property: "og:title", content: "Consolidated Compute — A harness for your harness" },
        { property: "og:description", content: "Operate agent teams." },
        { name: "twitter:title", content: "Consolidated Compute — A harness for your harness" },
        { name: "twitter:description", content: "Operate agent teams." },
      ],
    });
  });
  it.each(["public-docs/index.md", "public-docs/capabilities.md", "public-docs/hub/security.md"])(
    "links %s to the fork that owns its contents",
    (sourcePath) => {
      expect(docsSourceUrl(sourcePath)).toBe(
        `https://github.com/consolidated-compute/consolidated-compute/blob/main/${sourcePath}`,
      );
    },
  );

  it("uses CC page metadata without an invented public origin or upstream social image", () => {
    expect(docsPageMeta("Capabilities and evidence", "Provider and platform proof.")).toEqual({
      meta: [
        { title: "Capabilities and evidence - Consolidated Compute Docs" },
        { name: "description", content: "Provider and platform proof." },
        { property: "og:title", content: "Capabilities and evidence - Consolidated Compute Docs" },
        { property: "og:description", content: "Provider and platform proof." },
        { name: "twitter:title", content: "Capabilities and evidence - Consolidated Compute Docs" },
        { name: "twitter:description", content: "Provider and platform proof." },
      ],
    });
  });
});
