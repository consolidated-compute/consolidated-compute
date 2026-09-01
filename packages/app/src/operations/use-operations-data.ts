import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  type HostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import {
  refreshProviderSubagentActivity,
  type ProviderSubagentActivityState,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import {
  buildOperationsModel,
  type OperationsHostFacts,
  type OperationsHostState,
  type OperationsModel,
  type OperationsProviderSubagentActivityState,
  type OperationsProviderSubagentFacts,
} from "./model";

export interface OperationsData extends OperationsModel {
  refreshAll: () => Promise<void>;
}

function toHostState(snapshot: HostRuntimeSnapshot | null): OperationsHostState {
  if (!snapshot) return { kind: "initial_loading" };
  const error = snapshot.agentDirectoryError ?? snapshot.lastError;
  const isOnline = snapshot.connectionStatus === "online";
  if (!isOnline) {
    return {
      kind: "offline",
      hasLoadedDirectory: snapshot.hasEverLoadedAgentDirectory,
      error,
    };
  }
  if (error) {
    return {
      kind: "error",
      hasLoadedDirectory: snapshot.hasEverLoadedAgentDirectory,
      isOnline,
      error,
    };
  }
  if (snapshot.agentDirectoryStatus === "revalidating") return { kind: "revalidating" };
  if (isHostRuntimeDirectoryLoading(snapshot)) return { kind: "initial_loading" };
  return { kind: "ready" };
}

function toProviderSubagentActivityState(
  supported: boolean | null | undefined,
  state: ProviderSubagentActivityState | undefined,
): OperationsProviderSubagentActivityState {
  if (supported === false) return { kind: "unsupported" };
  if (state) return state;
  return { kind: "initial_loading" };
}

export function useOperationsData(): OperationsData {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const { agents } = useAggregatedAgents();
  const { projects } = useProjects();
  const previousRef = useRef<OperationsModel | null>(null);
  const automaticSnapshotKeyByServer = useRef(new Map<string, string>());
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const providerSubagentSupport = useHostFeatureAvailabilityMap(
    serverIds,
    "providerSubagentActivitySnapshot",
  );
  const providerSubagentDescriptors = useProviderSubagentStore((state) => state.descriptors);
  const providerSubagentActivityByServer = useProviderSubagentStore(
    (state) => state.activityByServer,
  );

  useEffect(() => {
    for (const serverId of serverIds) {
      const supported = providerSubagentSupport.get(serverId);
      if (supported === false) {
        automaticSnapshotKeyByServer.current.delete(serverId);
        if (
          useProviderSubagentStore.getState().activityByServer.get(serverId)?.kind !== "unsupported"
        ) {
          useProviderSubagentStore.getState().markActivityUnsupported(serverId);
        }
        continue;
      }
      if (supported !== true) continue;
      const snapshot = runtime.getSnapshot(serverId);
      const client = snapshot?.client;
      if (!client || snapshot.connectionStatus !== "online") continue;
      const snapshotKey = `${snapshot.clientGeneration}:${snapshot.connectionEpoch}`;
      if (automaticSnapshotKeyByServer.current.get(serverId) === snapshotKey) continue;
      automaticSnapshotKeyByServer.current.set(serverId, snapshotKey);
      void refreshProviderSubagentActivity(client, serverId).catch(() => undefined);
    }
  }, [providerSubagentSupport, runtime, runtimeVersion, serverIds]);

  const hostFacts = useMemo<OperationsHostFacts[]>(() => {
    void runtimeVersion;
    return hosts.map((host) => {
      const snapshot = runtime.getSnapshot(host.serverId);
      return {
        serverId: host.serverId,
        serverName: host.label,
        state: toHostState(snapshot),
        providerSubagentActivity: toProviderSubagentActivityState(
          providerSubagentSupport.get(host.serverId),
          providerSubagentActivityByServer.get(host.serverId),
        ),
      };
    });
  }, [hosts, providerSubagentActivityByServer, providerSubagentSupport, runtime, runtimeVersion]);

  const providerSubagents = useMemo<OperationsProviderSubagentFacts[]>(() => {
    const facts: OperationsProviderSubagentFacts[] = [];
    for (const serverId of serverIds) {
      const prefix = `${serverId}\0`;
      for (const [key, descriptor] of providerSubagentDescriptors) {
        if (key.startsWith(prefix)) facts.push({ serverId, descriptor });
      }
    }
    return facts;
  }, [providerSubagentDescriptors, serverIds]);

  const model = useMemo(() => {
    return buildOperationsModel({
      hosts: hostFacts,
      projects,
      agents,
      providerSubagents,
      previous: previousRef.current,
    });
  }, [agents, hostFacts, projects, providerSubagents]);

  useEffect(() => {
    previousRef.current = model;
  }, [model]);

  const refreshAll = useCallback(async () => {
    await Promise.all(
      serverIds.map(async (serverId) => {
        const snapshot = runtime.getSnapshot(serverId);
        if (snapshot?.connectionStatus !== "online") {
          throw new Error(`Cannot refresh offline host ${serverId}`);
        }
        await runtime.refreshDirectories(serverId);
        if (runtime.getSnapshot(serverId)?.connectionStatus !== "online") {
          throw new Error(`Host ${serverId} disconnected during refresh`);
        }
        const client = runtime.getClient(serverId);
        if (client && providerSubagentSupport.get(serverId) === true) {
          // The snapshot helper records its own provider-specific error state. Keep the generic
          // manual-refresh failure reserved for the managed agent directory.
          await refreshProviderSubagentActivity(client, serverId).catch(() => undefined);
        }
      }),
    );
  }, [providerSubagentSupport, runtime, serverIds]);

  return useMemo(() => ({ ...model, refreshAll }), [model, refreshAll]);
}
