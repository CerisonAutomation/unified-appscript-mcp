import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import open from "open";
import { authStatus, login, logout, setupOAuth, SCOPE_PROFILES } from "./auth.js";
import { googleRequest, paginated, scriptUrl } from "./google.js";
import { registerSheetsTools } from "./sheets.js";
import { registerGmailTools } from "./gmail.js";
import { registerDriveTools } from "./drive.js";
import { registerDocsTools } from "./docs.js";
import { registerCalendarTools } from "./calendar.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (error) { return failure(error); } };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const filesSchema = z.array(z.object({ name: z.string().min(1), type: z.enum(["SERVER_JS", "HTML", "JSON"]), source: z.string() })).min(1);
const qs = (params: Record<string, string | number | undefined>): Record<string, unknown> => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

export function registerTools(server: McpServer): void {
  // ── Auth ──────────────────────────────────────────────────────────────────
  server.registerTool("auth_status", {
    description: "Detect OAuth client and token state; refreshes credentials to verify the connection.",
    inputSchema: {},
    annotations: readOnly,
  }, wrap(async () => authStatus()));

  server.registerTool("auth_setup", {
    description: "Auto-detect a Desktop OAuth client. If absent, opens Google Auth Platform Clients page; client_secret_*.json in Downloads is auto-detected.",
    inputSchema: { clientFile: z.string().optional(), openBrowser: z.boolean().default(true) },
    annotations: write,
  }, wrap(async ({ clientFile, openBrowser }) => setupOAuth({ clientFile, openBrowser })));

  server.registerTool("auth_login", {
    description: "Open the system browser, run Google OAuth with PKCE and a one-shot loopback callback, then store owner-only refresh credentials.",
    inputSchema: {
      profile: z.enum(Object.keys(SCOPE_PROFILES) as [keyof typeof SCOPE_PROFILES, ...(keyof typeof SCOPE_PROFILES)[]])
        .default("workspace-full")
        .describe("Scope profile. Use 'workspace-full' to enable all tools; 'apps-script' for script-only access."),
      timeoutSeconds: z.number().int().min(30).max(600).default(180),
    },
    annotations: write,
  }, wrap(async ({ profile, timeoutSeconds }) => login(profile, timeoutSeconds)));

  server.registerTool("auth_logout", {
    description: "Revoke stored Google authorization and delete local tokens.",
    inputSchema: {},
    annotations: destructive,
  }, wrap(async () => logout()));

  // Single-step: setup + login in one call. Replaces the three-step flow for new users.
  server.registerTool("auth_connect", {
    description: "One-step Google connection: auto-detects an OAuth client (or opens the setup page), then immediately opens the browser for authorization. Equivalent to auth_setup + auth_login in a single call. Use this to connect for the first time.",
    inputSchema: {
      clientFile: z.string().optional().describe("Path to a client_secret JSON file. Auto-detected from Downloads if omitted."),
      profile: z.enum(Object.keys(SCOPE_PROFILES) as [keyof typeof SCOPE_PROFILES, ...(keyof typeof SCOPE_PROFILES)[]])
        .default("workspace-full")
        .describe("Scope profile. 'workspace-full' enables all Sheets, Gmail, Drive, Docs and Calendar tools."),
      timeoutSeconds: z.number().int().min(30).max(600).default(180),
    },
    annotations: write,
  }, wrap(async ({ clientFile, profile, timeoutSeconds }) => {
    const setup = await setupOAuth({ clientFile, openBrowser: true });
    if (!setup["ready"]) return setup; // No client found yet; browser opened for setup page.
    return login(profile, timeoutSeconds);
  }));

  // ── Apps Script: projects & code ──────────────────────────────────────────
  server.registerTool("apps_script_create_project", {
    description: "Create a standalone or container-bound Apps Script project. Preserve the returned scriptId.",
    inputSchema: { title: z.string().min(1), parentId: z.string().optional().describe("Drive file ID to bind as a container (Sheet, Doc, Form, Slides).") },
    annotations: write,
  }, wrap(async ({ title, parentId }) => googleRequest(scriptUrl("/projects"), { method: "POST", body: { title, ...(parentId ? { parentId } : {}) } })));

  server.registerTool("apps_script_get_project", {
    description: "Get Apps Script project metadata.",
    inputSchema: { scriptId: z.string().min(1) },
    annotations: readOnly,
  }, wrap(async ({ scriptId }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}`))));

  server.registerTool("apps_script_get_content", {
    description: "Read HEAD or an immutable version of all Apps Script project files.",
    inputSchema: { scriptId: z.string().min(1), versionNumber: z.number().int().positive().optional() },
    annotations: readOnly,
  }, wrap(async ({ scriptId, versionNumber }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/content`), { query: qs({ versionNumber }) })));

  server.registerTool("apps_script_update_content", {
    description: "Update Apps Script HEAD. Merge mode (default) preserves unmentioned files and the manifest; replace mode requires all files including appsscript JSON explicitly.",
    inputSchema: { scriptId: z.string().min(1), files: filesSchema, mode: z.enum(["merge", "replace"]).default("merge") },
    annotations: destructive,
  }, wrap(async ({ scriptId, files, mode }) => {
    let finalFiles = files;
    if (mode === "merge") {
      const current = await googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/content`)) as { files?: Array<{ name: string; type: "SERVER_JS" | "HTML" | "JSON"; source: string }> };
      const map = new Map((current.files ?? []).map((file) => [file.name, file]));
      for (const file of files) map.set(file.name, file);
      finalFiles = [...map.values()];
    }
    if (!finalFiles.some((file) => file.name === "appsscript" && file.type === "JSON")) {
      throw new Error("Refusing update: appsscript JSON manifest is required. Read the current content first and include all files.");
    }
    return googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/content`), { method: "PUT", body: { files: finalFiles } });
  }));

  // Update a single file without touching others — the most ergonomic edit path.
  server.registerTool("apps_script_patch_file", {
    description: "Update the source of a single file in an Apps Script project without affecting any other files. Reads HEAD, replaces the named file, and writes the full set back.",
    inputSchema: {
      scriptId: z.string().min(1),
      name: z.string().min(1).describe("File name to update (without extension), e.g. 'Code' or 'Utils'."),
      source: z.string().describe("New source code for the file."),
      type: z.enum(["SERVER_JS", "HTML", "JSON"]).default("SERVER_JS").describe("File type. Defaults to SERVER_JS (.gs)."),
    },
    annotations: destructive,
  }, wrap(async ({ scriptId, name, source, type }) => {
    const current = await googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/content`)) as { files?: Array<{ name: string; type: "SERVER_JS" | "HTML" | "JSON"; source: string }> };
    const map = new Map((current.files ?? []).map((f) => [f.name, f]));
    map.set(name, { name, type, source });
    return googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/content`), { method: "PUT", body: { files: [...map.values()] } });
  }));

  // ── Apps Script: versions & deployments ───────────────────────────────────
  server.registerTool("apps_script_create_version", {
    description: "Create an immutable version snapshot of HEAD.",
    inputSchema: { scriptId: z.string().min(1), description: z.string().max(500).optional() },
    annotations: write,
  }, wrap(async ({ scriptId, description }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/versions`), { method: "POST", body: { description } })));

  server.registerTool("apps_script_list_versions", {
    description: "List immutable versions, automatically following pagination.",
    inputSchema: { scriptId: z.string().min(1), pageSize: z.number().int().min(1).max(200).default(50), maxPages: z.number().int().min(1).max(100).default(20) },
    annotations: readOnly,
  }, wrap(async ({ scriptId, pageSize, maxPages }) => paginated(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/versions`), "versions", { pageSize }, maxPages)));

  server.registerTool("apps_script_get_version", {
    description: "Get one immutable Apps Script version.",
    inputSchema: { scriptId: z.string().min(1), versionNumber: z.number().int().positive() },
    annotations: readOnly,
  }, wrap(async ({ scriptId, versionNumber }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/versions/${versionNumber}`))));

  server.registerTool("apps_script_list_deployments", {
    description: "List deployments and entry points, automatically following pagination.",
    inputSchema: { scriptId: z.string().min(1), pageSize: z.number().int().min(1).max(200).default(50), maxPages: z.number().int().min(1).max(100).default(20) },
    annotations: readOnly,
  }, wrap(async ({ scriptId, pageSize, maxPages }) => paginated(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/deployments`), "deployments", { pageSize }, maxPages)));

  server.registerTool("apps_script_get_deployment", {
    description: "Get one Apps Script deployment.",
    inputSchema: { scriptId: z.string().min(1), deploymentId: z.string().min(1) },
    annotations: readOnly,
  }, wrap(async ({ scriptId, deploymentId }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`))));

  server.registerTool("apps_script_create_deployment", {
    description: "Deploy an immutable version with a manifest entry point.",
    inputSchema: { scriptId: z.string().min(1), versionNumber: z.number().int().positive(), description: z.string().max(500).optional(), manifestFileName: z.string().default("appsscript") },
    annotations: write,
  }, wrap(async ({ scriptId, versionNumber, description, manifestFileName }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/deployments`), { method: "POST", body: { versionNumber, description, manifestFileName } })));

  server.registerTool("apps_script_update_deployment", {
    description: "Repoint an existing deployment to another immutable version while keeping its deployment ID/URL.",
    inputSchema: { scriptId: z.string().min(1), deploymentId: z.string().min(1), versionNumber: z.number().int().positive(), description: z.string().max(500).optional(), manifestFileName: z.string().default("appsscript") },
    annotations: destructive,
  }, wrap(async ({ scriptId, deploymentId, versionNumber, description, manifestFileName }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`), { method: "PUT", body: { deploymentConfig: { versionNumber, description, manifestFileName } } })));

  server.registerTool("apps_script_delete_deployment", {
    description: "Permanently delete a deployment and break its live URL.",
    inputSchema: { scriptId: z.string().min(1), deploymentId: z.string().min(1), confirm: z.literal(true) },
    annotations: destructive,
  }, wrap(async ({ scriptId, deploymentId }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`), { method: "DELETE" })));

  // One-shot publish: update content → create version → create (or update) deployment.
  server.registerTool("apps_script_publish", {
    description: "One-shot publish workflow: updates HEAD content (merge mode), creates a new immutable version, then creates a new deployment (or repoints an existing deploymentId). Returns the version number and deployment ID.",
    inputSchema: {
      scriptId: z.string().min(1),
      files: filesSchema.describe("Files to merge into HEAD before publishing."),
      versionDescription: z.string().max(500).optional().describe("Label for the new version."),
      deploymentDescription: z.string().max(500).optional().describe("Label for the deployment."),
      deploymentId: z.string().optional().describe("If provided, repoints this existing deployment instead of creating a new one. Use when you want to keep a stable endpoint URL."),
      manifestFileName: z.string().default("appsscript"),
    },
    annotations: destructive,
  }, wrap(async ({ scriptId, files, versionDescription, deploymentDescription, deploymentId, manifestFileName }) => {
    // 1. Merge content into HEAD.
    const enc = encodeURIComponent;
    const current = await googleRequest(scriptUrl(`/projects/${enc(scriptId)}/content`)) as { files?: Array<{ name: string; type: "SERVER_JS" | "HTML" | "JSON"; source: string }> };
    const map = new Map((current.files ?? []).map((f) => [f.name, f]));
    for (const file of files) map.set(file.name, file);
    const finalFiles = [...map.values()];
    if (!finalFiles.some((f) => f.name === "appsscript" && f.type === "JSON")) {
      throw new Error("Refusing publish: appsscript JSON manifest is required. Include it in files or ensure HEAD already has it.");
    }
    await googleRequest(scriptUrl(`/projects/${enc(scriptId)}/content`), { method: "PUT", body: { files: finalFiles } });

    // 2. Create a new version.
    const version = await googleRequest(scriptUrl(`/projects/${enc(scriptId)}/versions`), { method: "POST", body: { description: versionDescription } }) as { versionNumber?: number };
    const versionNumber = version.versionNumber;
    if (!versionNumber) throw new Error("Version creation did not return a versionNumber.");

    // 3. Create or update the deployment.
    let deployment: unknown;
    if (deploymentId) {
      deployment = await googleRequest(scriptUrl(`/projects/${enc(scriptId)}/deployments/${enc(deploymentId)}`), { method: "PUT", body: { deploymentConfig: { versionNumber, description: deploymentDescription, manifestFileName } } });
    } else {
      deployment = await googleRequest(scriptUrl(`/projects/${enc(scriptId)}/deployments`), { method: "POST", body: { versionNumber, description: deploymentDescription, manifestFileName } });
    }

    return { published: true, versionNumber, deployment };
  }));

  // ── Apps Script: runtime ───────────────────────────────────────────────────
  server.registerTool("apps_script_run_function", {
    description: "Execute a function through an API-executable deployment. The function may cause real external side effects. Requires confirm=true.",
    inputSchema: { scriptId: z.string().min(1), functionName: z.string().min(1), parameters: z.array(z.unknown()).default([]), devMode: z.boolean().default(false), confirm: z.literal(true) },
    annotations: destructive,
  }, wrap(async ({ scriptId, functionName, parameters, devMode }) => googleRequest(`https://script.googleapis.com/v1/scripts/${encodeURIComponent(scriptId)}:run`, { method: "POST", body: { function: functionName, parameters, devMode } })));

  server.registerTool("apps_script_list_processes", {
    description: "List the authenticated user's Apps Script executions with optional filters.",
    inputSchema: { pageSize: z.number().int().min(1).max(50).default(50), maxPages: z.number().int().min(1).max(100).default(20), userProcessFilter: z.string().optional() },
    annotations: readOnly,
  }, wrap(async ({ pageSize, maxPages, userProcessFilter }) => paginated(scriptUrl("/processes"), "processes", { pageSize, userProcessFilter }, maxPages)));

  server.registerTool("apps_script_list_script_processes", {
    description: "List executions for one script with optional API filter syntax.",
    inputSchema: { scriptId: z.string().min(1), pageSize: z.number().int().min(1).max(50).default(50), maxPages: z.number().int().min(1).max(100).default(20), scriptProcessFilter: z.string().optional() },
    annotations: readOnly,
  }, wrap(async ({ scriptId, pageSize, maxPages, scriptProcessFilter }) => paginated(scriptUrl("/processes:listScriptProcesses"), "processes", { scriptId, pageSize, scriptProcessFilter }, maxPages)));

  server.registerTool("apps_script_get_metrics", {
    description: "Get execution, user and failure metrics for an Apps Script project.",
    inputSchema: { scriptId: z.string().min(1), metricsGranularity: z.enum(["WEEKLY", "DAILY"]).default("WEEKLY"), deploymentId: z.string().optional() },
    annotations: readOnly,
  }, wrap(async ({ scriptId, metricsGranularity, deploymentId }) => googleRequest(scriptUrl(`/projects/${encodeURIComponent(scriptId)}/metrics`), { query: { metricsGranularity, "metricsFilter.deploymentId": deploymentId } })));

  // ── Drive: Apps Script discovery ──────────────────────────────────────────
  server.registerTool("drive_list_apps_script_projects", {
    description: "Discover Apps Script project files in Google Drive. Simpler than raw Drive queries — just pass an optional name filter.",
    inputSchema: {
      nameContains: z.string().optional().describe("Filter by project name (case-insensitive substring)."),
      pageSize: z.number().int().min(1).max(1000).default(100),
      maxPages: z.number().int().min(1).max(100).default(5),
    },
    annotations: readOnly,
  }, wrap(async ({ nameContains, pageSize, maxPages }) => {
    const clauses = ["mimeType='application/vnd.google-apps.script'", "trashed=false"];
    if (nameContains) clauses.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
    return paginated("https://www.googleapis.com/drive/v3/files", "files", {
      q: clauses.join(" and "),
      pageSize,
      fields: "nextPageToken,files(id,name,modifiedTime,createdTime,owners,webViewLink,parents)",
      orderBy: "modifiedTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }, maxPages);
  }));

  // Open in browser.
  server.registerTool("apps_script_open_editor", {
    description: "Open an Apps Script project in the system browser.",
    inputSchema: { scriptId: z.string().min(1) },
    annotations: write,
  }, wrap(async ({ scriptId }) => {
    const url = `https://script.google.com/d/${encodeURIComponent(scriptId)}/edit`;
    await open(url, { wait: false });
    return { opened: true, url };
  }));

  // Escape hatch for any Google Workspace API not covered by a dedicated tool.
  server.registerTool("google_workspace_request", {
    description: "Raw escape hatch for any Google Workspace REST API endpoint not covered by a dedicated tool. Hosts are allowlisted; Authorization is injected automatically. Non-GET requests require confirm=true.",
    inputSchema: {
      url: z.string().url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
      confirm: z.boolean().default(false),
    },
    annotations: destructive,
  }, wrap(async ({ url, method, query, body, confirm }) => {
    if (method !== "GET" && !confirm) throw new Error("Non-GET Google Workspace requests require confirm=true.");
    return googleRequest(url, { method, query, body });
  }));

  // ── Workspace tool suites ─────────────────────────────────────────────────
  registerSheetsTools(server);
  registerGmailTools(server);
  registerDriveTools(server);
  registerDocsTools(server);
  registerCalendarTools(server);
}
