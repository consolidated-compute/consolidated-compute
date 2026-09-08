import { expect, test } from "vitest";
import { DaemonClient, DeviceCredentialConfigurationError } from "./daemon-client.js";
import type { DaemonTransport, DaemonTransportFactory } from "./daemon-client-transport-types.js";

const credential = `cc_device_${"a".repeat(43)}`;

test.each([
  { extra: { deviceCredential: "invalid" }, code: "invalid_credential" },
  { extra: { password: "password" }, code: "conflicting_authentication" },
  { extra: { authHeader: "Bearer token" }, code: "conflicting_authentication" },
  {
    extra: { url: "wss://relay.invalid/ws?role=client&serverId=server" },
    code: "relay_encryption_required",
  },
  {
    extra: { url: "wss://relay.invalid/ws?role=client&serverId=server", e2ee: { enabled: true } },
    code: "relay_key_required",
  },
])("rejects $code before opening a transport", async ({ extra, code }) => {
  let openings = 0;
  const client = new DaemonClient({
    url: "ws://localhost/ws",
    clientId: "test",
    deviceCredential: credential,
    ...extra,
    transportFactory: () => {
      openings++;
      throw new Error("Unexpected transport creation");
    },
  });
  try {
    await expect(client.connect()).rejects.toBeInstanceOf(DeviceCredentialConfigurationError);
    expect(client.lastError).toContain(code);
    expect(client.lastError).not.toContain(credential);
    expect(openings).toBe(0);
    expect(client.getConnectionState().status).toBe("disconnected");
  } finally {
    await client.close();
  }
});

test.each([
  { advertised: true, outcome: "connected" },
  { advertised: false, outcome: "device_authentication_unavailable" },
  { advertised: undefined, outcome: "device_authentication_unavailable" },
])(
  "requires device authentication acknowledgement ($advertised)",
  async ({ advertised, outcome }) => {
    let open: () => void = () => {};
    let receive: (data: unknown, isBinary: boolean) => void = () => {};
    const options: Parameters<DaemonTransportFactory>[0][] = [];
    const hellos: unknown[] = [];
    const transport: DaemonTransport = {
      send(data) {
        if (typeof data !== "string") throw new Error("Expected hello text");
        hellos.push(JSON.parse(data));
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "server",
                hostname: null,
                version: null,
                features: { deviceAuthentication: advertised },
              },
            },
          }),
          false,
        );
      },
      close() {},
      onOpen(handler) {
        open = handler;
        return () => {};
      },
      onMessage(handler) {
        receive = handler;
        return () => {};
      },
      onClose() {
        return () => {};
      },
      onError() {
        return () => {};
      },
    };
    const client = new DaemonClient({
      url: "ws://localhost/ws",
      clientId: "test",
      deviceCredential: credential,
      reconnect: { enabled: false },
      transportFactory: (input) => {
        options.push(input);
        return transport;
      },
    });
    try {
      const connected = client.connect().then(
        () => "connected",
        (error: unknown) => {
          if (error instanceof DeviceCredentialConfigurationError) return error.code;
          throw error;
        },
      );
      open();
      expect(await connected).toBe(outcome);
      expect(options).toEqual([
        {
          url: "ws://localhost/ws",
          headers: { Authorization: `Bearer ${credential}` },
          protocols: [`paseo.bearer.${credential}`],
        },
      ]);
      expect(hellos).toEqual([
        expect.objectContaining({ type: "hello", deviceCredential: credential }),
      ]);
    } finally {
      await client.close();
    }
  },
);
