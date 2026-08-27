import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartPushNotificationsInput } from "./internal/types";

const subscriptions = vi.hoisted(() => ({
  revokeSubscription: vi.fn(),
  startSubscription: vi.fn(() => vi.fn()),
}));

vi.mock("./internal/subscriptions", () => subscriptions);

import { startPushNotifications } from "./index.native";

const originalE2eSetting = process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS;
const input: StartPushNotificationsInput = {
  client: {} as StartPushNotificationsInput["client"],
  serverId: "server-1",
};

afterEach(() => {
  vi.clearAllMocks();
  if (originalE2eSetting === undefined) {
    delete process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS;
  } else {
    process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS = originalE2eSetting;
  }
});

describe("startPushNotifications", () => {
  it("skips the unrelated native permission flow in an E2E bundle", () => {
    process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS = "1";

    const cleanup = startPushNotifications(input);

    expect(subscriptions.startSubscription).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });

  it("starts the native subscription outside the E2E bundle", () => {
    delete process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS;

    startPushNotifications(input);

    expect(subscriptions.startSubscription).toHaveBeenCalledWith(input);
  });
});
