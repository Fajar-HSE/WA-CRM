# Error log

Problems in the app are written to the `error_logs` table (migration 068)
and shown in **Settings → Error log** (admin and above).

## What is recorded

| Source | Where it comes from |
| --- | --- |
| `server` | Any error Next.js catches on the server (`src/instrumentation.ts`, `onRequestError`). |
| `ui` | A page crash or an uncaught browser error (`src/app/error.tsx`, `global-error.tsx`, `src/instrumentation-client.ts`). |
| `waha.webhook` | WAHA webhook processing (incoming, outgoing, groups, acks). |
| `whatsapp.send` | Sending a message failed, or saving the sent message failed. |
| `ai.auto-reply`, `ai.reindex` | AI auto-reply and knowledge-base reindexing. |
| `automations.engine` | An automation failed to run. |

Add more with `await logError('area.name', err, { accountId, context })`
from `src/lib/logging/error-log.ts`. It never throws, and it also prints to
the console, so the hosting provider's log keeps working. Always `await` it
in request handlers: a serverless function can be frozen right after the
response.

## Privacy

Before anything is stored (`src/lib/logging/sanitize.ts`):

- values under keys like key, token, secret, password, authorization, cookie are replaced;
- keys named `text`, `body`, `content`, `caption`, `payload` are never kept (customer messages);
- bearer tokens, JWTs, provider keys, e-mail addresses and 9+ digit numbers (phone numbers) are masked in text;
- URL query strings are cut;
- sizes are capped.

## Grouping

The same problem (same source, same message with numbers/ids flattened, same
top stack frame) is one row with a counter, as long as it is not marked
resolved. After "resolved", a repeat opens a new row. One server instance
writes the same problem at most 3 times a minute. Rows not seen for 60 days
are removed now and then.

## Access

- Admins read, resolve, reopen and delete the rows of their own account.
- Problems with no known account (for example a crash before login) are shown only to the platform account.
- Writing is service-role only, through `record_error_log()`.
- Browser reports need a signed-in session and are limited to 10 a minute per user.

## Deploying

Apply `supabase/migrations/068_error_logs.sql` on the database. Until it is
applied, `logError` only prints to the console (the write fails quietly) and
the Error log page shows "could not load".
