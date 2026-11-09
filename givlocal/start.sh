#!/bin/sh
# Start GivLocal. Local dashboard: http://localhost:8080
# If upload.conf exists (GIV_UPLOAD_URL / GIV_UPLOAD_TOKEN), readings are also uploaded to the hosted dashboard.
cd "$(dirname "$0")"
[ -f upload.conf ] && set -a && . ./upload.conf && set +a
exec python3 -u app.py --inverter "${GIV_HOST:-192.168.1.50}" "$@"
