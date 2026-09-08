import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import type { HostProfile, RelayHostConnection } from "@/types/host-connection";
import { normalizeHostPort } from "./daemon-endpoints";

export function resolvePairingProbe(offer: ConnectionOffer, hosts: readonly HostProfile[]) {
  const host = hosts.find((candidate) => candidate.serverId === offer.serverId);
  const connection: RelayHostConnection = {
    id: "probe",
    type: "relay",
    relayEndpoint: normalizeHostPort(offer.relay.endpoint),
    useTls: offer.relay.useTls,
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
  };
  return {
    connection,
    options: { serverId: offer.serverId, deviceCredential: host?.deviceCredential },
  };
}
