import { z } from "zod";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  ForgeRepositoryDiscoveryError,
  type ForgeRepositoryDiscovery,
} from "../../../services/forge-repository-discovery.js";

type DiscoveryRequest = Extract<
  SessionInboundMessage,
  {
    type: "forge.repositories.search.request" | "forge.repositories.search_work.request";
  }
>;

export class ForgeRepositorySession {
  constructor(
    private readonly options: {
      resolve(forge: string): ForgeRepositoryDiscovery | null;
      emit(message: SessionOutboundMessage, source?: object): void;
    },
  ) {}

  async handle(request: DiscoveryRequest, source?: object): Promise<void> {
    try {
      const forge =
        request.type === "forge.repositories.search.request"
          ? request.forge
          : request.repository.forge;
      const discovery = this.options.resolve(forge);
      if (!discovery)
        throw new ForgeRepositoryDiscoveryError(
          "unsupported",
          `Repository discovery is unavailable for ${forge} on this host.`,
        );
      if (request.type === "forge.repositories.search.request") {
        const page = await discovery.searchRepositories(request);
        this.options.emit(
          {
            type: "forge.repositories.search.response",
            payload: { ...page, requestId: request.requestId },
          },
          source,
        );
      } else {
        const page = await discovery.searchWork(request);
        this.options.emit(
          {
            type: "forge.repositories.search_work.response",
            payload: { ...page, requestId: request.requestId },
          },
          source,
        );
      }
    } catch (error) {
      let code = "provider_error";
      if (error instanceof ForgeRepositoryDiscoveryError) code = error.code;
      else if (error instanceof z.ZodError) code = "invalid_request";
      this.options.emit(
        {
          type: "rpc_error",
          payload: {
            requestId: request.requestId,
            requestType: request.type,
            code: `forge_discovery_${code}`,
            error:
              error instanceof ForgeRepositoryDiscoveryError
                ? error.message
                : "Repository discovery failed. Check the search inputs and host connectivity, then retry.",
          },
        },
        source,
      );
    }
  }
}
