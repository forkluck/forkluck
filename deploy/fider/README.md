# Forkluck feedback deployment

This runs Fider on the existing Forkluck/Ghost host. It adds one container,
listening only on `127.0.0.1:3004`, and a dedicated PostgreSQL database and role.
It does not add a paid Fider plan or another server. The Dockerfile pins upstream
source and applies `forkluck.patch`; the upstream license remains AGPL-3.0.
The image also serves its corresponding Fider source, patch and build recipe
at `/static/assets/forkluck-fider-source.tar.gz`. The site footer links to
this download, which satisfies the AGPL source offer for visitors. The archive is assembled only from the pinned
upstream checkout, `forkluck.patch` and this Dockerfile; it contains no Django
code, service env files, credentials or production data.

Build and run the patched Fider tests before deployment. Use an isolated source
checkout, apply the patch, run `npm ci && make build-ssr`, load the upstream
`.test.env`, then run:

```sh
go test ./app/services/email/mailgun ./app/handlers/apiv1 ./app/handlers \
  -run 'TestGetBaseURL|TestDeleteUserByProvider|TestCreateUser|TestSignInByEmail' -count=1
docker build --platform linux/amd64 -t forkluck-feedback:<release> deploy/fider
```

Only the build context under `deploy/fider` is sent to Docker. No app data,
production credentials, marketing content, or Django source enters the image.
Stage the tested image on the existing production host. Pin `FIDER_IMAGE` in
`/opt/forkluck-feedback/.env` to its immutable image ID. This is a separate
release from the Django/Next deployment; keep the previous image for rollback.

## Install and configure

1. Copy `docker-compose.yml`, `bootstrap.py` and `backup.sh` into `/opt/forkluck-feedback`.
2. Create a dedicated `forkluck_feedback` PostgreSQL role and database; generate
   a strong random password. The role must not own or access application data.
3. Put these values in `/opt/forkluck-feedback/.env`, owned by root, mode 600:
   `FIDER_IMAGE`, `FIDER_DATABASE_URL`, `FIDER_JWT_SECRET`, `FIDER_EMAIL_FROM`,
   `BRIDGE_API_KEY`, `FORKLUCK_FEEDBACK_CLIENT_SECRET`, and
   `FORKLUCK_FEEDBACK_API_KEY`. Generate the last two independently with
   `secrets.token_urlsafe(48)`. Use the existing verified Forkluck sender and Ghost
   bridge key. The database URL reaches loopback, not a public database port.
4. Apply the loopback port mapping from `deploy/ghost/docker-compose.yml` to
   the existing bridge API service, and recreate only that service. Confirm
   `http://127.0.0.1:3003/health` reports the Azure provider and healthy queues.
5. Run Fider migrations and bootstrap the Forkluck board. Keep it public,
   remove the logo, copy the existing welcome/submission guidance and backlink,
   and enable the built-in roadmap. Self-hosted Fider includes roadmap support.
6. Provision a separate service administrator without a mailbox, and store its
   API key securely. Give the existing Forkluck owner administrative access.
   Configure `_forkluck` as the sole visitor OAuth provider with the URLs below.
   After migrations, `/opt/forkluck/shared/venv/bin/python
   /opt/forkluck-feedback/bootstrap.py` performs steps 5–6 on an empty database.
   It requires exactly one active Django superuser, binds that existing owner,
   and refuses to overwrite an existing board. Values come from the root-only
   service env files; the script never prints credentials or account data.
7. Deploy the app release through its normal GitHub Actions workflow. Add
   `FORKLUCK_FEEDBACK_CLIENT_SECRET` (minimum 32 characters),
   `FORKLUCK_FEEDBACK_API_KEY` (service administrator), and
   `FORKLUCK_FEEDBACK_ORIGIN=https://feedback.forkluck.com` to the backend env
   only when the feedback service and routing are ready, then restart Django.
   Configure `FORKLUCK_MAIL_BRIDGE_URL=http://127.0.0.1:3003/v3/forkluck.com/messages`
   and `FORKLUCK_MAIL_BRIDGE_API_KEY` with the same bridge key to route all
   Django verification, invitation and notification mail through Ghost's
   delivery infrastructure. These two mail settings can be activated before
   the feedback DNS cutover.

Provider configuration:

| Field | Value |
| --- | --- |
| Provider / display name | `_forkluck` / `Forkluck` |
| Client ID | `forkluck-feedback` |
| Client secret | Same confidential secret as Django |
| Authorize URL | `https://app.forkluck.com/api/auth/feedback/authorize` |
| Token URL | `https://app.forkluck.com/api/auth/feedback/token` |
| Profile URL | `https://app.forkluck.com/api/auth/feedback/profile` |
| Scope | `profile` |
| JSON ID / name / email | `id` / `name` / `email` |
| Callback | `https://feedback.forkluck.com/oauth/_forkluck/callback` |

Keep email auth disabled for visitors; Fider retains an owner recovery path.
The patch also enforces this on the public email-registration endpoint.
Do not enable Google/Facebook/GitHub alongside Forkluck for visitors, because
those identities could bypass the owning Django account.
The dialog backdrop must not have `aria-disabled`: that state propagates to
the idea editor and incorrectly disables its controls for assistive technology.

## Branding

The patch also gives the board the marketing site's look, so no Custom CSS is
needed in Fider's Advanced settings; leave that field empty. The Forkluck
neutrals and the `#3273dc` accent replace Fider's palette, the page background
is white, the header loses its border and takes the marketing wordmark and
link sizes, and the dark-theme toggle is gone because the marketing site has
no dark mode. The "Powered by Fider" badge and version line are replaced by a
site footer that mirrors `forkluck-marketing/theme/partials/forkluck-footer.hbs`:
wordmark and blurb linking to `forkluck.com`, the Product and Account columns,
and a bar with Privacy, Terms, the source archive link and a small "Powered by
Fider" credit. Fider self-hosts Inter and its content security policy blocks
external fonts, which is why the branding lives in the patch rather than in
Custom CSS. The favicon is the marketing logo, copied to `favicon.png` here and installed
by the Dockerfile; keep the board's own logo empty so the header stays a
wordmark. The footer links are constants at the top of
`public/components/common/Footer.tsx` in the patch; change them there when a
marketing URL moves.

## Cutover and acceptance

Confirm the hosted board has no new content to migrate before switching DNS.
Keep the hosted board available as a rollback until self-hosted acceptance is
complete. Point the DNS-only `feedback` CNAME at `forkluck.com`, install the
feedback nginx server block, and obtain a certificate using the existing
Certbot webroot flow. Its renewal must work unattended; install a deploy hook
to reload nginx. Never expose port 3004 or the mail bridge publicly.

If the initial certificate was issued manually using DNS validation, switch
the saved renewal method and verify it with Certbot's simulated renewal:

```sh
certbot reconfigure --cert-name feedback.forkluck.com \
  --webroot --webroot-path /var/www/forkluck --preferred-challenges http \
  --deploy-hook 'systemctl reload nginx' --non-interactive
```

After acceptance, make the unused hosted board private, remove its custom
domain binding and point its welcome message at the live board. Keep its
existing owner recovery provider; private access prevents new public signups.

Verify existing-account sign-in, new-account signup/verification continuation,
unchanged linked identity across repeated sign-ins, rejection of foreign and
expired credentials, provider-scoped deletion, an actual feedback email in the
existing mail queue/delivery events, and working unsubscribe links. Confirm
the marketing, app and feedback hosts all answer over HTTPS. Remove only the
synthetic acceptance content/users created for verification.

The board's independent OAuth session behavior and boundary matrix are in
`docs/FEEDBACK.md`. Public discussion stays in Fider; private kitchen data never
enters the board.

## Backup and rollback

Run `backup.sh` as root and install it daily. It keeps compressed PostgreSQL
dumps and a root-only copy of service configuration for 14 days. Test restore
in an isolated database before relying on the backup. Retain the app's normal
backup separately; this script owns only the feedback database and service files.

For a container rollback, restore the previous image ID in `.env` and run
`docker compose up -d`; confirm migration compatibility before downgrading.
For a failed initial cutover, restore the hosted board's custom domain and
public access, point DNS back to `forkluck.fider.io`, and disable the Django
feedback configuration until the self-hosted service is repaired.
Do not delete either database or release the hosted name as part of rollback.
