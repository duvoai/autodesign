# Customer Support

Frontline support agent: triage Slack threads, search the Notion KB, draft replies, and escalate when policy requires a human.

## Try It

```bash
recipes install github:introspection-recipes/customer-support
pi --recipe customer-support
```

For local development:

```bash
recipes doctor .
recipes install .
pi --recipe customer-support
```

## What It Includes

- `agent`: support lead.
- `triage`: intent, urgency, and policy classifier.
- `responder`: KB-grounded reply drafter.
- `escalation`: human handoff and risk checker.
- `ticket-triage`: support workflow skill.

## MCP Configuration

The recipe uses MCP servers for Slack and Notion access. For local development,
`recipes install` writes `.pi/mcp.local.json` into the installed recipe if it
does not already exist. Fill in the environment variables printed by install
before launching Pi:

```bash
export SLACK_MCP_URL=http://localhost:3201/mcp
export SLACK_MCP_TOKEN=...
export NOTION_MCP_URL=http://localhost:3202/mcp
export NOTION_MCP_AUTH_TOKEN=...
pi --recipe customer-support
```

For the local Notion MCP server, set `NOTION_TOKEN` in the shell that starts the
MCP server. Set `NOTION_MCP_AUTH_TOKEN` in both the MCP server command and the
shell that launches Pi; this is the bearer token for the local MCP endpoint, not
the Notion API token.

If you want workspace-specific bindings instead, create `.pi/mcp.local.json` in
the workspace where you launch Pi and set `PI_RECIPES_MCP_LOCAL_CONFIG` to that
path. The selected recipe agent gets a session-local `mcp` command on `PATH`;
no global `mcp` binary is required.

The Slack MCP server should expose `slack_read_channel`, `slack_read_thread`,
and `slack_send_message_draft`. The Notion MCP server should expose
`API-post-search` and `API-retrieve-page-markdown`.
