import type { Page } from "@playwright/test";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { wsRoutePatternForPort } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface SessionMessage {
  type?: unknown;
  requestId?: unknown;
}

export interface OperationsHostFixture {
  failAgentDirectoryRequests(): void;
  restoreAgentDirectoryRequests(): void;
  providerSnapshotRequestCount(): number;
}

function readSessionMessage(message: WebSocketMessage): SessionMessage | null {
  try {
    const envelope = JSON.parse(
      typeof message === "string" ? message : message.toString("utf8"),
    ) as { type?: unknown; message?: SessionMessage };
    return envelope.type === "session" ? (envelope.message ?? null) : null;
  } catch {
    return null;
  }
}

function withProviderSubagentActivityFeature(
  message: WebSocketMessage,
  supported: boolean | undefined,
): WebSocketMessage {
  if (supported === undefined || typeof message !== "string") return message;
  try {
    const envelope = JSON.parse(message) as {
      type?: unknown;
      message?: {
        type?: unknown;
        payload?: { status?: unknown; features?: Record<string, unknown> };
      };
    };
    const payload = envelope.message?.payload;
    if (
      envelope.type !== "session" ||
      envelope.message?.type !== "status" ||
      payload?.status !== "server_info"
    ) {
      return message;
    }
    return JSON.stringify({
      ...envelope,
      message: {
        ...envelope.message,
        payload: {
          ...payload,
          features: {
            ...payload.features,
            providerSubagentActivitySnapshot: supported,
          },
        },
      },
    });
  } catch {
    return message;
  }
}

export async function installOperationsHostFixture(
  page: Page,
  input: {
    port: string | number;
    providerSubagents: ProviderSubagentDescriptorPayload[];
    providerSubagentActivitySupported?: boolean;
  },
): Promise<OperationsHostFixture> {
  let failAgentDirectories = false;
  let providerSnapshotRequests = 0;

  await page.routeWebSocket(wsRoutePatternForPort(String(input.port)), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = readSessionMessage(message);
      if (
        request?.type === "agent.provider_subagents.snapshot.get.request" &&
        typeof request.requestId === "string"
      ) {
        providerSnapshotRequests += 1;
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "agent.provider_subagents.snapshot.get.response",
              payload: {
                requestId: request.requestId,
                subagents: input.providerSubagents,
                error: null,
              },
            },
          }),
        );
        return;
      }
      if (
        failAgentDirectories &&
        request?.type === "fetch_agents_request" &&
        typeof request.requestId === "string"
      ) {
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Synthetic Operations agent directory failure",
                code: "fetch_agents_failed",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });

    server.onMessage((message) =>
      ws.send(
        withProviderSubagentActivityFeature(message, input.providerSubagentActivitySupported),
      ),
    );
  });

  return {
    failAgentDirectoryRequests() {
      failAgentDirectories = true;
    },
    restoreAgentDirectoryRequests() {
      failAgentDirectories = false;
    },
    providerSnapshotRequestCount() {
      return providerSnapshotRequests;
    },
  };
}
