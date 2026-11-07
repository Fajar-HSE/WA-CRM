# Kompeten CRM — WhatsApp CRM with AI for sales and service teams

> Self-hostable CRM for WhatsApp® — shared inbox, contacts, sales pipelines, broadcasts, and no-code automations.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)

## What you get out of the box

- **Shared inbox** on the WhatsApp Business API — multiple agents working one number, per-conversation assignment, status, and notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new contacts, keywords, or schedule; conditional branches, waits, tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI or Anthropic key (stored encrypted; no per-seat AI fee, your data stays yours). One-click AI-drafted replies in the inbox, plus an optional auto-reply bot with a per-conversation cap and clean human handoff. Add a **knowledge base** (FAQs, policies, product docs) and it answers from your own content — hybrid retrieval (Postgres full-text, or semantic pgvector when an embeddings key is set).
- **Real-time dashboard** — response times, daily volume, pipeline value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access (owner / admin / agent / viewer), ownership transfer. Every install is account-scoped, so one shared inbox can be staffed by a whole team. Solo use stays single-user with zero setup.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys — build your own automations on top of your CRM. See [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive your CRM from Claude, Cursor, and other AI assistants over the [Model Context Protocol](https://modelcontextprotocol.io). Read-only by default, opt-in writes. See [docs/mcp.md](./docs/mcp.md) (server in [`mcp-server/`](./mcp-server)).

## Quick start

```bash
git clone https://github.com/Fajar-HSE/WA-CRM.git
cd WA-CRM
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or `/dashboard` if already signed in).

The UI ships in Bahasa Indonesia (default) and English. Each user can switch in **Settings → Appearance**; `NEXT_PUBLIC_APP_LOCALE` (`id` or `en`) sets the default for new visitors (catalogues live in `messages/`). WhatsApp is connected through WAHA — see [docs/waha.md](./docs/waha.md). Accounts are created by invitation only — see [docs/invite-only.md](./docs/invite-only.md).

Prefer containers? See [docs/docker.md](./docs/docker.md) for the Dockerfile + Docker Compose setup.

## Documentation

- [WhatsApp connection troubleshooting](./docs/whatsapp-connection-troubleshooting.md) — what each "Save Configuration" error means, and the Meta code / trace id to quote to Meta support
- [Several WABAs on one deployment](./docs/multi-waba.md) — one Meta App or several; how `META_APP_SECRET` takes a comma-separated list
- [Auth emails](./docs/auth-emails.md) — what Supabase must allow so confirmation and password-reset links come back to *your* domain instead of `localhost:3000`, and how `/auth/callback` handles them
- [Public API](./docs/public-api.md) / [MCP](./docs/mcp.md) / [Docker](./docs/docker.md) / [Invite-only](./docs/invite-only.md)

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API) + WAHA bridge.

## Contributing

Bug reports and security issues are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`.github/SECURITY.md`](./.github/SECURITY.md).

## License

[MIT](./LICENSE).
