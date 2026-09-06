# Feedback accounts and email

`feedback.forkluck.com` runs self-hosted Fider. The marketing site links to it
and the board links back. Django owns the account; Fider owns public ideas,
votes, comments, and feedback-specific notification preferences.

## Sign in

The only visitor provider is **Forkluck** (`_forkluck`). It uses the existing
app login, registration and email verification screens. Login and signup carry
the local `next` path through verification. API continuations use a document
navigation so Django can return the browser to Fider. No second password or
visitor registration is required. Fider automatically stores a linked profile.
The patched email-registration endpoint respects the disabled-email setting;
only an existing administrator retains Fider's email recovery path.

The confidential client is `forkluck-feedback`, with scope `profile` and the
exact callback `https://feedback.forkluck.com/oauth/_forkluck/callback`.
The three public Django endpoints are under `/api/auth/feedback/`:
`authorize` (GET), `token` (POST form, HTTP Basic or form client credentials),
and `profile` (GET bearer token). Profile contains only stable Django UUID,
public display name, and verified email. Tokens grant no access to app data.

Codes and access tokens expire after two minutes. Only their SHA-256 digests
are stored. Code redemption locks the row; a replay revokes its access token.
Account deletion cascades grants; disabled/unverified accounts and changed
passwords cannot redeem grants or use profile tokens. Fider sessions are
host-only and independent of app sessions, as with a normal OAuth relying
party; signing out of one site does not sign out of the other.

## Mail

Fider sends to the existing Ghost mail bridge on loopback port 3003. The bridge
persists and queues delivery, sends through Azure, and records delivery events
in the existing mail dashboard. Feedback unsubscribe links continue to manage
Fider preferences. Ghost newsletter subscriptions remain separate: opting out
of newsletters must not alter feedback preferences or account verification.

Ghost continues to compose newsletters. Django's verification, password-reset,
invitation and notification mail also uses this bridge. Configure its messages
URL and API key in Django; direct Azure remains available for other self-hosted
installations. A bridge failure never falls back to a second sender, because
the original message may already be queued. Messages remain transactional;
they do not become newsletter posts or subscribe voters to newsletters.

## Account lifecycle

OAuth resolves the same verified Django UUID on every sign-in. Fider matches
an existing email only when linking this trusted provider. App email is not
editable, so the stable provider identity is never repointed by a profile edit.
Name edits do not change identity. Feedback profiles can keep their public
display name. No recipe, invoice, catalog, or kitchen data enters Fider.

The Django account-deletion flow first invokes Fider's authenticated,
administrator-only `DELETE /api/v1/users/by-provider/_forkluck/<uuid>`.
The published patch scopes lookup to the board, uses Fider's existing erasure
operation, and treats an absent profile as success. It removes personal data,
provider bindings, subscriptions and votes while retaining anonymized public
discussion. Failure leaves the Django account available for retry. A separate
service administrator owns the API key so deleting a user cannot delete the
credential required for subsequent removals. Fider's own Delete account action
removes only the feedback profile; signing in later links a new profile.

## Invariant matrix

| Boundary | Cases and required outcome |
| --- | --- |
| Syntax | Exact client, callback, code response and profile scope; reject duplicates, foreign/modified callbacks, missing state and other grant types without redirecting |
| Identity | Existing or new verified account reuses its UUID; signed-out/legacy unverified session reaches app login; inactive/unverified/deleted user gets no usable grant |
| Precedence | Authenticate confidential client before code lookup; reject mixed Basic/form credentials; browser cookies never authenticate token/profile |
| Lifecycle | One atomic redemption, expiry, replay revocation, password change, account disable/delete, idempotent remote erasure and retry on provider failure |
| Navigation | Login ↔ signup ↔ verification retains a safe local path; reject external, protocol-relative, backslash and control-character destinations |
| Data | Only UUID, bounded public name and verified email reach Fider; profile tokens cannot authorize app reads or writes |
| Email | Fider and Django messages use bridge delivery; missing/unsafe configuration fails at startup, ambiguous sends do not fall back or duplicate; feedback preferences and newsletter consent remain independently owned |

Deployment, backup and rollback are described in `deploy/fider/README.md`.
