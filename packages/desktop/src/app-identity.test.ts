import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_DISPLAY_NAME,
  COMPATIBILITY_USER_DATA_DIRECTORY,
  resolveCompatibilityUserDataPath,
} from "./app-identity";

describe("desktop app identity", () => {
  it("uses the fork display name while preserving the existing user-data directory", () => {
    expect(APP_DISPLAY_NAME).toBe("Consolidated Compute");
    expect(COMPATIBILITY_USER_DATA_DIRECTORY).toBe("Paseo");
    expect(resolveCompatibilityUserDataPath(path.join("tmp", "application-data"))).toBe(
      path.join("tmp", "application-data", "Paseo"),
    );
  });
});
