# Changelog

User-visible changes in WA-CRM. When pulling an update, check this file for any **migration required** notes and apply the matching SQL files from `supabase/migrations/` against your Supabase project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
