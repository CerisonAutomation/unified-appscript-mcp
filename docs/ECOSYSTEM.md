# Apps Script MCP ecosystem research

Search date: 2026-09-26. GitHub search returned 33 repositories for `Google Apps Script MCP server`. This project is an original clean implementation informed by public feature descriptions and official APIs; it does not vendor or copy upstream source.

## Primary references

| Repository | Distinct capability considered |
|---|---|
| tanaikech/ggsrun | Secure execution sandbox, Drive CLI and high-throughput operations |
| tanaikech/ToolsForMCPServer | Apps Script-hosted MCP tool patterns |
| tanaikech/MCPApp | MCP feasibility directly on Apps Script |
| tanaikech/TriggerApp | Time-driven trigger management |
| tanaikech/gas-fakes-mcp | Local GAS emulation and dynamic tools |
| Artoxem/yet-another-google-mcp | Multi-service Workspace tools, dry-run and destructive confirmations |
| redmorestudio/clasp-enhanced-mcp | clasp lifecycle and version support |
| sputnicyoji/google-workspace-mcp-with-script | Docs, Sheets, Drive, Gmail, Calendar and Apps Script breadth |
| tanaikech/adk-gas | Agents, A2A, HITL and quota safeguards |
| whichguy/gas_mcp | Rich project/file/deploy workflow, CommonJS and Git sync |
| tanaikech/Next-Level-Google-Apps-Script-Development | Local development and testing with gas-fakes |
| redmorestudio/google-apps-script-mcp | OAuth-backed Apps Script API access |
| redmorestudio/google-apps-script-mcp-improved | Parsing and error-handling fixes |
| tanaikech/Consolidating-Generative-AI-Protocols-A-Single-Server-Solution-for-MCP-and-A2A | Unified MCP and A2A server concept |
| joe-broadhead/workspace-lite | Apps Script proxy access to Drive, Gmail, Calendar, Sheets, Slides, Docs, Tasks and Forms |
| abcreativ/google-suite-mcp | Broad Workspace read/write and live API testing |
| tanaikech/MCPA2Aserver-GAS-Library | Reusable MCP/A2A Apps Script library |
| A1-x-Tech/mcp-google-apps-script | Modern Apps Script lifecycle, PKCE loopback auth and safe manifest merge |
| OLUYEMIOPEYEMI7/apps-script-mcp-server | stdio and hosted HTTP transports |
| odise444/google-tasks-mcp-server | Tasks through an Apps Script webhook |
| suraaj-rajeev/gsheet-mcp-server | Sheets plus Apps Script automation |
| agenticledger/appsscript-mcp-http | Streamable HTTP and dual-mode auth |
| overdozer1124/gas-mcp-server-v2 | Enhanced authentication |
| overdozer1124/gas-mcp-server-fixed | Expanded execution scopes |
| RLASAF12/gas-mcp-server | List, read, edit, deploy and execute workflow |
| LeooNic/gworkspace-mcp | Sheets, Apps Script, Drive, Docs and Gmail |
| waynelin-yuzhi/gas-mcp-bridge | Bridge from Apps Script web apps to MCP clients |
| koboshchan/docspatcher | Style-preserving Docs patches through a bridge |

## Search noise and duplicates

The result set also contained forks, static documentation sites and repositories where Apps Script was incidental rather than the MCP's core. Those were catalogued but not treated as independent architectural references: `Macorreag/MCPApp`, `AnkitOhlan/ankitohlan.github.io`, `stgw14/plentyone-tools`, `a2uicatalog/a2ui`, and the redmorestudio/overdozer variants already represented above.

## Adopted design

- Original TypeScript implementation on the official MCP SDK.
- Direct official REST APIs instead of importing multiple overlapping servers.
- Dedicated tools for high-risk Apps Script lifecycle operations.
- Allowlisted generic Workspace gateway for long-tail API coverage without hundreds of duplicate wrappers.
- Browser-first PKCE authentication with automatic local credential discovery.
- Explicit confirmation at destructive boundaries.
- Drive discovery to compensate for Apps Script API's inability to list projects.

## Deliberately excluded

- Browser automation of Google Cloud Console: brittle, unsafe and blocked by authentication controls.
- Silent creation of OAuth clients: no general public Google API supports creating Desktop OAuth clients.
- Source-code aggregation: upstream licenses and maintenance quality vary; clean implementation avoids provenance and dependency conflicts.
- Automatic retries of writes or function execution: ambiguous failures could duplicate irreversible effects.
