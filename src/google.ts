import { getAccessToken } from "./auth.js";

const ALLOWED_HOSTS = new Set([
  "script.googleapis.com", "www.googleapis.com", "sheets.googleapis.com", "docs.googleapis.com",
  "gmail.googleapis.com", "calendar.googleapis.com", "tasks.googleapis.com",
  "forms.googleapis.com", "slides.googleapis.com", "drive.googleapis.com"
]);

export class GoogleApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) { super(message); }
}

export function assertAllowedGoogleUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) throw new Error(`Google API host is not allowlisted: ${url.hostname}`);
  if (url.username || url.password) throw new Error("Credentials in URLs are forbidden.");
  return url;
}

export async function googleRequest(input: string, options: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<unknown> {
  const url = assertAllowedGoogleUrl(input);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const token = await getAccessToken();
  const method = (options.method ?? "GET").toUpperCase();
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(60_000)
  });
  const responseText = await response.text();
  let data: unknown = { ok: true, status: response.status };
  if (responseText) { try { data = JSON.parse(responseText); } catch { data = responseText; } }
  if (!response.ok) throw new GoogleApiError(response.status, data, `Google API request failed (${response.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

export function scriptUrl(path: string): string { return `https://script.googleapis.com/v1${path.startsWith("/") ? path : `/${path}`}`; }

export async function paginated(url: string, itemKey: string, query: Record<string, unknown> = {}, maxPages = 20): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const response = await googleRequest(url, { query: { ...query, pageToken } }) as Record<string, unknown>;
    const pageItems = response[itemKey];
    if (Array.isArray(pageItems)) items.push(...pageItems);
    pageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);
  return { [itemKey]: items, pages, nextPageToken: pageToken };
}
