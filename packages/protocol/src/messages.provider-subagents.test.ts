import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("provider subagent protocol", () => {
  test("accepts a host-wide activity snapshot request and response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.snapshot.get.request",
        requestId: "snapshot-1",
      }),
    ).toEqual({
      type: "agent.provider_subagents.snapshot.get.request",
      requestId: "snapshot-1",
    });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.snapshot.get.response",
        payload: {
          requestId: "snapshot-1",
          subagents: [
            {
              id: "child-1",
              parentAgentId: "parent-1",
              provider: "codex",
              title: "Review",
              description: "Inspect the diff",
              status: "running",
              createdAt: "2026-08-22T10:00:00.000Z",
              updatedAt: "2026-08-22T10:01:00.000Z",
              toolCallId: "tool-1",
            },
          ],
          error: null,
        },
      }),
    ).toMatchObject({
      payload: {
        requestId: "snapshot-1",
        subagents: [{ id: "child-1", parentAgentId: "parent-1" }],
      },
    });
  });

  test("keeps the snapshot capability compatible across host versions", () => {
    const oldClientServerInfoSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z
        .object({
          providerSubagents: z.boolean().optional(),
        })
        .optional(),
    });
    expect(
      oldClientServerInfoSchema.parse({
        status: "server_info",
        serverId: "new-daemon",
        features: {
          providerSubagents: true,
          providerSubagentActivitySnapshot: true,
        },
      }),
    ).toEqual({
      status: "server_info",
      serverId: "new-daemon",
      features: { providerSubagents: true },
    });

    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "old-daemon",
        features: { providerSubagents: true },
      }).features?.providerSubagentActivitySnapshot,
    ).toBeUndefined();
  });

  test("accepts a scoped timeline request and structured live update", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1", subagentId: "child-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "claude",
          epoch: "epoch-1",
          seq: 4,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Found it." },
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "timeline",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        seq: 4,
      },
    });
  });

  test("accepts a provider child working directory while remaining compatible when absent", () => {
    const descriptor = {
      id: "child-1",
      parentAgentId: "parent-1",
      provider: "opencode",
      title: "Explore",
      description: null,
      status: "running",
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
    };

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagents: [{ ...descriptor, cwd: "/workspace/child" }],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ cwd: "/workspace/child" }] } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-2",
          parentAgentId: "parent-1",
          subagents: [descriptor],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ id: "child-1" }] } });
  });
});
