import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleRequest } from "./google.js";

const enc = encodeURIComponent;
const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (e) { return failure(e); } };
const r = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const d = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const idDesc = "Spreadsheet ID from its URL.";
const rangeDesc = "A1 notation range, e.g. Sheet1!A1:D20 or just A1:D20 for the first sheet.";
const valuesDesc = "2-D array of cell values (rows × columns).";
const idSchema = z.string().min(1).describe(idDesc);
const rangeSchema = z.string().min(1).describe(rangeDesc);
const valuesSchema = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe(valuesDesc);

export function registerSheetsTools(server: McpServer): void {
  server.registerTool("sheets_list", {
    description: "List Google Spreadsheets visible to the authenticated account. Optional name filter.",
    inputSchema: { nameContains: z.string().optional().describe("Case-insensitive substring filter on the spreadsheet name.") },
    annotations: r,
  }, wrap(async ({ nameContains }) => {
    let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    if (nameContains) q += ` and name contains '${nameContains.replace(/'/g, "\\'")}'`;
    return googleRequest("https://www.googleapis.com/drive/v3/files", { query: { q, pageSize: 100, fields: "files(id,name,modifiedTime,webViewLink)", orderBy: "modifiedTime desc", supportsAllDrives: true, includeItemsFromAllDrives: true } });
  }));

  server.registerTool("sheets_get", {
    description: "Get a spreadsheet's title and list of sheet tabs.",
    inputSchema: { spreadsheetId: idSchema },
    annotations: r,
  }, wrap(async ({ spreadsheetId }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}`, { query: { fields: "spreadsheetId,properties.title,sheets.properties,spreadsheetUrl" } })
  ));

  server.registerTool("sheets_read", {
    description: "Read cell values from a range. Returns rows of values.",
    inputSchema: { spreadsheetId: idSchema, range: rangeSchema },
    annotations: r,
  }, wrap(async ({ spreadsheetId, range }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}/values/${enc(range)}`)
  ));

  server.registerTool("sheets_read_batch", {
    description: "Read multiple non-contiguous ranges in a single request.",
    inputSchema: { spreadsheetId: idSchema, ranges: z.array(z.string().min(1)).min(1).max(100).describe("List of A1 ranges to read.") },
    annotations: r,
  }, wrap(async ({ spreadsheetId, ranges }) => {
    const params = new URLSearchParams();
    ranges.forEach((r) => params.append("ranges", r));
    return googleRequest(`${BASE}/${enc(spreadsheetId)}/values:batchGet?${params.toString()}`);
  }));

  server.registerTool("sheets_write", {
    description: "Overwrite a range of cells with new values. Existing data outside the written range is untouched.",
    inputSchema: { spreadsheetId: idSchema, range: rangeSchema, values: valuesSchema },
    annotations: d,
  }, wrap(async ({ spreadsheetId, range, values }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}/values/${enc(range)}`, { method: "PUT", query: { valueInputOption: "USER_ENTERED" }, body: { values } })
  ));

  server.registerTool("sheets_append", {
    description: "Append rows after the last filled row in a range/table.",
    inputSchema: { spreadsheetId: idSchema, range: rangeSchema, values: valuesSchema },
    annotations: w,
  }, wrap(async ({ spreadsheetId, range, values }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}/values/${enc(range)}:append`, { method: "POST", query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" }, body: { values } })
  ));

  server.registerTool("sheets_clear", {
    description: "Clear all values in a range (preserves formatting).",
    inputSchema: { spreadsheetId: idSchema, range: rangeSchema },
    annotations: d,
  }, wrap(async ({ spreadsheetId, range }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}/values/${enc(range)}:clear`, { method: "POST" })
  ));

  server.registerTool("sheets_create", {
    description: "Create a new Google Spreadsheet and optionally share it immediately.",
    inputSchema: {
      title: z.string().min(1).describe("Title of the new spreadsheet."),
      shareWithEmail: z.string().email().optional().describe("If provided, share the new spreadsheet with this email as editor."),
    },
    annotations: w,
  }, wrap(async ({ title, shareWithEmail }) => {
    const sheet = await googleRequest(`${BASE}`, { method: "POST", body: { properties: { title } } }) as { spreadsheetId?: string };
    if (shareWithEmail && sheet.spreadsheetId) {
      await googleRequest(`https://www.googleapis.com/drive/v3/files/${enc(sheet.spreadsheetId)}/permissions`, {
        method: "POST", body: { type: "user", role: "writer", emailAddress: shareWithEmail },
      });
    }
    return sheet;
  }));

  server.registerTool("sheets_add_sheet", {
    description: "Add a new tab (sheet) to an existing spreadsheet.",
    inputSchema: { spreadsheetId: idSchema, title: z.string().min(1).describe("Name for the new tab.") },
    annotations: w,
  }, wrap(async ({ spreadsheetId, title }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}:batchUpdate`, { method: "POST", body: { requests: [{ addSheet: { properties: { title } } }] } })
  ));

  server.registerTool("sheets_batch_update", {
    description: "Run raw Sheets batchUpdate requests (format cells, delete rows, merge, resize columns, etc.).",
    inputSchema: { spreadsheetId: idSchema, requests: z.array(z.record(z.string(), z.unknown())).min(1).describe("Array of Sheets API request objects.") },
    annotations: d,
  }, wrap(async ({ spreadsheetId, requests }) =>
    googleRequest(`${BASE}/${enc(spreadsheetId)}:batchUpdate`, { method: "POST", body: { requests } })
  ));
}
