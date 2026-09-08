import { expect, test } from "vitest";
import { WSHelloMessageSchema } from "./messages.js";

const hello = { type: "hello", clientId: "client", clientType: "cli", protocolVersion: 1 };

test("device enrollment keeps legacy hellos readable and bounds new credentials", () => {
  expect(WSHelloMessageSchema.parse(hello)).toEqual(hello);
  const deviceCredential = `cc_device_${"a".repeat(43)}`;
  expect(WSHelloMessageSchema.parse({ ...hello, deviceCredential })).toEqual({
    ...hello,
    deviceCredential,
  });
  expect(
    WSHelloMessageSchema.safeParse({ ...hello, deviceCredential: "a".repeat(129) }).success,
  ).toBe(false);
});
