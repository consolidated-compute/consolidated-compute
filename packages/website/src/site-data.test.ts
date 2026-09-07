import { describe, expect, it } from "vitest";
import type { ReleaseChannels } from "./latest-release";
import { loadSiteData } from "./site-data";

const release: ReleaseChannels = {
  stable: {
    version: "0.7.2",
    linuxAppImageAsset: "Paseo.AppImage",
    windowsX64Asset: "Paseo.exe",
    windowsArm64Asset: null,
  },
  beta: null,
};

describe("site data ownership", () => {
  it.each([
    "/docs",
    "/docs/",
    "/docs/github-work",
    "/docs/capabilities",
    "/docs.md",
    "/docs/cli.md",
  ])("renders %s without invoking release or star sources", async (pathname) => {
    const forbiddenSource = async (): Promise<never> => {
      throw new Error("Documentation must not request upstream metadata");
    };
    await expect(
      loadSiteData(pathname, {
        release: forbiddenSource,
        stars: forbiddenSource,
      }),
    ).resolves.toEqual({ kind: "docs" });
  });

  it.each(["/", "/download", "/docstrings", "/docs-other"])(
    "preserves upstream data outside the documentation namespace: %s",
    async (pathname) => {
      const calls: string[] = [];
      await expect(
        loadSiteData(pathname, {
          release: async () => {
            calls.push("release");
            return release;
          },
          stars: async () => {
            calls.push("stars");
            return { stars: "12k" };
          },
        }),
      ).resolves.toEqual({ kind: "upstream", release, stars: "12k" });
      expect(calls).toEqual(["release", "stars"]);
    },
  );

  it("does not mask a marketing source failure", async () => {
    await expect(
      loadSiteData("/download", {
        release: async () => {
          throw new Error("Release unavailable");
        },
        stars: async () => ({ stars: "12k" }),
      }),
    ).rejects.toThrow("Release unavailable");
  });
});
