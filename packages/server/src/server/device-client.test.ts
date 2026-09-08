import { expect, test } from "vitest";
import { EventEmitter, once } from "node:events";
import { WebSocketServer } from "ws";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import {
  createDaemonChannel,
  generateKeyPair,
  exportPublicKey,
  type Transport,
  type EncryptedChannel,
} from "@getpaseo/relay/e2ee";
import { createEncryptedRelaySocket } from "./websocket/encrypted-relay-socket.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const credential = `cc_device_${"a".repeat(43)}`;

test.each(["direct", "encrypted relay"] as const)(
  "SDK device credential authenticates through %s",
  async (kind) => {
    const host = await createTestPaseoDaemon();
    let relay: WebSocketServer | null = null;
    let client: PaseoClient | null = null;
    const relayHeaders: unknown[] = [];
    const wireFrames: string[] = [];
    const decryptedFrames: string[] = [];
    const handshakeErrors: unknown[] = [];
    try {
      const store = host.daemon.deviceAccess;
      const invitation = store.createLocalInvitation({
        label: "SDK",
        permissions: ["access.manage", "workspace.read"],
      });
      store.enroll({ code: invitation.code, token: credential });
      store.enableDeviceAuthentication({ token: credential });
      let url = `ws://127.0.0.1:${host.port}/ws`;
      let e2ee: { enabled: true; daemonPublicKeyB64: string } | undefined;
      if (kind === "encrypted relay") {
        const keys = generateKeyPair();
        relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await once(relay, "listening");
        const address = relay.address();
        if (typeof address === "string" || address === null)
          throw new Error("Missing relay address");
        url = `ws://127.0.0.1:${address.port}/ws?role=client&serverId=server`;
        e2ee = { enabled: true, daemonPublicKeyB64: exportPublicKey(keys.publicKey) };
        relay.on("connection", (socket, request) => {
          relayHeaders.push({
            authorization: request.headers.authorization,
            protocol: request.headers["sec-websocket-protocol"],
          });
          const transport: Transport = {
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason),
            onmessage: null,
            onclose: null,
            onerror: null,
          };
          const emitter = new EventEmitter();
          const pending: Array<string | ArrayBuffer> = [];
          let attached = false;
          socket.on("message", (raw, isBinary) => {
            const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
            wireFrames.push(buffer.toString());
            transport.onmessage?.({
              data: isBinary ? new Uint8Array(buffer).buffer : buffer.toString(),
              isBinary,
            });
          });
          socket.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
          socket.on("error", (error) => transport.onerror?.(error));
          async function finishHandshake(channel: EncryptedChannel): Promise<void> {
            await host.daemon.attachRelaySocket(
              createEncryptedRelaySocket({
                channel,
                emitter,
                getTransportBufferedAmount: () => socket.bufferedAmount,
                terminateTransport: () => socket.terminate(),
              }),
            );
            attached = true;
            for (const frame of pending) emitter.emit("message", frame);
          }
          void createDaemonChannel(transport, keys, {
            onmessage(data) {
              decryptedFrames.push(typeof data === "string" ? data : "binary");
              if (attached) emitter.emit("message", data);
              else pending.push(data);
            },
            onclose: (code, reason) => emitter.emit("close", code, reason),
            onerror: (error) => handshakeErrors.push(error),
          })
            .then(finishHandshake)
            .catch((error) => {
              handshakeErrors.push(error);
              socket.terminate();
            });
        });
      }
      client = createPaseoClient({
        url,
        deviceCredential: credential,
        e2ee,
        reconnect: { enabled: false },
      });
      await client.connect();
      expect(client.getConnectionState().status).toBe("connected");
      expect(handshakeErrors).toEqual([]);
      expect(wireFrames.join("\n")).not.toContain(credential);
      const expectedHeaders =
        kind === "encrypted relay" ? [{ authorization: undefined, protocol: undefined }] : [];
      expect(relayHeaders).toEqual(expectedHeaders);
      const expectedHellos =
        kind === "encrypted relay"
          ? [expect.objectContaining({ type: "hello", deviceCredential: credential })]
          : [];
      expect(decryptedFrames.map((frame) => JSON.parse(frame))).toEqual(expectedHellos);
    } finally {
      await client?.close();
      if (relay) {
        for (const socket of relay.clients) socket.terminate();
        const server = relay;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await host.close();
    }
  },
);
