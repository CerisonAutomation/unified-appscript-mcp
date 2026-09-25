#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "unified-appscript-mcp", version: "0.1.0" }, {
  instructions: "Unified Google Apps Script and Workspace MCP. Call auth_status first. If not connected, call auth_setup; it auto-detects credentials or opens the Google Cloud client page. Then call auth_login, which automatically opens the Google consent page. Require explicit user confirmation before tools marked destructive."
});
registerTools(server);
await server.connect(new StdioServerTransport());
