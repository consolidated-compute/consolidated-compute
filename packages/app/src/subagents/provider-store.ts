import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

type ProviderSubagentTimelineItem = Extract<
  Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>["payload"],
  { kind: "timeline" }
>["item"];

interface ProviderSubagentTimelineRow {
  provider: ProviderSubagentDescriptorPayload["provider"];
  item: ProviderSubagentTimelineItem;
  timestamp: string;
}

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  hasOlder: boolean;
  rows: Map<number, ProviderSubagentTimelineRow>;
}

export type ProviderSubagentActivityState =
  | { kind: "loading"; hasSnapshot: boolean }
  | { kind: "ready" }
  | { kind: "unsupported" }
  | { kind: "error"; hasSnapshot: boolean; error: string };

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  activityByServer: Map<string, ProviderSubagentActivityState>;
  activityGenerationByServer: Map<string, number>;
  beginActivitySnapshot(serverId: string): number;
  replaceActivitySnapshot(
    serverId: string,
    generation: number,
    subagents: ProviderSubagentDescriptorPayload[],
  ): void;
  failActivitySnapshot(serverId: string, generation: number, error: string): void;
  markActivityUnsupported(serverId: string): void;
  hideFromTrack(serverId: string, parentAgentId: string, subagentIds: readonly string[]): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
  ): void;
  applyUpdate(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.update" }
    >["payload"],
  ): void;
  replaceTimeline(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.timeline.get.response" }
    >["payload"],
  ): void;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

type ProviderSubagentListClient = Pick<DaemonClient, "listProviderSubagents">;
type ProviderSubagentActivityClient = Pick<DaemonClient, "listProviderSubagentActivity">;

const pendingListRequests = new WeakMap<ProviderSubagentListClient, Map<string, Promise<void>>>();
const pendingActivityRequests = new WeakMap<
  ProviderSubagentActivityClient,
  Map<string, Promise<void>>
>();

export function refreshProviderSubagentActivity(
  client: ProviderSubagentActivityClient,
  serverId: string,
): Promise<void> {
  let clientRequests = pendingActivityRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingActivityRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(serverId);
  if (pending) return pending;

  const generation = useProviderSubagentStore.getState().beginActivitySnapshot(serverId);
  const request = client
    .listProviderSubagentActivity()
    .then((payload) => {
      useProviderSubagentStore
        .getState()
        .replaceActivitySnapshot(serverId, generation, payload.subagents);
      return undefined;
    })
    .catch((error: unknown) => {
      useProviderSubagentStore
        .getState()
        .failActivitySnapshot(
          serverId,
          generation,
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    })
    .finally(() => {
      clientRequests?.delete(serverId);
    });
  clientRequests.set(serverId, request);
  return request;
}

export function refreshProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
): Promise<void> {
  const requestKey = `${serverId}\0${parentAgentId}`;
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      useProviderSubagentStore.getState().replaceList(serverId, parentAgentId, payload.subagents);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

function serverPrefix(serverId: string): string {
  return `${serverId}\0`;
}

function hasActivitySnapshot(state: ProviderSubagentActivityState | undefined): boolean {
  return (
    state?.kind === "ready" ||
    ((state?.kind === "loading" || state?.kind === "error") && state.hasSnapshot)
  );
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  rows: new Map(),
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") {
    return null;
  }
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function buildTimelineState(
  rows: ProviderSubagentTimelineState["rows"],
  epoch: string | null,
  descriptor?: ProviderSubagentDescriptorPayload,
  hasOlder = false,
): ProviderSubagentTimelineState {
  let timeline = { tail: [] as StreamItem[], head: [] as StreamItem[] };
  for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
    timeline = applyStreamEvent({
      ...timeline,
      event: { type: "timeline", provider: row.provider, item: row.item },
      timestamp: new Date(row.timestamp),
    });
  }
  const terminalEvent = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (terminalEvent && descriptor) {
    timeline = applyStreamEvent({
      ...timeline,
      event: terminalEvent,
      timestamp: new Date(descriptor.updatedAt),
    });
  }
  return {
    ...timeline,
    epoch,
    lastSeq: rows.size ? Math.max(...rows.keys()) : 0,
    hasOlder,
    rows,
  };
}

function buildTimelineResponseRows(
  existing: ProviderSubagentTimelineState | undefined,
  payload: Extract<
    SessionOutboundMessage,
    { type: "agent.provider_subagents.timeline.get.response" }
  >["payload"],
  provider: ProviderSubagentDescriptorPayload["provider"],
): ProviderSubagentTimelineState["rows"] {
  const rows = new Map<number, ProviderSubagentTimelineRow>();
  for (const row of payload.rows) {
    rows.set(row.seq, { provider, item: row.item, timestamp: row.timestamp });
  }
  if (payload.reset || existing?.epoch !== payload.epoch) {
    return rows;
  }
  if (payload.direction !== "tail") {
    return new Map([...existing.rows, ...rows]);
  }

  let nextSeq = payload.rows.length
    ? Math.max(...payload.rows.map((row) => row.seq)) + 1
    : payload.window.maxSeq + 1;
  for (const [seq, row] of [...existing.rows].sort(([left], [right]) => left - right)) {
    if (seq < nextSeq) continue;
    if (seq !== nextSeq) break;
    rows.set(seq, row);
    nextSeq += 1;
  }
  return rows;
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set, get) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  activityByServer: new Map(),
  activityGenerationByServer: new Map(),
  beginActivitySnapshot(serverId) {
    const generation = (get().activityGenerationByServer.get(serverId) ?? 0) + 1;
    set((state) => {
      const activityGenerationByServer = new Map(state.activityGenerationByServer);
      activityGenerationByServer.set(serverId, generation);
      const activityByServer = new Map(state.activityByServer);
      activityByServer.set(serverId, {
        kind: "loading",
        hasSnapshot: hasActivitySnapshot(state.activityByServer.get(serverId)),
      });
      return { activityByServer, activityGenerationByServer };
    });
    return generation;
  },
  replaceActivitySnapshot(serverId, generation, subagents) {
    set((state) => {
      if (state.activityGenerationByServer.get(serverId) !== generation) return state;
      const prefix = serverPrefix(serverId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      for (const subagent of subagents) {
        descriptors.set(
          providerSubagentKey(serverId, subagent.parentAgentId, subagent.id),
          subagent,
        );
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      const hiddenFromTrack = new Set(
        [...state.hiddenFromTrack].filter(
          (key) => !key.startsWith(prefix) || retainedKeys.has(key),
        ),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, subagent.parentAgentId, subagent.id);
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (subagent.status === "running") hiddenFromTrack.delete(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, subagent, current.hasOlder),
          );
        }
      }
      const activityByServer = new Map(state.activityByServer);
      activityByServer.set(serverId, { kind: "ready" });
      return { descriptors, timelines, hiddenFromTrack, activityByServer };
    });
  },
  failActivitySnapshot(serverId, generation, error) {
    set((state) => {
      if (state.activityGenerationByServer.get(serverId) !== generation) return state;
      const activityByServer = new Map(state.activityByServer);
      activityByServer.set(serverId, {
        kind: "error",
        hasSnapshot: hasActivitySnapshot(state.activityByServer.get(serverId)),
        error,
      });
      return { activityByServer };
    });
  },
  markActivityUnsupported(serverId) {
    set((state) => {
      const activityGenerationByServer = new Map(state.activityGenerationByServer);
      activityGenerationByServer.set(serverId, (activityGenerationByServer.get(serverId) ?? 0) + 1);
      const activityByServer = new Map(state.activityByServer);
      activityByServer.set(serverId, { kind: "unsupported" });
      return { activityByServer, activityGenerationByServer };
    });
  },
  hideFromTrack(serverId, parentAgentId, subagentIds) {
    set((state) => {
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagentId of subagentIds) {
        const key = providerSubagentKey(serverId, parentAgentId, subagentId);
        if (state.descriptors.get(key)?.status !== "running") hiddenFromTrack.add(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        descriptors.set(key, subagent);
        if (subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, subagent, current.hasOlder),
          );
        }
      }
      return { descriptors, timelines, hiddenFromTrack };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        const descriptors = new Map(state.descriptors);
        const hiddenFromTrack = new Set(state.hiddenFromTrack);
        const previous = descriptors.get(key);
        descriptors.set(key, payload.subagent);
        if (payload.subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current && previous?.status !== payload.subagent.status) {
          timelines = new Map(state.timelines);
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, payload.subagent, current.hasOlder),
          );
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      if (existing?.epoch && existing.epoch !== payload.epoch) {
        return state;
      }
      const current = existing ?? EMPTY_TIMELINE;
      if (payload.seq <= current.lastSeq) {
        return state;
      }
      const rows = new Map(current.rows);
      rows.set(payload.seq, {
        provider: payload.provider,
        item: payload.item,
        timestamp: payload.timestamp,
      });
      const descriptor = state.descriptors.get(key);
      const next =
        descriptor && descriptor.status !== "running"
          ? buildTimelineState(rows, payload.epoch, descriptor, current.hasOlder)
          : applyStreamEvent({
              tail: current.tail,
              head: current.head,
              event: { type: "timeline", provider: payload.provider, item: payload.item },
              timestamp: new Date(payload.timestamp),
            });
      const timelines = new Map(state.timelines);
      timelines.set(key, {
        ...next,
        epoch: payload.epoch,
        lastSeq: payload.seq,
        hasOlder: current.hasOlder,
        rows,
      });
      return { timelines };
    });
  },
  replaceTimeline(serverId, payload) {
    const provider = payload.provider;
    if (!provider) {
      return;
    }
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      const rows = buildTimelineResponseRows(existing, payload, provider);
      const descriptor = state.descriptors.get(key);
      const timelines = new Map(state.timelines);
      timelines.set(key, buildTimelineState(rows, payload.epoch, descriptor, payload.hasOlder));
      return { timelines };
    });
  },
}));
