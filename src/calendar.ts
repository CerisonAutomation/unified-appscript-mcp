import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleRequest } from "./google.js";

const enc = encodeURIComponent;
const BASE = "https://www.googleapis.com/calendar/v3";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const wrap = <T extends Record<string, unknown>>(fn: (args: T) => Promise<unknown>) => async (args: T) => { try { return text(await fn(args)); } catch (e) { return failure(e); } };
const r = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const d = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const calId = z.string().min(1).default("primary").describe("Calendar ID ('primary' for the default calendar).");
const rfc3339 = z.string().describe("RFC3339 date-time string, e.g. '2025-01-15T10:00:00-05:00'.");

export function registerCalendarTools(server: McpServer): void {
  server.registerTool("calendar_list_calendars", {
    description: "List all calendars in the authenticated user's Google Calendar list.",
    inputSchema: {},
    annotations: r,
  }, wrap(async () => googleRequest(`${BASE}/users/me/calendarList`)));

  server.registerTool("calendar_list_events", {
    description: "List events on a calendar within an optional time range.",
    inputSchema: {
      calendarId: calId,
      timeMin: rfc3339.optional().describe("Start of time range (inclusive). Defaults to now."),
      timeMax: rfc3339.optional().describe("End of time range (inclusive)."),
      maxResults: z.number().int().min(1).max(2500).default(50).describe("Max events to return."),
      query: z.string().optional().describe("Free text search for events."),
      singleEvents: z.boolean().default(true).describe("Expand recurring events into individual instances."),
    },
    annotations: r,
  }, wrap(async ({ calendarId, timeMin, timeMax, maxResults, query, singleEvents }) =>
    googleRequest(`${BASE}/calendars/${enc(calendarId)}/events`, {
      query: { timeMin: timeMin ?? new Date().toISOString(), timeMax, maxResults, q: query, singleEvents, orderBy: singleEvents ? "startTime" : undefined },
    })
  ));

  server.registerTool("calendar_get_event", {
    description: "Get a single calendar event by ID.",
    inputSchema: {
      calendarId: calId,
      eventId: z.string().min(1).describe("Event ID from calendar_list_events."),
    },
    annotations: r,
  }, wrap(async ({ calendarId, eventId }) =>
    googleRequest(`${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}`)
  ));

  server.registerTool("calendar_create_event", {
    description: "Create a new Google Calendar event.",
    inputSchema: {
      calendarId: calId,
      summary: z.string().min(1).describe("Event title."),
      start: rfc3339.describe("Event start time in RFC3339 format."),
      end: rfc3339.describe("Event end time in RFC3339 format."),
      description: z.string().optional().describe("Event description / body text."),
      location: z.string().optional().describe("Event location string."),
      attendees: z.array(z.string().email()).optional().describe("List of attendee email addresses."),
      allDay: z.boolean().optional().describe("If true, start/end are treated as dates (YYYY-MM-DD) rather than datetimes."),
      conferenceType: z.enum(["hangoutsMeet"]).optional().describe("Add a Google Meet link to the event."),
    },
    annotations: w,
  }, wrap(async ({ calendarId, summary, start, end, description, location, attendees, allDay, conferenceType }) => {
    const timeField = allDay ? "date" : "dateTime";
    const body: Record<string, unknown> = {
      summary,
      start: { [timeField]: start },
      end: { [timeField]: end },
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
      ...(conferenceType ? { conferenceData: { createRequest: { requestId: Math.random().toString(36).slice(2), conferenceSolutionKey: { type: conferenceType } } } } : {}),
    };
    return googleRequest(`${BASE}/calendars/${enc(calendarId)}/events`, {
      method: "POST",
      query: conferenceType ? { conferenceDataVersion: 1 } : undefined,
      body,
    });
  }));

  server.registerTool("calendar_update_event", {
    description: "Update fields on an existing calendar event.",
    inputSchema: {
      calendarId: calId,
      eventId: z.string().min(1).describe("Event ID to update."),
      summary: z.string().optional().describe("New event title."),
      start: rfc3339.optional().describe("New start time."),
      end: rfc3339.optional().describe("New end time."),
      description: z.string().optional().describe("New description."),
      location: z.string().optional().describe("New location."),
    },
    annotations: w,
  }, wrap(async ({ calendarId, eventId, ...updates }) => {
    const patch: Record<string, unknown> = {};
    if (updates.summary !== undefined) patch["summary"] = updates.summary;
    if (updates.description !== undefined) patch["description"] = updates.description;
    if (updates.location !== undefined) patch["location"] = updates.location;
    if (updates.start !== undefined) patch["start"] = { dateTime: updates.start };
    if (updates.end !== undefined) patch["end"] = { dateTime: updates.end };
    return googleRequest(`${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: "PATCH", body: patch });
  }));

  server.registerTool("calendar_delete_event", {
    description: "Delete a calendar event. Requires confirm=true.",
    inputSchema: {
      calendarId: calId,
      eventId: z.string().min(1).describe("Event ID to delete."),
      confirm: z.literal(true).describe("Must be true to confirm deletion."),
    },
    annotations: d,
  }, wrap(async ({ calendarId, eventId }) => {
    await googleRequest(`${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: "DELETE" });
    return { deleted: true, eventId };
  }));
}
