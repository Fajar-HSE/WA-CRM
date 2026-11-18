# Changelog

User-visible changes in WA-CRM. When pulling an update, check this file for any **migration required** notes and apply the matching SQL files from `supabase/migrations/` against your Supabase project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- **Reply to WhatsApp groups** (WAHA): agents and above can answer a monitored group from the Grup page, with a quote of the message being answered. Text only, from the linked number. Viewers still see the thread read-only.
- **Faster Grup page**: the group list refreshes every 10 seconds while the tab is open (it was 30) and when you return to the tab; a thread reloads only when it has a new message.
- **Unread marker for groups**: a dot on Grup in the sidebar and next to each group with new messages. It is kept per browser.
- **Clearer AI provider errors**: a rejected key now shows the HTTP status (401 or 403) and what the provider actually answered, including the text of a block page from a proxy in front of it. Before, a 403 from such a proxy looked the same as a wrong key.

No migration required.

## [1.0.0] — 2026-11-06

Initial public release of WA-CRM — a self-hostable CRM for WhatsApp.

- Shared inbox with assignment, notes, and real-time updates.
- Contacts with tags, custom fields, CSV import, and deduplication.
- Sales pipelines (Kanban) linked to conversations.
- Broadcasts with Meta-approved templates and delivery tracking.
- No-code automations and Flows with a visual builder.
- AI reply assistant (BYOK) with knowledge base and hybrid retrieval.
- Team accounts with invite-only onboarding and role-based access.
- Public REST API (`/api/v1`) with scoped API keys.
- MCP server for Claude / Cursor integration.
- WAHA + Meta Cloud API providers for WhatsApp connectivity.

> **Migration required for existing deployments:** apply new migrations in `supabase/migrations/` in order. Each migration is idempotent — safe to re-run.
