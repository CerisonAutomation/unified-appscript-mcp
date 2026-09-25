#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { registerTools } from "./tools.js";

export const SERVER_INFO = { name: "unified-appscript-mcp", version: "0.2.0" } as const;
const instructions = "Unified Google Apps Script and Workspace MCP. Call auth_status first. If not connected, call auth_setup; it auto-detects credentials or opens the Google Cloud client page. Then call auth_login, which automatically opens the Google consent page. Require explicit user confirmation before tools marked destructive.";

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions });
  registerTools(server);
  return server;
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerGuard(expected = process.env.MCP_BEARER_TOKEN) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expected) { next(); return; }
    const authorization = req.header("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), expected)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }); return;
    }
    next();
  };
}

function allowedOrigins(): Set<string> {
  return new Set((process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
}

export async function startHttp(): Promise<void> {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !process.env.MCP_BEARER_TOKEN) throw new Error("Remote HTTP mode requires MCP_BEARER_TOKEN.");
  const origins = allowedOrigins();
  const app = createMcpExpressApp({ host, allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? "").split(",").map((v) => v.trim()).filter(Boolean) });
  app.disable("x-powered-by"); app.use((req, res, next) => { res.set("Cache-Control", "no-store"); const origin = req.header("origin"); if (origin && origins.size && !origins.has(origin)) { res.status(403).json({ error: "Origin is not allowed" }); return; } next(); });
  app.use(bearerGuard()); app.use("/mcp", (req, res, next) => { if (req.method === "POST") { let size = 0; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4_194_304) { res.status(413).end(); req.destroy(); return; } chunks.push(chunk); }); req.on("end", () => { if (res.headersSent) return; try { (req as Request & { body?: unknown }).body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; next(); } catch { res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); } }); } else next(); });
  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id"); let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, keepAliveMs: 15_000, maxRequestBodySize: 4_194_304, onsessioninitialized: (id) => { transports.set(id, transport!); }, onsessionclosed: (id) => { transports.delete(id); } });
        transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); };
        await createServer().connect(transport);
      }
      if (!transport) { res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session" }, id: null }); return; }
      await transport.handleRequest(req, res, req.body);
    } catch (error) { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }, id: null }); }
  });
  const existing = async (req: Request, res: Response): Promise<void> => { const id = req.header("mcp-session-id"); const transport = id ? transports.get(id) : undefined; if (!transport) { res.status(400).send("Invalid or missing MCP session"); return; } await transport.handleRequest(req, res); };
  app.get("/mcp", existing); app.delete("/mcp", existing);
  app.get("/healthz", (_req, res) => res.json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, transport: "streamable-http", sessions: transports.size }));
  const listener = app.listen(port, host, () => console.error(`${SERVER_INFO.name} listening on http://${host}:${port}/mcp`));
  const stop = async () => { for (const transport of transports.values()) await transport.close(); listener.close(); };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
}

if (process.env.MCP_TRANSPORT === "http" || process.argv.includes("--http")) await startHttp(); else await createServer().connect(new StdioServerTransport());
