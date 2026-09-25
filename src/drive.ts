import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleRequest, paginated } from "./google.js";

const enc = encodeURIComponent;
const BASE = "https://www.googleapis.com/drive/v3/files";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (e) { return failure(e); } };
const r = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const d = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const FIELDS = "id,name,mimeType,modifiedTime,createdTime,size,owners,webViewLink,parents,trashed";
const allDrives = { supportsAllDrives: true, includeItemsFromAllDrives: true };

export function registerDriveTools(server: McpServer): void {
  server.registerTool("drive_list_files", {
    description: "List files in Google Drive. Filter by folder, name, mime type. Supports shared drives. Returns name, id, type, modified time.",
    inputSchema: {
      query: z.string().optional().describe("Raw Drive query string. If omitted, lists all non-trashed files."),
      folderId: z.string().optional().describe("Limit to files whose parent is this folder ID (e.g. 'root' for My Drive root)."),
      nameContains: z.string().optional().describe("Case-insensitive name filter (added to query automatically)."),
      mimeType: z.string().optional().describe("Filter by MIME type, e.g. 'application/vnd.google-apps.spreadsheet'."),
      pageSize: z.number().int().min(1).max(1000).default(100),
      maxPages: z.number().int().min(1).max(50).default(5),
    },
    annotations: r,
  }, wrap(async ({ query, folderId, nameContains, mimeType, pageSize, maxPages }) => {
    const clauses: string[] = ["trashed=false"];
    if (folderId) clauses.push(`'${folderId}' in parents`);
    if (nameContains) clauses.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
    if (mimeType) clauses.push(`mimeType='${mimeType}'`);
    const q = query ?? clauses.join(" and ");
    return paginated(BASE, "files", { q, fields: `nextPageToken,files(${FIELDS})`, orderBy: "modifiedTime desc", pageSize, ...allDrives }, maxPages);
  }));

  server.registerTool("drive_get_file", {
    description: "Get metadata for a single Drive file by ID.",
    inputSchema: { fileId: z.string().min(1).describe("Drive file ID.") },
    annotations: r,
  }, wrap(async ({ fileId }) =>
    googleRequest(`${BASE}/${enc(fileId)}`, { query: { fields: FIELDS, ...allDrives } })
  ));

  server.registerTool("drive_create_folder", {
    description: "Create a new folder in Google Drive.",
    inputSchema: {
      name: z.string().min(1).describe("Folder name."),
      parentId: z.string().optional().describe("Parent folder ID. Defaults to My Drive root."),
    },
    annotations: w,
  }, wrap(async ({ name, parentId }) =>
    googleRequest(BASE, { method: "POST", query: { fields: FIELDS, ...allDrives }, body: { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) } })
  ));

  server.registerTool("drive_copy_file", {
    description: "Copy a Drive file. Returns the new file's metadata.",
    inputSchema: {
      fileId: z.string().min(1).describe("ID of the file to copy."),
      name: z.string().optional().describe("Name for the copy. Defaults to 'Copy of <original>'."),
      destinationFolderId: z.string().optional().describe("Destination folder ID. Defaults to same folder as original."),
    },
    annotations: w,
  }, wrap(async ({ fileId, name, destinationFolderId }) =>
    googleRequest(`${BASE}/${enc(fileId)}/copy`, { method: "POST", query: { fields: FIELDS, ...allDrives }, body: { ...(name ? { name } : {}), ...(destinationFolderId ? { parents: [destinationFolderId] } : {}) } })
  ));

  server.registerTool("drive_move_file", {
    description: "Move a file to a different folder (updates its parents).",
    inputSchema: {
      fileId: z.string().min(1).describe("Drive file ID."),
      newParentId: z.string().min(1).describe("Destination folder ID."),
    },
    annotations: w,
  }, wrap(async ({ fileId, newParentId }) => {
    const file = await googleRequest(`${BASE}/${enc(fileId)}`, { query: { fields: "parents", ...allDrives } }) as { parents?: string[] };
    const removeParents = (file.parents ?? []).join(",");
    return googleRequest(`${BASE}/${enc(fileId)}`, { method: "PATCH", query: { addParents: newParentId, ...(removeParents ? { removeParents } : {}), fields: FIELDS, ...allDrives }, body: {} });
  }));

  server.registerTool("drive_rename_file", {
    description: "Rename a Drive file or folder.",
    inputSchema: {
      fileId: z.string().min(1).describe("Drive file ID."),
      name: z.string().min(1).describe("New name."),
    },
    annotations: w,
  }, wrap(async ({ fileId, name }) =>
    googleRequest(`${BASE}/${enc(fileId)}`, { method: "PATCH", query: { fields: FIELDS, ...allDrives }, body: { name } })
  ));

  server.registerTool("drive_delete_file", {
    description: "Permanently delete a Drive file or folder. This cannot be undone. Requires confirm=true.",
    inputSchema: {
      fileId: z.string().min(1).describe("Drive file ID to delete."),
      confirm: z.literal(true).describe("Must be true to confirm permanent deletion."),
    },
    annotations: d,
  }, wrap(async ({ fileId }) => {
    await googleRequest(`${BASE}/${enc(fileId)}`, { method: "DELETE", query: { ...allDrives } });
    return { deleted: true, fileId };
  }));

  server.registerTool("drive_share_file", {
    description: "Share a Drive file with a user, group, or domain.",
    inputSchema: {
      fileId: z.string().min(1).describe("Drive file ID."),
      emailAddress: z.string().email().describe("Email address to share with."),
      role: z.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"]).default("reader").describe("Permission role."),
      sendNotificationEmail: z.boolean().default(false).describe("Whether Google sends a sharing notification email."),
    },
    annotations: w,
  }, wrap(async ({ fileId, emailAddress, role, sendNotificationEmail }) =>
    googleRequest(`${BASE}/${enc(fileId)}/permissions`, { method: "POST", query: { sendNotificationEmail: String(sendNotificationEmail), ...allDrives }, body: { type: "user", role, emailAddress } })
  ));
}
