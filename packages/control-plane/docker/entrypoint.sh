#!/bin/sh
# Restores the global store from its Litestream replica when the data volume
# is empty (a fresh instance, or one rebuilt after a loss), then hands off to
# the host. LITESTREAM_BUCKET unset means no replica is configured, so a
# fresh volume simply starts empty.
#
# The replica holds the global store only. The per-session files and the
# host alarm index are not in it, so a restore brings back users, settings
# and the session index but not the sessions' own state; the whole data
# volume is the unit of a deployment backup.
set -eu

db="${DATA_DIR:-/data}/global.db"

# A WAL or journal left behind without its database would be replayed over
# whatever file appears next, restored or new; without the database they
# belong to they are meaningless, so they go first.
if [ ! -f "$db" ]; then
  for orphan in "$db-wal" "$db-shm" "$db-journal"; do
    if [ -e "$orphan" ]; then
      echo "{\"level\":\"warn\",\"event\":\"litestream.restore.orphan_removed\",\"path\":\"$orphan\"}"
      rm -f "$orphan"
    fi
  done
fi

# The same rule the host applies to its own object-store endpoint: plaintext
# only by explicit opt-in, since the endpoint carries the replica credentials.
case "${LITESTREAM_ENDPOINT:-}" in
  http://*)
    if [ "${OBJECT_STORE_ALLOW_HTTP:-}" != "true" ]; then
      echo "{\"level\":\"error\",\"event\":\"litestream.endpoint_plaintext\",\"msg\":\"LITESTREAM_ENDPOINT is plain http; set OBJECT_STORE_ALLOW_HTTP=true only for a local MinIO\"}" >&2
      exit 1
    fi
    ;;
esac

if [ -n "${LITESTREAM_BUCKET:-}" ] && [ ! -f "$db" ]; then
  echo "{\"level\":\"info\",\"event\":\"litestream.restore\",\"db\":\"$db\"}"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$db"
  if [ -f "$db" ]; then
    echo "{\"level\":\"warn\",\"event\":\"litestream.restore.global_store_only\",\"msg\":\"global store restored from its replica; session files and the host alarm index are not replicated and start empty\"}"
  fi
fi

exec "$@"
