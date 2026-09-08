import { expect, test } from "vitest";
import { once } from "node:events";
import { Writable } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const token = `cc_device_${"a".repeat(43)}`;
const hello = { type: "hello", clientId: "device-test", clientType: "cli", protocolVersion: 1 };

test("malformed credential hellos never appear in daemon logs", async () => {
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
  const host = await createTestPaseoDaemon({ logger });
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
  try {
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send(`{"type":"hello","deviceCredential":"${token}",`);
    await closed;
    expect(lines.join("\n")).toContain("Failed to parse/handle pending handshake");
    expect(lines.join("\n")).not.toContain(token);
  } finally {
    ws.terminate();
    await host.close();
  }
});

test("activation closes an existing anonymous owner connection", async () => {
  const host = await createTestPaseoDaemon();
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
  try {
    await once(ws, "open");
    const ready = once(ws, "message");
    ws.send(JSON.stringify(hello));
    await ready;
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Laptop",
      permissions: ["access.manage"],
    });
    store.enroll({ code: invitation.code, token });
    const closed = once(ws, "close");
    store.enableDeviceAuthentication({ token });
    expect((await closed)[0]).toBe(4401);
  } finally {
    ws.terminate();
    await host.close();
  }
});

test("device mode does not accept a legacy daemon password for HTTP or unscoped MCP", async () => {
  const host = await createTestPaseoDaemon({
    auth: { password: "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW" },
  });
  try {
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Laptop",
      permissions: ["access.manage", "daemon.read"],
    });
    store.enroll({ code: invitation.code, token });
    store.enableDeviceAuthentication({ token });
    const base = `http://127.0.0.1:${host.port}`;
    const headers = { Authorization: "Bearer correct-password" };
    expect((await fetch(`${base}/api/status`, { headers })).status).toBe(401);
    expect((await fetch(`${base}/mcp/agents`, { headers })).status).toBe(401);
    expect((await fetch(`${base}/api/files/download?token=old-download-token`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect(
      (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
  } finally {
    await host.close();
  }
});

test.each(["direct", "relay"] as const)(
  "%s rejects anonymous hello and closes admitted devices on access changes",
  async (transport) => {
    const host = await createTestPaseoDaemon();
    const sockets: WebSocket[] = [];
    let relay: WebSocketServer | null = null;
    try {
      let port = host.port;
      if (transport === "relay") {
        relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await once(relay, "listening");
        const address = relay.address();
        if (typeof address === "string" || address === null)
          throw new Error("Missing relay address");
        port = address.port;
        relay.on("connection", (socket) => {
          void host.daemon.attachRelaySocket(socket);
        });
      }
      const store = host.daemon.deviceAccess;
      const invitation = store.createLocalInvitation({
        label: "Laptop",
        permissions: ["access.manage", "daemon.read"],
      });
      const admitted = store.enroll({ code: invitation.code, token });
      store.enableDeviceAuthentication({ token });
      const anonymous = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sockets.push(anonymous);
      await once(anonymous, "open");
      const rejected = once(anonymous, "close");
      anonymous.send(JSON.stringify(hello));
      expect((await rejected)[0]).toBe(4401);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sockets.push(ws);
      await once(ws, "open");
      const ready = once(ws, "message");
      ws.send(JSON.stringify({ ...hello, deviceCredential: token }));
      const [frame] = await ready;
      expect(JSON.parse(frame.toString())).toMatchObject({
        type: "session",
        message: {
          type: "status",
          payload: { status: "server_info", permissions: ["access.manage", "daemon.read"] },
        },
      });
      const revoked = once(ws, "close");
      store.setPrincipalPermissions({
        principalId: admitted.principalId,
        permissions: ["workspace.read"],
      });
      expect((await revoked)[0]).toBe(4401);

      const reconnected = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`paseo.bearer.${token}`]);
      sockets.push(reconnected);
      await once(reconnected, "open");
      const resumed = once(reconnected, "message");
      const resumedHello = transport === "direct" ? hello : { ...hello, deviceCredential: token };
      reconnected.send(JSON.stringify(resumedHello));
      expect(JSON.parse((await resumed)[0].toString())).toMatchObject({
        type: "session",
        message: {
          type: "status",
          payload: { status: "server_info", permissions: ["workspace.read"] },
        },
      });
      const closed = once(reconnected, "close");
      store.revokeCredential(admitted.credentialId);
      expect((await closed)[0]).toBe(4401);
    } finally {
      for (const socket of sockets) socket.terminate();
      if (relay) {
        const server = relay;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await host.close();
    }
  },
);

test("activated HTTP requires device grants rather than anonymous or password authority", async () => {
  const host = await createTestPaseoDaemon();
  try {
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Laptop",
      permissions: ["access.manage"],
    });
    const device = store.enroll({ code: invitation.code, token });
    store.enableDeviceAuthentication({ token });
    const url = `http://127.0.0.1:${host.port}/api/status`;
    expect((await fetch(url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(url, { headers })).status).toBe(403);
    store.setPrincipalPermissions({
      principalId: device.principalId,
      permissions: ["daemon.read"],
    });
    expect((await fetch(url, { headers })).status).toBe(200);
    store.revokeCredential(device.credentialId);
    expect((await fetch(url, { headers })).status).toBe(401);
  } finally {
    await host.close();
  }
});
