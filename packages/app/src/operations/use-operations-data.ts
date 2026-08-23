import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  type HostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import {
  buildOperationsModel,
  type OperationsHostFacts,
  type OperationsHostState,
  type OperationsModel,
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

  const hostFacts = useMemo<OperationsHostFacts[]>(() => {
    void runtimeVersion;
    return hosts.map((host) => {
      const snapshot = runtime.getSnapshot(host.serverId);
      return {
        serverId: host.serverId,
        serverName: host.label,
        state: toHostState(snapshot),
      };
    });
  }, [hosts, runtime, runtimeVersion]);

  const model = useMemo(() => {
    return buildOperationsModel({
      hosts: hostFacts,
      projects,
      agents,
      previous: previousRef.current,
    });
  }, [agents, hostFacts, projects]);

  useEffect(() => {
    previousRef.current = model;
  }, [model]);

  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const refreshAll = useCallback(async () => {
    await Promise.all(serverIds.map((serverId) => runtime.refreshDirectories(serverId)));
  }, [runtime, serverIds]);

  return useMemo(() => ({ ...model, refreshAll }), [model, refreshAll]);
}
