import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import open from "open";

export const APP_CONFIG_DIR = join(homedir(), ".config", "unified-appscript-mcp");
const CLIENT_FILE = join(APP_CONFIG_DIR, "client.json");
const TOKEN_FILE = join(APP_CONFIG_DIR, "credentials.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const SCOPE_PROFILES = {
  "apps-script": [
    "openid", "email",
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/script.processes",
    "https://www.googleapis.com/auth/script.metrics"
  ],
  "workspace-read": [
    "openid", "email",
    "https://www.googleapis.com/auth/script.projects.readonly",
    "https://www.googleapis.com/auth/script.deployments.readonly",
    "https://www.googleapis.com/auth/script.processes",
    "https://www.googleapis.com/auth/script.metrics",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly"
  ],
  "workspace-full": [
    "openid", "email",
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/script.processes",
    "https://www.googleapis.com/auth/script.metrics",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/presentations"
  ]
} as const;

export type ScopeProfile = keyof typeof SCOPE_PROFILES;
export interface OAuthClient { client_id: string; client_secret?: string; project_id?: string; source?: string }
interface StoredToken { access_token: string; refresh_token?: string; expires_at: number; scope?: string; token_type?: string; email?: string }

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function atomicJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function parseOAuthClient(raw: unknown, source = "unknown"): OAuthClient {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid OAuth client JSON: ${source}`);
  const root = raw as Record<string, unknown>;
  const candidate = (root.installed ?? root.web ?? root) as Record<string, unknown>;
  if (typeof candidate.client_id !== "string" || !candidate.client_id) throw new Error(`OAuth client_id missing: ${source}`);
  return {
    client_id: candidate.client_id,
    client_secret: typeof candidate.client_secret === "string" ? candidate.client_secret : undefined,
    project_id: typeof candidate.project_id === "string" ? candidate.project_id : undefined,
    source
  };
}

async function clientFromFile(path: string): Promise<OAuthClient | undefined> {
  try { return parseOAuthClient(JSON.parse(await readFile(path, "utf8")), path); } catch { return undefined; }
}

async function newestDownloadedClient(): Promise<string | undefined> {
  const dir = join(homedir(), "Downloads");
  try {
    const names = (await readdir(dir)).filter((name) => /^client_secret_.+\.json$/i.test(name));
    const entries = await Promise.all(names.map(async (name) => ({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs })));
    return entries.sort((a, b) => b.mtime - a.mtime)[0]?.path;
  } catch { return undefined; }
}

export async function detectOAuthClient(explicitPath?: string): Promise<OAuthClient | undefined> {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) return {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    project_id: process.env.GOOGLE_CLOUD_PROJECT,
    source: "environment"
  };
  const candidates = [explicitPath, process.env.GOOGLE_OAUTH_CLIENT_JSON, CLIENT_FILE, resolve("credentials.json"), resolve("oauth-config.json"), await newestDownloadedClient()].filter((value): value is string => Boolean(value));
  for (const path of [...new Set(candidates)]) {
    if (await exists(path)) {
      const client = await clientFromFile(path);
      if (client) return client;
    }
  }
  return undefined;
}

function detectGcloudProject(): string | undefined {
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const result = execFileSync("gcloud", ["config", "get-value", "project"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return result && result !== "(unset)" ? result : undefined;
  } catch { return undefined; }
}

export async function setupOAuth(options: { clientFile?: string; openBrowser?: boolean } = {}): Promise<Record<string, unknown>> {
  const client = await detectOAuthClient(options.clientFile);
  if (client) {
    if (client.source !== "environment" && client.source !== CLIENT_FILE) await atomicJson(CLIENT_FILE, client);
    return { ready: true, clientSource: client.source, projectId: client.project_id, next: "Run auth_login." };
  }
  const project = detectGcloudProject();
  const url = project ? `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(project)}` : "https://console.cloud.google.com/auth/clients";
  if (options.openBrowser !== false) await open(url, { wait: false });
  return {
    ready: false, opened: options.openBrowser !== false, url,
    limitation: "Google does not provide a general public API for creating Desktop OAuth clients. The Cloud Console page was opened at the exact required step.",
    next: "Create a Desktop app client, download its JSON, then run auth_login. The server auto-detects client_secret_*.json in Downloads."
  };
}

async function loadToken(): Promise<StoredToken | undefined> {
  if (process.env.GOOGLE_ACCESS_TOKEN) return { access_token: process.env.GOOGLE_ACCESS_TOKEN, expires_at: Date.now() + 300_000 };
  try { return JSON.parse(await readFile(TOKEN_FILE, "utf8")) as StoredToken; } catch { return undefined; }
}

async function refresh(client: OAuthClient, refreshToken: string): Promise<StoredToken> {
  const body = new URLSearchParams({ client_id: client.client_id, refresh_token: refreshToken, grant_type: "refresh_token" });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") throw new Error(`OAuth refresh failed (${response.status}): ${JSON.stringify(data)}`);
  const token: StoredToken = { access_token: data.access_token, refresh_token: refreshToken, expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000, scope: typeof data.scope === "string" ? data.scope : undefined, token_type: typeof data.token_type === "string" ? data.token_type : "Bearer" };
  await atomicJson(TOKEN_FILE, token);
  return token;
}

export async function getAccessToken(): Promise<string> {
  const stored = await loadToken();
  if (stored?.access_token && stored.expires_at > Date.now() + 60_000) return stored.access_token;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? stored?.refresh_token;
  const client = await detectOAuthClient();
  if (!client || !refreshToken) throw new Error("Google OAuth is not connected. Run auth_setup, then auth_login.");
  return (await refresh(client, refreshToken)).access_token;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function accountEmail(token: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return undefined;
    return (await response.json() as { email?: string }).email;
  } catch { return undefined; }
}

export async function login(profile: ScopeProfile = "apps-script", timeoutSeconds = 180): Promise<Record<string, unknown>> {
  const client = await detectOAuthClient();
  if (!client) return setupOAuth({ openBrowser: true });
  if (client.source !== "environment" && client.source !== CLIENT_FILE) await atomicJson(CLIENT_FILE, client);
  const { verifier, challenge } = pkce();
  const state = randomBytes(24).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveReady()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate OAuth callback port.");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: [...SCOPE_PROFILES[profile]].join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();

  const codePromise = new Promise<string>((resolveCode, reject) => {
    const timer = setTimeout(() => reject(new Error(`OAuth callback timed out after ${timeoutSeconds} seconds.`)), timeoutSeconds * 1000);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth2/callback") { response.writeHead(404).end(); return; }
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (error || returnedState !== state || !code) {
        clearTimeout(timer);
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>Authorization failed</h1><p>Return to your MCP client.</p>");
        reject(new Error(error ?? "OAuth state/code validation failed.")); return;
      }
      clearTimeout(timer);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Google authorization complete</h1><p>You can close this page and return to your MCP client.</p>");
      resolveCode(code);
    });
  });
  await open(authUrl.toString(), { wait: false });
  try {
    const code = await codePromise;
    const body = new URLSearchParams({ client_id: client.client_id, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof data.access_token !== "string") throw new Error(`OAuth exchange failed (${response.status}): ${JSON.stringify(data)}`);
    const previous = await loadToken();
    const token: StoredToken = { access_token: data.access_token, refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh_token, expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000, scope: typeof data.scope === "string" ? data.scope : undefined, token_type: typeof data.token_type === "string" ? data.token_type : "Bearer", email: await accountEmail(data.access_token) };
    await atomicJson(TOKEN_FILE, token);
    return { connected: true, email: token.email, profile, scopes: token.scope?.split(" "), credentialFile: TOKEN_FILE };
  } finally { server.close(); }
}

export async function authStatus(): Promise<Record<string, unknown>> {
  const client = await detectOAuthClient();
  const token = await loadToken();
  let valid = false;
  let email = token?.email;
  if (client && (token?.access_token || token?.refresh_token || process.env.GOOGLE_REFRESH_TOKEN)) {
    try { const access = await getAccessToken(); valid = true; email ??= await accountEmail(access); } catch { valid = false; }
  }
  return { clientDetected: Boolean(client), clientSource: client?.source, projectId: client?.project_id, tokenDetected: Boolean(token || process.env.GOOGLE_REFRESH_TOKEN), valid, email };
}

export async function logout(): Promise<Record<string, unknown>> {
  const token = await loadToken();
  const revocable = token?.refresh_token ?? token?.access_token;
  if (revocable && !process.env.GOOGLE_ACCESS_TOKEN && !process.env.GOOGLE_REFRESH_TOKEN) {
    try { await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: revocable }) }); } catch { /* local deletion still proceeds */ }
  }
  await rm(TOKEN_FILE, { force: true });
  return { disconnected: true, note: process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN ? "Environment credentials remain active until removed from the MCP configuration." : undefined };
}

export function safeClientLabel(client?: OAuthClient): string | undefined { return client?.source ? basename(client.source) : undefined; }
