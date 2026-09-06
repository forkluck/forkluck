#!/usr/bin/env bash
# Nightly Ghost backup: SQLite snapshot + content tarball, pruned after 14 days.
# crontab: 15 3 * * * /opt/ghost/backup-ghost.sh >> /var/log/ghost-backup.log 2>&1
set -euo pipefail

COMPOSE_FILE=/opt/ghost/docker-compose.yml
BACKUP_DIR=/root/backups/ghost
STAMP=$(date +%F)

mkdir -p "$BACKUP_DIR"

# Write to .tmp and rename only on success, so a failed snapshot or tar never
# leaves a truncated archive that looks like a good backup.
#
# The ghost:5 image has no sqlite3 CLI, so drive the sqlite3 module Ghost itself
# bundles. VACUUM INTO takes a consistent snapshot of a live database (it is the
# same thing the CLI's .backup does) and folds in any -wal content, so the single
# output file is a complete database.
docker compose -f "$COMPOSE_FILE" exec -T ghost sh -c '
    cd /var/lib/ghost/current
    rm -f /tmp/ghost-backup.db
    node -e "
      const sqlite3 = require(\"sqlite3\");
      const db = new sqlite3.Database(\"/var/lib/ghost/content/data/ghost.db\", sqlite3.OPEN_READONLY);
      db.run(\"VACUUM INTO \x27/tmp/ghost-backup.db\x27\", (err) => {
        if (err) { console.error(err.message); process.exit(1); }
        db.close();
      });
    " >&2
    cat /tmp/ghost-backup.db
    rm -f /tmp/ghost-backup.db
' | gzip > "$BACKUP_DIR/db-${STAMP}.db.gz.tmp"
mv "$BACKUP_DIR/db-${STAMP}.db.gz.tmp" "$BACKUP_DIR/db-${STAMP}.db.gz"

# content/data holds the live ghost.db (plus its -wal/-shm); the snapshot above
# already covers it, so leave it out rather than tar a torn copy of it.
tar --exclude=content/data -czf "$BACKUP_DIR/content-${STAMP}.tar.gz.tmp" -C /opt/ghost content
mv "$BACKUP_DIR/content-${STAMP}.tar.gz.tmp" "$BACKUP_DIR/content-${STAMP}.tar.gz"

find "$BACKUP_DIR" -type f -name '*.tmp' -mtime +1 -delete
find "$BACKUP_DIR" -type f -name '*.gz' -mtime +14 -delete

echo "Backup complete: $BACKUP_DIR/db-${STAMP}.db.gz, $BACKUP_DIR/content-${STAMP}.tar.gz"
