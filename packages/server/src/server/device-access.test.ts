import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DeviceAccessStore,
  DeviceAccessError,
  type DeviceAccessErrorCode,
} from "./device-access.js";

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
test("access notifications follow durable authority changes and can be detached", () => {
  const { store } = fixture();
  const observations: Array<string[] | null> = [];
  const unsubscribe = store.onAccessChanged(() => {
    observations.push(store.authenticate(token)?.permissions ?? null);
  });
  const invitation = store.createLocalInvitation({
    label: "Laptop",
    permissions: ["access.manage"],
  });
  const admitted = store.enroll({ code: invitation.code, token });
  expect(observations).toEqual([]);
  store.enableDeviceAuthentication({ token });
  store.setPrincipalPermissions({
    principalId: admitted.principalId,
    permissions: ["workspace.read"],
  });
  store.revokeCredential(admitted.credentialId);
  expect(observations).toEqual([["access.manage"], ["workspace.read"], null]);
  unsubscribe();
  store.revokePrincipal(admitted.principalId);
  expect(observations).toHaveLength(3);
});
test("authentication activation is explicit and survives a reopened store", () => {
  const { home, store } = fixture();
  expect(store.isDeviceAuthenticationEnabled()).toBe(false);
  const invitation = store.createLocalInvitation({
    label: "Owner",
    permissions: ["access.manage"],
  });
  const admitted = store.enroll({ code: invitation.code, token });
  expect(store.isDeviceAuthenticationEnabled()).toBe(false);
  store.enableDeviceAuthentication({ token });
  const activated = readFileSync(path.join(home, "device-authentication.json"), "utf8");
  store.enableDeviceAuthentication({ token });
  expect(readFileSync(path.join(home, "device-authentication.json"), "utf8")).toBe(activated);
  expect(activated).not.toContain(token);
  const reopened = new DeviceAccessStore({ home });
  expect(reopened.isDeviceAuthenticationEnabled()).toBe(true);
  expect(reopened.authenticate(token)).toEqual(admitted);
});

test("activation requires an enrolled, non-revoked access-management credential", () => {
  const { store } = fixture();
  expectFailure(
    () => store.enableDeviceAuthentication({ token }),
    "activation_credential_required",
  );
  const invitation = store.createLocalInvitation({
    label: "Viewer",
    permissions: ["workspace.read"],
  });
  const admitted = store.enroll({ code: invitation.code, token });
  expectFailure(
    () => store.enableDeviceAuthentication({ token }),
    "activation_credential_required",
  );
  store.setPrincipalPermissions({
    principalId: admitted.principalId,
    permissions: ["access.manage"],
  });
  store.revokeCredential(admitted.credentialId);
  expectFailure(
    () => store.enableDeviceAuthentication({ token }),
    "activation_credential_required",
  );
  expect(store.isDeviceAuthenticationEnabled()).toBe(false);
});

test("loss of the activated credential registry never restores anonymous mode or creates an empty registry", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Owner",
    permissions: ["access.manage"],
  });
  store.enroll({ code: invitation.code, token });
  store.enableDeviceAuthentication({ token });
  rmSync(path.join(home, "device-access.json"));
  const reopened = new DeviceAccessStore({ home });
  expect(reopened.isDeviceAuthenticationEnabled()).toBe(true);
  expectFailure(() => reopened.authenticate(null), "credential_storage_missing");
  expectFailure(() => reopened.authenticate(token), "credential_storage_missing");
  expectFailure(
    () => reopened.createLocalInvitation({ label: "Replacement", permissions: [] }),
    "credential_storage_missing",
  );
  expectFailure(
    () => reopened.enroll({ code: invitation.code, token }),
    "credential_storage_missing",
  );
});

test("corrupt activation records fail closed and cannot be overwritten by activation", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Owner",
    permissions: ["access.manage"],
  });
  store.enroll({ code: invitation.code, token });
  const file = path.join(home, "device-authentication.json");
  for (const contents of ["not json", '{"enabled":false}', '{"enabled":true,"enabledAt":-1}']) {
    writeFileSync(file, contents);
    expectFailure(() => store.isDeviceAuthenticationEnabled(), "authentication_state_invalid");
    expectFailure(
      () => store.enableDeviceAuthentication({ token }),
      "authentication_state_invalid",
    );
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("revoking the last enrolled credential does not disable device authentication", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Owner",
    permissions: ["access.manage"],
  });
  const admitted = store.enroll({ code: invitation.code, token });
  store.enableDeviceAuthentication({ token });
  store.revokePrincipal(admitted.principalId);
  const reopened = new DeviceAccessStore({ home });
  expect(reopened.isDeviceAuthenticationEnabled()).toBe(true);
  expect(reopened.authenticate(token)).toBeNull();
  expect(reopened.authenticate(null)).toBeNull();
});

test("unreadable activation state is not treated as an absent opt-in", () => {
  const { home, store } = fixture();
  mkdirSync(path.join(home, "device-authentication.json"));
  expectFailure(() => store.isDeviceAuthenticationEnabled(), "authentication_state_unreadable");
  expectFailure(
    () => store.enableDeviceAuthentication({ token }),
    "authentication_state_unreadable",
  );
});

test("corrupt credential storage preserves activation and blocks enrollment", () => {
  const { home, store } = fixture();
  const invitation = store.createLocalInvitation({
    label: "Owner",
    permissions: ["access.manage"],
  });
  store.enroll({ code: invitation.code, token });
  store.enableDeviceAuthentication({ token });
  const file = path.join(home, "device-access.json");
  writeFileSync(file, "invalid json");
  const reopened = new DeviceAccessStore({ home });
  expect(reopened.isDeviceAuthenticationEnabled()).toBe(true);
  expect(() => reopened.authenticate(token)).toThrow("Invalid device access storage");
  expect(() => reopened.createLocalInvitation({ label: "Replacement", permissions: [] })).toThrow(
    "Invalid device access storage",
  );
  expect(readFileSync(file, "utf8")).toBe("invalid json");
});

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function expectFailure(action: () => unknown, code: DeviceAccessErrorCode) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DeviceAccessError);
  expect(failure).toMatchObject({ code });
}

test("enrollment failures expose stable codes without consuming or reviving credentials", () => {
  const { store, advance } = fixture();
  const first = store.createLocalInvitation({ label: "Laptop", permissions: ["workspace.read"] });
  expectFailure(() => store.enroll({ code: first.code, token: "short" }), "credential_invalid");
  expectFailure(() => store.enroll({ code: "unknown", token }), "invitation_invalid");
  const admitted = store.enroll({ code: first.code, token });
  expectFailure(() => store.enroll({ code: first.code, token: otherToken }), "invitation_consumed");
  const second = store.createLocalInvitation({ label: "Phone", permissions: [] });
  expectFailure(() => store.enroll({ code: second.code, token }), "credential_already_enrolled");
  store.revokeCredential(admitted.credentialId);
  expectFailure(() => store.enroll({ code: first.code, token }), "credential_revoked");
  advance(300_000);
  expectFailure(() => store.enroll({ code: second.code, token: otherToken }), "invitation_expired");
  expect(store.authenticate(token)).toBeNull();
  expect(store.authenticate(otherToken)).toBeNull();
});

test("management failures expose stable not-found and invitation-limit codes", () => {
  const { store } = fixture();
  expectFailure(() => store.revokeCredential("missing"), "credential_not_found");
  expectFailure(() => store.revokePrincipal("missing"), "principal_not_found");
  expectFailure(
    () => store.setPrincipalPermissions({ principalId: "missing", permissions: [] }),
    "principal_not_found",
  );
  for (let index = 0; index < 100; index++) {
    store.createLocalInvitation({ label: "Laptop", permissions: [] });
  }
  expectFailure(
    () => store.createLocalInvitation({ label: "Phone", permissions: [] }),
    "invitation_limit_reached",
  );
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
