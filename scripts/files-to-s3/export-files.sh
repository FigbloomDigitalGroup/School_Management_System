#!/bin/bash
# Runs ON the schools database server (files-to-s3.ps1 -Step export sends it through SSM Run Command).
#
# Copies every stored file out of this server's Supabase Storage into the server's own backups bucket, under
# files-export/<bucket>/<path>, keeping its content type, cache setting and uploader (x-amz-meta-owner, which the files API
# reads when someone deletes a chat file they sent). files-to-s3.ps1 -Step copy then copies them into the S3 buckets
# the files API uses: the server itself has no access to those, only to its backups bucket.
#
# Each file is read through the server's own storage API (as copy-cloud-files.sh in figbloom-platform does), so this
# doesn't depend on how storage lays files out on disk. One file at a time, on the data disk, never held in memory.
# Safe to run again: it overwrites what it exported before. Nothing in Supabase Storage is changed.
#
#   BACKUPS_BUCKET=<SchoolsDatabase-<env> output BackupsBucket> bash export-files.sh
set -euo pipefail
: "${BACKUPS_BUCKET:?set BACKUPS_BUCKET}"
dir=/data/supabase
region=$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" \
  http://169.254.169.254/latest/meta-data/placement/region)
key=$(grep '^SERVICE_ROLE_KEY=' "$dir/.env" | head -n1 | cut -d= -f2-)
[ -n "$key" ] || { echo "No SERVICE_ROLE_KEY in $dir/.env"; exit 1; }
here="http://localhost:8000/storage/v1/object/authenticated"
db() { docker exec -i supabase-db psql -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 "$@"; }
# The key goes to curl through a config on stdin, never on its command line (ps would show it)
headers() { printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$key" "$key"; }

total=$(db -c "select count(*) from storage.objects")
echo "files_to_export=$total"

work=$(mktemp -d -p /data)
trap 'rm -rf "$work"' EXIT
ok=0; failed=0; bytes=0
while IFS=$'\t' read -r bucket name type cache owner; do
  encoded="$bucket/$(jq -rn --arg n "$name" '$n | split("/") | map(@uri) | join("/")')"
  if ! headers | curl -fsS -K - --retry 3 --retry-delay 5 --retry-all-errors -o "$work/f" "$here/$encoded"; then
    echo "read_failed $bucket/$name"; failed=$((failed + 1)); continue
  fi
  meta=()
  [ -n "$owner" ] && meta=(--metadata "owner=$owner")
  if aws s3 cp --only-show-errors --region "$region" "$work/f" "s3://$BACKUPS_BUCKET/files-export/$bucket/$name" \
      --content-type "${type:-application/octet-stream}" --cache-control "${cache:-max-age=3600}" "${meta[@]}"; then
    ok=$((ok + 1)); bytes=$((bytes + $(stat -c %s "$work/f")))
  else
    echo "upload_failed $bucket/$name"; failed=$((failed + 1))
  fi
  rm -f "$work/f"
done < <(db -F $'\t' -c "select bucket_id, name, coalesce(metadata->>'mimetype', ''), coalesce(metadata->>'cacheControl', ''),
                                coalesce(owner::text, owner_id, '')
                           from storage.objects order by bucket_id, name")

echo "per_bucket:"; db -F ' ' -c "select '  ' || bucket_id, count(*), pg_size_pretty(sum(coalesce((metadata->>'size')::bigint, 0))) from storage.objects group by 1 order by 1"
echo "exported=$ok failed=$failed bytes=$bytes"
[ "$failed" = 0 ] || exit 1
