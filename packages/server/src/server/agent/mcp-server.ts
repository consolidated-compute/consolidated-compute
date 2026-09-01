import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import { createPaseoToolMcpServer } from "./tools/paseo-tool-mcp-server.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  return createPaseoToolMcpServer(catalog);
}
