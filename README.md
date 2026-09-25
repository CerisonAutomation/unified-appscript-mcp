# Unified Apps Script MCP

One production-oriented MCP server for the full Google Apps Script lifecycle plus an allowlisted Google Workspace REST gateway. It synthesizes the strongest patterns found across the public Apps Script MCP ecosystem without copying their source.

## What it combines

- Apps Script project creation, metadata, HEAD content, merge-safe updates, immutable versions, deployments, rollback, execution, process history and metrics.
- Drive-based Apps Script project discovery, which fills the Apps Script API's project-listing gap.
- Google Workspace coverage through a guarded REST gateway for Sheets, Docs, Drive, Gmail, Calendar, Tasks, Forms and Slides.
- Automatic OAuth discovery, browser launch, PKCE, one-shot loopback callback, secure token refresh and revocation.
- MCP safety annotations plus explicit `confirm=true` boundaries for deployment deletion, function execution and generic non-GET requests.
- Automatic pagination for list tools.

## OAuth behavior

1. Call `auth_status`.
2. Call `auth_setup`. It searches environment variables, `GOOGLE_OAUTH_CLIENT_JSON`, the private config directory, project-root credential files and the newest `client_secret_*.json` in Downloads.
3. If no Desktop OAuth client exists, the server opens Google Auth Platform's Clients page. Google does not expose a general public API that can create a Desktop OAuth client, so this one console action cannot be safely automated.
4. Create a **Desktop app** client and download its JSON. No path is normally needed because Downloads is auto-detected.
5. Call `auth_login`. The system browser opens immediately; the server uses PKCE and receives the callback on a random `127.0.0.1` port.

Tokens and imported client configuration are stored under `~/.config/unified-appscript-mcp/` with owner-only permissions.

## Install

```bash
npm install
npm run build
```

### Claude Code

```bash
claude mcp add --transport stdio --scope user unified-appscript -- node /absolute/path/unified-appscript-mcp/dist/index.js
```

### Cursor / Claude Desktop

```json
{
  "mcpServers": {
    "unified-appscript": {
      "command": "node",
      "args": ["/absolute/path/unified-appscript-mcp/dist/index.js"]
    }
  }
}
```

## Tool catalog

| Group | Tools |
|---|---|
| Authentication | `auth_status`, `auth_setup`, `auth_login`, `auth_logout` |
| Projects and code | `apps_script_create_project`, `apps_script_get_project`, `apps_script_get_content`, `apps_script_update_content`, `apps_script_open_editor` |
| Versions | `apps_script_create_version`, `apps_script_list_versions`, `apps_script_get_version` |
| Deployments | `apps_script_list_deployments`, `apps_script_get_deployment`, `apps_script_create_deployment`, `apps_script_update_deployment`, `apps_script_delete_deployment` |
| Runtime | `apps_script_run_function`, `apps_script_list_processes`, `apps_script_list_script_processes`, `apps_script_get_metrics` |
| Workspace | `drive_list_apps_script_projects`, `google_workspace_request` |

## Security model

- Google API calls use HTTPS and an explicit host allowlist.
- OAuth state and PKCE protect the local authorization flow.
- Secrets never appear in tool responses.
- Credential files use mode `0600`; their directory uses `0700`.
- Project writes preserve unmentioned files by default and refuse to lose `appsscript.json`.
- Writes are not automatically retried, preventing duplicate versions, deployments or executions.
- Destructive operations require an explicit confirmation parameter and remain subject to the MCP client's approval UI.

## Validation

```bash
npm run check
```

CI runs type checking, compilation and tests on Node.js 20 and 22.

## Research

See [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md) for the repository inventory and the capability synthesis used in this implementation.

## License

MIT. See [LICENSE](LICENSE).
