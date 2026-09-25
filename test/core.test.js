import test from "node:test";
import assert from "node:assert/strict";
import { parseOAuthClient } from "../dist/auth.js";
import { assertAllowedGoogleUrl } from "../dist/google.js";
import { bearerGuard, safeEqual, SERVER_INFO } from "../dist/index.js";

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

test("constant-time token comparator handles equal and unequal lengths", () => {
  assert.equal(safeEqual("token", "token"), true);
  assert.equal(safeEqual("token", "other"), false);
  assert.equal(safeEqual("token", "longer-token"), false);
});

test("bearer guard rejects absent token and accepts the configured token", () => {
  const guard = bearerGuard("secret"); let status = 0; let next = false;
  const response = { status(value) { status = value; return this; }, set() { return this; }, json() { return this; } };
  guard({ header: () => undefined }, response, () => { next = true; }); assert.equal(status, 401); assert.equal(next, false);
  guard({ header: () => "Bearer secret" }, response, () => { next = true; }); assert.equal(next, true);
});

test("publishes the remote-ready server version", () => assert.equal(SERVER_INFO.version, "0.2.0"));
