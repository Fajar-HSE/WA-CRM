# Invite-only accounts, one WhatsApp number per person

Nobody can create a login on their own. An account exists only because
an admin sent an invitation, and only accounts created that way can
connect a WhatsApp number.

## Turn off public sign-up in Supabase (required, once)

The app no longer has a sign-up form, but Supabase itself still accepts
sign-ups sent straight to its API unless you close them.

1. Supabase dashboard → **Authentication** → **Sign In / Providers**
   (older dashboards: **Providers → Email**).
2. Turn **off** "Allow new users to sign up".
3. Save.

The app creates logins on the server, which keeps working when sign-up is
off. Existing users are not affected.

## Invite someone

1. **Settings → Team members → Invite member**.
2. Pick the **invitation type**:
   - **Own account (own WhatsApp number)**: the person registers a
     separate CRM account. They see only their own conversations, and
     connect their own number in Settings → WhatsApp. This is the default.
   - **Join my team (shared inbox)**: the person joins your account and
     shares its inbox and its one WhatsApp number (the earlier behaviour).
3. Choose how long the link stays valid and press **Create link**. Copy it
   now: it is shown once.
4. Send the link. The person opens it, fills in name, email and password
   and lands in Settings → WhatsApp to scan the QR code.

An own-account invitation works **once**. The moment the person registers
the link is used up, so forwarding it gets nobody else in. An unused link
expires on its date.

## Who can create new accounts

Only the **platform account** may send an "Own account" invitation (the
accounts that existed before invitations, which includes yours). An invited
person owns their own account but can only invite teammates **into** it
("Join my team"); the "Own account" choice is not offered to them, and the
server refuses it. This stops invitations chaining from person to person.

The right is `accounts.can_create_workspaces`, set by migration 063 (accounts
that arrived through an own-account invitation do not get it). To grant or
remove it for a specific account, run in the Supabase SQL editor:

```sql
update accounts set can_create_workspaces = true where id = '<account id>';
```

Find an account id with `select a.id, a.name, p.email from accounts a join
profiles p on p.account_id = a.id where p.account_role = 'owner';`. An
own-account invitation that an ordinary account created before this rule is
refused when someone tries to use it.

## Who can connect WhatsApp

Only accounts created from an own-account invitation, plus the accounts
that existed before this was introduced. Anyone else sees a notice in
Settings → WhatsApp instead of the Connect button, and the server refuses
the request. A user cannot grant this to themselves: the database blocks
the change from any browser session.

## Listing and disabling accounts

The platform account (the one holding `can_create_workspaces`) sees an
extra **Platform → Accounts** section in Settings. It lists every account
with its owner, member count, WhatsApp status and creation date, and has a
**Disable** / **Enable** button per account. Needs migration 064.

Disabling an account:

- shows its users a "this account is disabled" screen and refuses their
  requests;
- stops its API keys and drops incoming WhatsApp messages;
- stops its WAHA session (best effort; the block works even if WAHA is down).

Nothing is deleted. **Enable** clears the flag; the account's owner then
starts the WhatsApp session again from Settings → WhatsApp.

Limits: you cannot disable your own account or another platform account
(remove its flag first), and scheduled automations are not skipped
separately for a disabled account.

## WAHA

Each account gets its own WAHA session (`wa-crm-<account id>`). WAHA allows
unlimited sessions, so nothing extra is needed. Do **not** set
`WAHA_SESSION_NAME`: that pins every account to the same session.
