# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is published to npm as
[`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Under the hood
it's a thin wrapper over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Using it from this repository (Claude Code)

The repo ships a project-scoped [`.mcp.json`](../.mcp.json). It starts
the local build of the server (so it includes the knowledge-base tools,
which the published npm version may not yet) and reads the secret from
your environment instead of storing it in the file:

- `WACRM_API_KEY` (required): your key from Settings → API keys.
- `WACRM_BASE_URL` (optional): defaults to `https://kompeten.my.id`.
- Writes are on (`WACRM_ENABLE_WRITES=true`). Remove that line for read-only.

One-time setup (Windows PowerShell shown):

```powershell
setx WACRM_API_KEY "wacrm_live_xxx"   # then open a NEW terminal
cd mcp-server
npm install
npm run build
```

Start Claude Code in the repo folder, approve the `wacrm` project server
when asked, and run `/mcp` to check it is connected. Rebuild
(`npm run build`) after pulling changes to `mcp-server/`.

## Quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status.
- **Writes (opt-in):** send a message, create/update a contact, add/update/delete AI knowledge-base documents (key needs `knowledge:write`).
- **Broadcasts (opt-in):** launch a template broadcast — requires an
  explicit `confirm` and is marked destructive.

## Safety

Because sending WhatsApp messages is a real side effect, the server is
**read-only until you opt in**, layered on top of the API key's own
scopes. Give an assistant a read-only key and read-only config and it
physically cannot send anything. See the
[server README](../mcp-server/README.md) for the full tool list and
safety model.
