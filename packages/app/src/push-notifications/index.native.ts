import { revokeSubscription, startSubscription } from "./internal/subscriptions";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  if (process.env.EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS === "1") return () => {};
  return startSubscription(input);
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}
