#!/bin/sh
# Restores the global store from its Litestream replica when the data volume
# is empty (a fresh instance, or one rebuilt after a loss), then hands off to
# the host. LITESTREAM_BUCKET unset means no replica is configured, so a
# fresh volume simply starts empty.
set -eu

db="${DATA_DIR:-/data}/global.db"
if [ -n "${LITESTREAM_BUCKET:-}" ] && [ ! -f "$db" ]; then
  echo "{\"level\":\"info\",\"event\":\"litestream.restore\",\"db\":\"$db\"}"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$db"
fi

exec "$@"
