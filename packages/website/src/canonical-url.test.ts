import { describe, expect, it } from "vitest";
import { getCanonicalRedirect } from "./canonical-url";

describe("getCanonicalRedirect", () => {
  it.each([
    "/",
    "/download",
    "/download/",
    "/docs",
    "/docs/",
    "/docs/capabilities",
    "/docs/capabilities.md",
    "/docs.md",
  ])("keeps CC pages on their requested origin: %s", (pathname) => {
    expect(
      getCanonicalRedirect(new URL(`https://cc.example${pathname}?source=local`), "production"),
    ).toBeNull();
  });

  it("does not redirect development requests addressed through the local network", () => {
    const url = new URL("http://192.168.1.71:8082/inspector/device");

    expect(getCanonicalRedirect(url, "development")).toBeNull();
  });

  it("redirects production requests to the canonical origin", () => {
    const url = new URL("http://www.paseo.sh/agents");

    expect(getCanonicalRedirect(url, "production")).toBe("https://paseo.sh/agents");
  });
});
