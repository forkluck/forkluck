# Ghost on chefclaw

Ghost 5 on SQLite in Docker Compose, behind the host nginx, sending through
Azure Communication Services SMTP (provisioned by `deploy/azure/mail.sh`). The
database is a single file at `content/data/ghost.db`, which is all a 2 GB server
needs; MySQL is the later upgrade.

This file covers the server. The site's own content — pages, theme, routes,
preview loop for editing it.

## Install (Ubuntu 24.04)

Docker CE from Docker's own apt repo — the distro `docker.io` package is too old
for `docker compose`:

```sh
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Then lay out the stack and start it:

```sh
mkdir -p /opt/ghost/{content,static,bridge}
# copy docker-compose.yml, .env.example, backup-ghost.sh into /opt/ghost
cp /opt/ghost/.env.example /opt/ghost/.env   # fill in every value
chmod 600 /opt/ghost/.env
chmod +x /opt/ghost/backup-ghost.sh
docker compose -f /opt/ghost/docker-compose.yml up -d
```

Smoke test without DNS, since Ghost answers on the `url` host:

```sh
curl -H 'Host: forkluck.com' http://127.0.0.1:2368/
```

## Preview-host trick

Ghost bakes `url` into rendered links, so bring the site up on a throwaway host
first: set `GHOST_URL=https://preview.forkluck.com` in `.env`, point that
subdomain at chefclaw, and build out the site there. At cutover flip `.env` to
`GHOST_URL=https://forkluck.com` and `docker compose up -d` to recreate the
container. Anything Ghost stored with the preview host in it (absolute links in
posts, uploaded image URLs) needs a find-and-replace in the database, so keep
editorial links relative until the flip.

## Backups

`backup-ghost.sh` writes `db-YYYY-MM-DD.db.gz` and `content-YYYY-MM-DD.tar.gz`
into `/root/backups/ghost` and deletes anything older than 14 days. Install the
cron line in the script's header comment. The database snapshot is taken with
`VACUUM INTO` against the live file, so it is consistent without stopping Ghost;
the content tarball excludes `content/data` because the snapshot already has it.

## Restore

```sh
docker compose -f /opt/ghost/docker-compose.yml stop ghost
tar -xzf /root/backups/ghost/content-YYYY-MM-DD.tar.gz -C /opt/ghost
rm -f /opt/ghost/content/data/ghost.db-wal /opt/ghost/content/data/ghost.db-shm
gunzip -c /root/backups/ghost/db-YYYY-MM-DD.db.gz > /opt/ghost/content/data/ghost.db
docker compose -f /opt/ghost/docker-compose.yml start ghost
```

Restore the content tarball and the snapshot from the same date: images
referenced by posts live in `content/`, not in the database.

## Upgrading to MySQL later

There is no in-place switch; move the data through Ghost's own export. In the
old site: Settings -> Labs -> Export your content (JSON), and Members -> export
the member list as CSV. Copy `content/images` (and any custom theme) across.
Stand up a Ghost pointed at MySQL, then import the JSON under Settings -> Labs
and the members CSV under Members. Re-enter integration keys and mail settings,
which the export deliberately leaves out.

## Newsletter bridge

The bridge keeps its own SQLite file in `/opt/ghost/bridge`, so there is nothing
to provision first: uncomment the two `ghost-mail-bridge` services and the
`bulkEmail__` block, set `BRIDGE_API_KEY` in `.env`, and bring the stack up.

Site content (theme, pages, posts) lives in the `forkluck-marketing` repo and is published with its `setup.mjs`.
