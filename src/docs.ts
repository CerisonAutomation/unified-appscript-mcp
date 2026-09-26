import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleRequest } from "./google.js";

const enc = encodeURIComponent;
const BASE = "https://docs.googleapis.com/v1/documents";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (e) { return failure(e); } };
const r = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const d = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

type DocElement = { paragraph?: { elements?: { textRun?: { content?: string } }[] } };
function extractDocText(body: { content?: DocElement[] }): string {
  return (body.content ?? []).map((el) =>
    (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("")
  ).join("").trim();
}

export function registerDocsTools(server: McpServer): void {
  server.registerTool("docs_get", {
    description: "Read a Google Doc's full content, including its plain text and structure.",
    inputSchema: { documentId: z.string().min(1).describe("Google Doc ID from its URL.") },
    annotations: r,
  }, wrap(async ({ documentId }) => {
    const doc = await googleRequest(`${BASE}/${enc(documentId)}`) as { title?: string; body?: { content?: DocElement[] } };
    const plainText = doc.body ? extractDocText(doc.body) : "";
    return { documentId, title: doc.title ?? "", characterCount: plainText.length, plainText, raw: doc };
  }));

  server.registerTool("docs_create", {
    description: "Create a new Google Doc with a title and optional initial text content.",
    inputSchema: {
      title: z.string().min(1).describe("Document title."),
      content: z.string().optional().describe("Initial text to insert into the document."),
    },
    annotations: w,
  }, wrap(async ({ title, content }) => {
    const doc = await googleRequest(BASE, { method: "POST", body: { title } }) as { documentId?: string; title?: string };
    if (content && doc.documentId) {
      await googleRequest(`${BASE}/${enc(doc.documentId!)}:batchUpdate`, {
        method: "POST",
        body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
      });
    }
    return doc;
  }));

  server.registerTool("docs_insert_text", {
    description: "Insert text at a specific index position in a Google Doc.",
    inputSchema: {
      documentId: z.string().min(1).describe("Google Doc ID."),
      text: z.string().min(1).describe("Text to insert."),
      index: z.number().int().min(1).default(1).describe("Character index where text is inserted (1 = start of document)."),
    },
    annotations: w,
  }, wrap(async ({ documentId, text, index }) =>
    googleRequest(`${BASE}/${enc(documentId)}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { location: { index }, text } }] } })
  ));

  server.registerTool("docs_batch_update", {
    description: "Run raw Google Docs batchUpdate requests (format text, insert tables, replace text, etc.).",
    inputSchema: {
      documentId: z.string().min(1).describe("Google Doc ID."),
      requests: z.array(z.record(z.string(), z.unknown())).min(1).describe("Array of Docs API request objects."),
    },
    annotations: d,
  }, wrap(async ({ documentId, requests }) =>
    googleRequest(`${BASE}/${enc(documentId)}:batchUpdate`, { method: "POST", body: { requests } })
  ));

  server.registerTool("docs_replace_text", {
    description: "Find and replace all occurrences of a string in a Google Doc.",
    inputSchema: {
      documentId: z.string().min(1).describe("Google Doc ID."),
      find: z.string().min(1).describe("Text to search for."),
      replaceWith: z.string().describe("Replacement text."),
      matchCase: z.boolean().default(false).describe("Whether the search is case-sensitive."),
    },
    annotations: d,
  }, wrap(async ({ documentId, find, replaceWith, matchCase }) =>
    googleRequest(`${BASE}/${enc(documentId)}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replaceWith } }] },
    })
  ));
}
