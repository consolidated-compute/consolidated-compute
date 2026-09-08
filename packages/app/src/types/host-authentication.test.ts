import { expect, test } from "vitest";
import type { HostConnection } from "./host-connection";
import { resolveHostAuthentication } from "./host-authentication";

const connections: HostConnection[] = [
  { id: "tcp", type: "directTcp", endpoint: "localhost:6767", password: "legacy" },
  { id: "ssh", type: "remoteSsh", host: "dev", daemonPassword: "legacy" },
  { id: "socket", type: "directSocket", path: "/tmp/test.sock" },
  { id: "pipe", type: "directPipe", path: "test-pipe" },
  { id: "relay", type: "relay", relayEndpoint: "relay.test:443", daemonPublicKeyB64: "key" },
];

test.each(connections)("uses host device authentication for $type", (connection) => {
  const deviceCredential = `cc_device_${"a".repeat(43)}`;
  expect(resolveHostAuthentication({ deviceCredential }, connection)).toEqual({ deviceCredential });
});

test.each(["", "damaged"])(
  "never falls back for a damaged saved credential (%s)",
  (deviceCredential) => {
    expect(resolveHostAuthentication({ deviceCredential }, connections[0])).toEqual({
      deviceCredential,
    });
  },
);

test("retains legacy password and anonymous authentication for unenrolled hosts", () => {
  expect(connections.map((connection) => resolveHostAuthentication({}, connection))).toEqual([
    { password: "legacy" },
    { password: "legacy" },
    {},
    {},
    {},
  ]);
});
