# Contributing to WA-CRM

## Run it locally

```bash
git clone https://github.com/Fajar-HSE/WA-CRM.git
cd WA-CRM
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm install
npm run dev
```

Full setup (Supabase migrations, WhatsApp Business API, deploy) lives in [`docs/`](./docs/).

## Reporting bugs / security issues

**Do not file security issues publicly.** Follow the private flow in [SECURITY.md](./.github/SECURITY.md).

For bugs, please file an issue with the commit SHA, runtime (Hostinger / Vercel / local / other), and logs.

## Pull requests

- Branch off the latest `main`.
- Run `npm run typecheck` and `npm run format` locally first.
- Fill in the PR template, especially the **Test plan**.
- One logical change per PR.
- Commit-message first line is imperative + terse; the body explains the *why*, the diff shows the *what*.

## Dev-loop reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Turbopack dev server on port 3000. |
| `npm run build` | Production build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run format` | Prettier write. |
| `npm run format:check` | Prettier in check-only mode. |

## Licensing

WA-CRM is MIT ([`LICENSE`](./LICENSE)).
