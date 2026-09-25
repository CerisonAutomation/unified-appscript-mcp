import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleRequest } from "./google.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const enc = encodeURIComponent;
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (e) { return failure(e); } };
const r = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const d = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function b64url(s: string): string {
  return btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function encodeHeader(v: string): string {
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${b64url(v)}?=`;
}
function buildRaw(o: { to: string; subject: string; body: string; cc?: string; bcc?: string; html?: boolean; threadId?: string; replyToMessageId?: string }): string {
  const lines = [`To: ${o.to}`];
  if (o.cc) lines.push(`Cc: ${o.cc}`);
  if (o.bcc) lines.push(`Bcc: ${o.bcc}`);
  lines.push(`Subject: ${encodeHeader(o.subject)}`);
  if (o.replyToMessageId) lines.push(`In-Reply-To: ${o.replyToMessageId}`, `References: ${o.replyToMessageId}`);
  lines.push("MIME-Version: 1.0", `Content-Type: text/${o.html ? "html" : "plain"}; charset="UTF-8"`, "", o.body);
  return b64url(lines.join("\r\n"));
}

function decodePart(data?: string): string {
  if (!data) return "";
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
function extractBody(part: GmailPart): { plain: string; html: string } {
  const out = { plain: "", html: "" };
  const walk = (p: GmailPart) => {
    if (p.mimeType === "text/plain" && !out.plain) out.plain = decodePart(p.body?.data);
    if (p.mimeType === "text/html" && !out.html) out.html = decodePart(p.body?.data);
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

const mailInputSchema = {
  to: z.string().min(1).describe("Recipient(s), comma-separated."),
  subject: z.string().describe("Email subject."),
  body: z.string().describe("Email body."),
  cc: z.string().optional().describe("CC recipients, comma-separated."),
  bcc: z.string().optional().describe("BCC recipients, comma-separated."),
  html: z.boolean().optional().describe("If true, body is treated as HTML."),
  threadId: z.string().optional().describe("Thread ID to reply within."),
  replyToMessageId: z.string().optional().describe("Message-ID header value for proper threading when replying."),
};

export function registerGmailTools(server: McpServer): void {
  server.registerTool("gmail_search", {
    description: "Search Gmail messages using standard Gmail search syntax (e.g. 'from:alice is:unread after:2024/1/1'). Returns id, from, subject, date, snippet.",
    inputSchema: {
      query: z.string().default("").describe("Gmail search query."),
      maxResults: z.number().int().min(1).max(100).default(20).describe("Max number of messages to return."),
    },
    annotations: r,
  }, wrap(async ({ query, maxResults }) => {
    const list = await googleRequest(`${BASE}/messages`, { query: { q: query, maxResults } }) as { messages?: { id: string }[] };
    const ids = list.messages ?? [];
    const items = await Promise.all(ids.map(async ({ id }) => {
      const m = await googleRequest(`${BASE}/messages/${enc(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as { threadId?: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
      const h = Object.fromEntries((m.payload?.headers ?? []).map((x) => [x.name, x.value]));
      return { id, threadId: m.threadId ?? "", from: h["From"] ?? "", subject: h["Subject"] ?? "", date: h["Date"] ?? "", snippet: m.snippet ?? "" };
    }));
    return { resultCount: items.length, messages: items };
  }));

  server.registerTool("gmail_read", {
    description: "Read a full email message by its ID. Returns headers and decoded body.",
    inputSchema: { messageId: z.string().min(1).describe("Message ID from gmail_search.") },
    annotations: r,
  }, wrap(async ({ messageId }) => {
    const m = await googleRequest(`${BASE}/messages/${enc(messageId)}`, { query: { format: "full" } }) as { id: string; threadId: string; labelIds?: string[]; payload: GmailPart };
    const h = Object.fromEntries((m.payload.headers ?? []).map((x) => [x.name, x.value]));
    const body = extractBody(m.payload);
    return { id: m.id, threadId: m.threadId, labels: m.labelIds ?? [], from: h["From"] ?? "", to: h["To"] ?? "", subject: h["Subject"] ?? "", date: h["Date"] ?? "", messageIdHeader: h["Message-ID"] ?? h["Message-Id"] ?? "", body: body.plain || body.html };
  }));

  server.registerTool("gmail_read_thread", {
    description: "Read all messages in a Gmail thread.",
    inputSchema: { threadId: z.string().min(1).describe("Thread ID from gmail_search.") },
    annotations: r,
  }, wrap(async ({ threadId }) => {
    const thread = await googleRequest(`${BASE}/threads/${enc(threadId)}`, { query: { format: "full" } }) as { id: string; messages?: { id: string; payload: GmailPart; labelIds?: string[] }[] };
    const messages = (thread.messages ?? []).map((m) => {
      const h = Object.fromEntries((m.payload.headers ?? []).map((x) => [x.name, x.value]));
      const body = extractBody(m.payload);
      return { id: m.id, from: h["From"] ?? "", subject: h["Subject"] ?? "", date: h["Date"] ?? "", body: body.plain || body.html };
    });
    return { threadId: thread.id, messageCount: messages.length, messages };
  }));

  server.registerTool("gmail_send", {
    description: "Send an email from the authenticated Gmail account.",
    inputSchema: mailInputSchema,
    annotations: w,
  }, wrap(async (args) =>
    googleRequest(`${BASE}/messages/send`, { method: "POST", body: { raw: buildRaw(args), ...(args.threadId ? { threadId: args.threadId } : {}) } })
  ));

  server.registerTool("gmail_draft", {
    description: "Save an email as a draft without sending.",
    inputSchema: mailInputSchema,
    annotations: w,
  }, wrap(async (args) =>
    googleRequest(`${BASE}/drafts`, { method: "POST", body: { message: { raw: buildRaw(args), ...(args.threadId ? { threadId: args.threadId } : {}) } } })
  ));

  server.registerTool("gmail_modify_labels", {
    description: "Add or remove labels on messages. Common uses: archive = remove INBOX, mark read = remove UNREAD, star = add STARRED.",
    inputSchema: {
      messageIds: z.array(z.string().min(1)).min(1).describe("Message IDs to modify."),
      addLabelIds: z.array(z.string()).default([]).describe("Label IDs to add, e.g. ['STARRED']."),
      removeLabelIds: z.array(z.string()).default([]).describe("Label IDs to remove, e.g. ['UNREAD','INBOX']."),
    },
    annotations: w,
  }, wrap(async ({ messageIds, addLabelIds, removeLabelIds }) => {
    await googleRequest(`${BASE}/messages/batchModify`, { method: "POST", body: { ids: messageIds, addLabelIds, removeLabelIds } });
    return { modified: messageIds.length, messageIds };
  }));

  server.registerTool("gmail_trash", {
    description: "Move a message to trash.",
    inputSchema: { messageId: z.string().min(1).describe("Message ID to trash.") },
    annotations: d,
  }, wrap(async ({ messageId }) =>
    googleRequest(`${BASE}/messages/${enc(messageId)}/trash`, { method: "POST" })
  ));

  server.registerTool("gmail_list_labels", {
    description: "List all Gmail labels and their IDs.",
    inputSchema: {},
    annotations: r,
  }, wrap(async () => googleRequest(`${BASE}/labels`)));
}
