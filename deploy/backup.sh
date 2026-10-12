#!/bin/sh
# Nightly pg_dump (custom format) into /backups, keeping BACKUP_KEEP_DAYS days. Copying /backups off the
# server (rclone, restic, provider snapshots) is the owner's choice of off-site target (roadmap Phase 0).
set -eu
while true; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  pg_dump --format=custom --file="/backups/ace-${stamp}.dump.partial"
  mv "/backups/ace-${stamp}.dump.partial" "/backups/ace-${stamp}.dump"
  find /backups -name 'ace-*.dump' -mtime "+${BACKUP_KEEP_DAYS:-14}" -delete
  echo "backup ace-${stamp}.dump written"
  sleep 86400
done
