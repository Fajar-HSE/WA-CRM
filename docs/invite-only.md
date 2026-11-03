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

## Who can connect WhatsApp

Only accounts created from an own-account invitation, plus the accounts
that existed before this was introduced. Anyone else sees a notice in
Settings → WhatsApp instead of the Connect button, and the server refuses
the request. A user cannot grant this to themselves: the database blocks
the change from any browser session.

## WAHA

Each account gets its own WAHA session (`wacrm-<account id>`). WAHA allows
unlimited sessions, so nothing extra is needed. Do **not** set
`WAHA_SESSION_NAME`: that pins every account to the same session.
