import test from "node:test";
import assert from "node:assert/strict";
import { parseOAuthClient } from "../dist/auth.js";
import { assertAllowedGoogleUrl } from "../dist/google.js";

test("parses installed OAuth client JSON", () => {
  const client = parseOAuthClient({ installed: { client_id: "id", client_secret: "secret", project_id: "p" } }, "fixture");
  assert.deepEqual(client, { client_id: "id", client_secret: "secret", project_id: "p", source: "fixture" });
});

test("accepts allowlisted Google API HTTPS URL", () => {
  assert.equal(assertAllowedGoogleUrl("https://script.googleapis.com/v1/projects/x").hostname, "script.googleapis.com");
});

test("rejects non-Google and HTTP URLs", () => {
  assert.throws(() => assertAllowedGoogleUrl("https://example.com/v1"));
  assert.throws(() => assertAllowedGoogleUrl("http://script.googleapis.com/v1"));
});
