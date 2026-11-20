#!/usr/bin/env bash
# Upload the built PWA to a Bunny storage zone through the S3 API, then prune
# old assets. Usage: upload-bunny.sh <dist dir>
#
# Needs BUNNY_STORAGE_ZONE, BUNNY_S3_ENDPOINT, PUBLIC_URL (the host that
# serves the zone, for example https://app.btree.at) and the AWS_* credentials.
# ASSET_KEEP_DAYS (default 30) sets how long the assets of a replaced version
# stay available for clients that still run it.
set -euo pipefail

: "${BUNNY_STORAGE_ZONE:?BUNNY_STORAGE_ZONE is required}"
: "${BUNNY_S3_ENDPOINT:?BUNNY_S3_ENDPOINT is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"
dist="${1:?Pass the built PWA directory}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
keep_days="${ASSET_KEEP_DAYS:-30}"
bucket="s3://${BUNNY_STORAGE_ZONE}"

test -s "${dist}/index.html"
test -s "${dist}/sw.js"
test -d "${dist}/assets"

s3() {
  aws s3 "$@" --endpoint-url "${BUNNY_S3_ENDPOINT}" --only-show-errors
}

# Print the keys under a prefix, one per line. A failed listing stops the
# script, so prune never runs on a partial list.
list_keys() {
  aws s3api list-objects-v2 --bucket "${BUNNY_STORAGE_ZONE}" --prefix "$1" \
    --endpoint-url "${BUNNY_S3_ENDPOINT}" --query 'Contents[].Key' \
    --output text > "${work}/listing"
  tr '\t' '\n' < "${work}/listing" | { grep -v -e '^None$' -e '^$' || true; }
}

# Print the built assets that the storage listing or the public host does
# not have. A public response must be 200 and not HTML, because a missing
# path can get the SPA fallback.
missing_assets() {
  list_keys assets/ | sort > "${work}/stored"
  comm -23 "${work}/built" "${work}/stored"
  # shellcheck disable=SC2016 # The inner sh expands $1 and $2.
  comm -12 "${work}/built" "${work}/stored" \
    | xargs -P 4 -I '{}' sh -c '
        result="$(curl -sS -o /dev/null -I -w "%{http_code} %{content_type}" \
          "$1/$2" 2>/dev/null || true)"
        case "${result}" in
          "200 text/html"*) echo "$2" ;;
          "200 "*) ;;
          *) echo "$2" ;;
        esac' _ "${PUBLIC_URL%/}" '{}'
}

aws configure set default.s3.addressing_style path

(cd "${dist}" && find assets -type f | sort) > "${work}/built"

# 1. Hashed assets first. Old assets stay, so open clients can still load
#    the chunks of their version.
s3 cp "${dist}/assets" "${bucket}/assets/" --recursive \
  --cache-control "public, max-age=31536000, immutable"

# Check the assets before the entry points go live. Bunny can accept an
# upload and not serve the file: on 2026-11-19, 24 of 153 assets returned
# 404 for 9 hours, and the new index.html did not load. Upload a missing
# asset again, and stop the deploy when it is still missing after 3 checks.
for attempt in 1 2 3; do
  missing_assets | sort -u > "${work}/missing"
  if [ ! -s "${work}/missing" ]; then
    echo "Check: all $(wc -l < "${work}/built") assets are available."
    break
  fi
  echo "Check ${attempt}: $(wc -l < "${work}/missing") assets are missing:"
  cat "${work}/missing"
  if [ "${attempt}" = 3 ]; then
    echo "Deploy stopped: assets are missing. index.html and sw.js are not changed." >&2
    exit 1
  fi
  while IFS= read -r asset; do
    s3 cp "${dist}/${asset}" "${bucket}/${asset}" \
      --cache-control "public, max-age=31536000, immutable"
  done < "${work}/missing"
  sleep 20
done

# 2. Other files, for example the Workbox runtime that sw.js loads.
s3 cp "${dist}" "${bucket}/" --recursive \
  --exclude "assets/*" --exclude "sw.js" --exclude "index.html" \
  --cache-control "no-cache"

# 3. Entry points last. index.html goes before sw.js, because the new
#    service worker precaches index.html when it installs.
for file in index.html sw.js; do
  s3 cp "${dist}/${file}" "${bucket}/${file}" --cache-control "no-cache"
done

# 4. Record the assets of this deploy. Prune uses these lists, not the
#    storage timestamps.
deploy="$(date -u +%Y%m%dT%H%M%SZ)"
cp "${work}/built" "${work}/${deploy}.txt"
s3 cp "${work}/${deploy}.txt" "${bucket}/deploys/${deploy}.txt" \
  --cache-control "no-cache"

# 5. Prune. Keep the assets of every deploy in the last keep_days days, and
#    of the newest deploy before that, because that version was live inside
#    the window. Without a deploy list older than the window, the history is
#    too short and nothing is pruned.
cutoff="$(date -u -d "-${keep_days} days" +%Y%m%dT%H%M%SZ)"
list_keys deploys/ | sed 's|^deploys/||' \
  | { grep -E '^[0-9]{8}T[0-9]{6}Z\.txt$' || true; } | sort > "${work}/lists"

keep_from=""
while IFS= read -r list; do
  if [[ "${list%.txt}" < "${cutoff}" ]]; then
    keep_from="${list}"
  fi
done < "${work}/lists"

if [ -z "${keep_from}" ]; then
  echo "Prune skipped: no deploy list is older than ${keep_days} days."
  exit 0
fi

: > "${work}/keep"
: > "${work}/old-lists"
while IFS= read -r list; do
  if [[ "${list}" < "${keep_from}" ]]; then
    echo "${list}" >> "${work}/old-lists"
  else
    s3 cp "${bucket}/deploys/${list}" - >> "${work}/keep"
  fi
done < "${work}/lists"
# The current deploy must be in the keep set, also if the listing missed it.
cat "${work}/${deploy}.txt" >> "${work}/keep"
sort -u -o "${work}/keep" "${work}/keep"

list_keys assets/ | sort > "${work}/stored"
comm -23 "${work}/stored" "${work}/keep" > "${work}/delete"

echo "Prune: keep $(wc -l < "${work}/keep") assets from deploy ${keep_from%.txt} on," \
  "delete $(wc -l < "${work}/delete") assets and $(wc -l < "${work}/old-lists") deploy lists."
sed 's|^|deploys/|' "${work}/old-lists" >> "${work}/delete"
xargs -P 8 -I '{}' aws s3 rm "${bucket}/{}" \
  --endpoint-url "${BUNNY_S3_ENDPOINT}" --only-show-errors < "${work}/delete"
