# Remote Streamable HTTP and Lovable

The server supports local `stdio` and the current MCP **Streamable HTTP** transport. Streamable HTTP can return JSON or use SSE on the same `/mcp` endpoint; the old standalone `/sse` transport is not required.

## Local

```bash
npm ci
npm run check
npm run build
node dist/index.js
```

## Remote HTTP

```bash
export MCP_TRANSPORT=http
export HOST=0.0.0.0
export PORT=3000
export MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
export MCP_ALLOWED_HOSTS="mcp.example.com"
export MCP_ALLOWED_ORIGINS="https://lovable.dev,https://www.lovable.dev"
npm run start:http
```

Endpoints:

- `POST /mcp` — JSON-RPC requests; may upgrade the response to SSE.
- `GET /mcp` — session-bound server stream.
- `DELETE /mcp` — session termination.
- `GET /healthz` — unauthenticated only when `MCP_BEARER_TOKEN` is unset; otherwise bearer-protected like all routes.

Remote binding fails closed unless `MCP_BEARER_TOKEN` is configured. Put TLS in front of the Node service and persist Google credentials on an encrypted volume. Do not deploy this CLI-dependent server to a short-lived edge runtime.

## Lovable

1. Deploy the Node service to a persistent host with HTTPS.
2. In Lovable, open **Connectors**, choose **MCP server**, and enter `https://your-host.example/mcp`.
3. Select **Bearer token or API key**, then provide `MCP_BEARER_TOKEN`.
4. Test with `Using Unified Apps Script MCP, call auth_status.`

The current Google login helper opens a browser on the MCP host and listens on that host's loopback address. That is suitable for a local desktop MCP but not a headless cloud deployment. For hosted use, provision `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` as secrets. A future multi-user edition should replace local token files with encrypted per-user storage and a public OAuth callback.
