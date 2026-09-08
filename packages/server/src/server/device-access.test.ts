import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeviceAccessStore } from "./device-access.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "cc-device-access-"));
  homes.push(home);
  let now = 1000;
  return {
    home,
    store: new DeviceAccessStore({ home, now: () => now }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const token = `cc_device_${"a".repeat(43)}`;
const otherToken = `cc_device_${"b".repeat(43)}`;
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("local approval creates a distinct principal and credential without storing secrets", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read"],
  });
  expect(store.authenticate(token)).toBeNull();
  const admitted = store.enroll({ code: invitation.code, token: token });
  expect(admitted.permissions).toEqual(["workspace.read"]);
  expect(admitted.principalId).not.toBe(admitted.credentialId);
  expect(store.authenticate(token)).toEqual(admitted);
  expect(new DeviceAccessStore({ home }).authenticate(token)).toEqual(admitted);
  const disk = readFileSync(path.join(home, "device-access.json"), "utf8");
  expect(disk).not.toContain(token);
  expect(disk).not.toContain(invitation.code);
});

test("enrollment retries are idempotent but an invitation cannot enroll a second device", () => {
  const { store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read"],
  });
  const admitted = store.enroll({ code: invitation.code, token: token });
  expect(store.enroll({ code: invitation.code, token: token })).toEqual(admitted);
  expect(() => store.enroll({ code: invitation.code, token: otherToken })).toThrow("consumed");
  expect(store.authenticate(otherToken)).toBeNull();
});

test("expiry and invalid credentials fail without consuming a valid invitation", () => {
  const { store, advance } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read"],
  });
  expect(() => store.enroll({ code: invitation.code, token: "short-secret" })).toThrow();
  expect(store.enroll({ code: invitation.code, token: token }).permissions).toEqual([
    "workspace.read",
  ]);
  const expired = store.createLocalInvitation({ label: "Phone", permissions: ["workspace.read"] });
  advance(300_000);
  expect(() => store.enroll({ code: expired.code, token: otherToken })).toThrow("expired");
  expect(store.authenticate(otherToken)).toBeNull();
});

test("different devices remain independent and a credential cannot be reused across principals", () => {
  const { store } = fixture();
  const first = store.createLocalInvitation({ label: "Laptop", permissions: ["workspace.read"] });
  const second = store.createLocalInvitation({ label: "Phone", permissions: ["daemon.read"] });
  const laptop = store.enroll({ code: first.code, token: token });
  expect(() => store.enroll({ code: second.code, token: token })).toThrow("already enrolled");
  const phone = store.enroll({ code: second.code, token: otherToken });
  expect(phone.principalId).not.toBe(laptop.principalId);
  store.revokePrincipal(laptop.principalId);
  expect(store.authenticate(token)).toBeNull();
  expect(store.authenticate(otherToken)).toEqual(phone);
});

test("a persisted credential pointing to a missing principal is rejected as corrupt", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read"],
  });
  store.enroll({ code: invitation.code, token: token });
  const file = path.join(home, "device-access.json");
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...record, principals: [] }));
  expect(() => store.authenticate(token)).toThrow("device access storage");
});

test("revocation survives restart and never revives through enrollment retries", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read"],
  });
  const admitted = store.enroll({ code: invitation.code, token: token });
  store.revokeCredential(admitted.credentialId);
  expect(new DeviceAccessStore({ home }).authenticate(token)).toBeNull();
  expect(() => store.enroll({ code: invitation.code, token: token })).toThrow("revoked");
});

test("current principal grants control future authentication and returned grants cannot mutate storage", () => {
  const { store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["workspace.read", "workspace.write"],
  });
  const admitted = store.enroll({ code: invitation.code, token: token });
  admitted.permissions.push("access.manage");
  expect(store.authenticate(token)?.permissions).toEqual(["workspace.read", "workspace.write"]);
  store.setPrincipalPermissions({
    principalId: admitted.principalId,
    permissions: ["workspace.read"],
  });
  expect(store.authenticate(token)?.permissions).toEqual(["workspace.read"]);
  store.revokePrincipal(admitted.principalId);
  expect(store.authenticate(token)).toBeNull();
});

test("corrupt storage fails closed and is never overwritten as an empty registry", () => {
  const { home, store } = fixture();
  const file = path.join(home, "device-access.json");
  writeFileSync(file, "invalid json");
  expect(() => store.authenticate(token)).toThrow("device access storage");
  expect(() => store.createLocalInvitation({ label: "Laptop", permissions: [] })).toThrow(
    "device access storage",
  );
  expect(readFileSync(file, "utf8")).toBe("invalid json");
});
