#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir=/root/backups/forkluck-feedback
install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.dump.XXXXXX")
trap 'rm -f "$temporary"' EXIT
runuser -u postgres -- pg_dump forkluck_feedback | gzip > "$temporary"
mv "$temporary" "$backup_dir/db-$stamp.sql.gz"
tar -czf "$backup_dir/config-$stamp.tar.gz" -C /opt/forkluck-feedback \
  .env docker-compose.yml
find "$backup_dir" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'config-*.tar.gz' \) -mtime +14 -delete
