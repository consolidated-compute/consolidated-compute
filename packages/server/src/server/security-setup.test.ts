import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  completeSecuritySetup,
  completeLocalSecuritySetup,
  issueSecuritySetupCode,
} from "./security-setup.js";
import { isBearerTokenValid } from "./auth.js";
import { loadPersistedConfig, savePersistedConfig } from "./persisted-config.js";

const homes: string[] = [];
function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "security-setup-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("trusted desktop setup can retry without changing an existing password", () => {
  const dir = home();
  completeLocalSecuritySetup(dir, "local-setup-password");
  const saved = loadPersistedConfig(dir);
  completeLocalSecuritySetup(dir, "local-setup-password");
  expect(loadPersistedConfig(dir)).toEqual(saved);
  expect(() => completeLocalSecuritySetup(dir, "another-password")).toThrow("already");
});

test("a local single-use code saves only a password hash and preserves other settings", () => {
  const dir = home();
  savePersistedConfig(dir, { version: 1, daemon: { relay: { enabled: false } } });
  const code = issueSecuritySetupCode(dir, 1000);
  expect(readFileSync(path.join(dir, "security-setup.json"), "utf8")).not.toContain(code);
  completeSecuritySetup({ home: dir, code, password: "a-secure-test-password", now: 2000 });
  const config = loadPersistedConfig(dir);
  expect(config.daemon?.relay?.enabled).toBe(false);
  expect(
    isBearerTokenValid({
      password: config.daemon?.auth?.password,
      token: "a-secure-test-password",
    }),
  ).toBe(true);
  expect(JSON.stringify(config)).not.toContain("a-secure-test-password");
  completeSecuritySetup({ home: dir, code, password: "a-secure-test-password", now: 2001 });
  expect(loadPersistedConfig(dir)).toEqual(config);
  expect(() =>
    completeSecuritySetup({ home: dir, code, password: "another-secure-password", now: 2001 }),
  ).toThrow("already");
  expect(() => issueSecuritySetupCode(dir)).toThrow("already");
});

test("invalid, expired and replaced codes cannot configure the host", () => {
  const dir = home();
  const old = issueSecuritySetupCode(dir, 1000);
  const code = issueSecuritySetupCode(dir, 1001);
  for (const [candidate, now] of [
    ["wrong", 1002],
    [old, 1002],
    [code, 301001],
  ] as const) {
    expect(() =>
      completeSecuritySetup({
        home: dir,
        code: candidate,
        password: "a-secure-test-password",
        now,
      }),
    ).toThrow("invalid or expired");
    expect(loadPersistedConfig(dir).daemon?.auth?.password).toBeUndefined();
  }
});

test("rejects empty, short and bcrypt-truncated passwords without consuming the code", () => {
  const dir = home();
  const code = issueSecuritySetupCode(dir);
  for (const password of ["", "short", "é".repeat(40), " surrounded by spaces "]) {
    expect(() => completeSecuritySetup({ home: dir, code, password })).toThrow();
  }
  completeSecuritySetup({ home: dir, code, password: "a-secure-test-password" });
});
