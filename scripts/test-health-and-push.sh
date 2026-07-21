#!/usr/bin/env bash
# Test GET /health, GET /api/health, and optionally POST test pushes to driver and user.
# Usage:
#   export BASE_URL=http://localhost:3000
#   export DRIVER_ID=DRV_xxx    # optional
#   export USER_ID=USR_xxx      # optional
#   ./scripts/test-health-and-push.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DRIVER_ID="${DRIVER_ID:-}"
USER_ID="${USER_ID:-}"

echo "=== GET $BASE_URL/test ==="
curl -sS "$BASE_URL/test" | head -c 800
echo -e "\n"

echo "=== GET $BASE_URL/health ==="
curl -sS -w "\nHTTP_CODE:%{http_code}\n" "$BASE_URL/health" | head -c 1200
echo -e "\n"

echo "=== GET $BASE_URL/api/health ==="
curl -sS -w "\nHTTP_CODE:%{http_code}\n" "$BASE_URL/api/health" | head -c 1200
echo -e "\n"

if [[ -n "$DRIVER_ID" ]]; then
  echo "=== POST driver test push (driverId=$DRIVER_ID) ==="
  curl -sS -w "\nHTTP_CODE:%{http_code}\n" -X POST "$BASE_URL/api/drivers/notifications/send" \
    -H "Content-Type: application/json" \
    -d "{\"driverId\":\"$DRIVER_ID\",\"title\":\"AutoMet test\",\"body\":\"Driver push test $(date -u +%H:%M:%S)\",\"channelId\":\"driver_notifications\",\"data\":{\"type\":\"TEST_PUSH\"}}"
  echo -e "\n"
else
  echo "=== Skipping driver push (set DRIVER_ID to test) ==="
fi

if [[ -n "$USER_ID" ]]; then
  echo "=== POST user test push (userId=$USER_ID) ==="
  curl -sS -w "\nHTTP_CODE:%{http_code}\n" -X POST "$BASE_URL/api/users/notifications/send" \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"$USER_ID\",\"title\":\"AutoMet test\",\"body\":\"User push test $(date -u +%H:%M:%S)\",\"channelId\":\"user_notifications\",\"data\":{\"type\":\"TEST_PUSH\"}}"
  echo -e "\n"
else
  echo "=== Skipping user push (set USER_ID to test) ==="
fi

echo "Done."
