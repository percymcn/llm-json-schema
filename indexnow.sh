#!/usr/bin/env bash
# IndexNow submitter — pings Bing / Yandex / Seznam / Naver instantly (no Search Console needed).
# Re-run after adding or changing pages. Reads URLs from ./sitemap.xml.
set -euo pipefail

HOST="percymcn.github.io"
KEY="535e5d6d6e2d4d248b8140e435491f8f"
KEY_LOCATION="https://${HOST}/llm-json-schema/${KEY}.txt"
SITEMAP="$(cd "$(dirname "$0")" && pwd)/sitemap.xml"

# Portable URL extraction (macOS bash 3.2 has no mapfile).
URLS=()
while IFS= read -r u; do URLS+=("$u"); done < <(grep -oE '<loc>[^<]+</loc>' "$SITEMAP" | sed -E 's#</?loc>##g')

URLLIST=$(printf '"%s",' "${URLS[@]}"); URLLIST="[${URLLIST%,}]"

PAYLOAD=$(printf '{"host":"%s","key":"%s","keyLocation":"%s","urlList":%s}' \
  "$HOST" "$KEY" "$KEY_LOCATION" "$URLLIST")

echo "Submitting ${#URLS[@]} URLs to IndexNow..."
curl -sS -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$PAYLOAD" -w "\nHTTP %{http_code}\n"
