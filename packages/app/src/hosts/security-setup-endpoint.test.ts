import { expect, test } from "vitest";
import { securitySetupUrl } from "./security-setup-endpoint";

test("password setup requires HTTPS or a direct loopback endpoint", () => {
  const connection = {
    id: "direct",
    type: "directTcp" as const,
    endpoint: "localhost:6767",
    useTls: false,
  };
  expect(securitySetupUrl(connection)).toBe("http://localhost:6767/api/security/setup");
  expect(securitySetupUrl({ ...connection, endpoint: "[::1]:6767" })).toBe(
    "http://[::1]:6767/api/security/setup",
  );
  expect(securitySetupUrl({ ...connection, endpoint: "host.example", useTls: true })).toBe(
    "https://host.example/api/security/setup",
  );
  for (const endpoint of [
    "192.168.1.10:6767",
    "localhost.evil.example:6767",
    "user@localhost:6767",
    "localhost:6767/path",
    "localhost:6767?redirect=1",
  ]) {
    expect(() => securitySetupUrl({ ...connection, endpoint })).toThrow();
  }
});
