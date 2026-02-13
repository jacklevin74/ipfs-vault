#!/bin/bash
# Repin all CIDs from the local SQLite database
# Usage: ./repin.sh [--timeout 60s] [--parallel 1] [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$SCRIPT_DIR/ipfs_index_node.db"
export IPFS_PATH="${IPFS_PATH:-/home/jack/.ipfs2}"
IPFS_BIN="${IPFS_BIN:-/home/jack/ipfs}"
TIMEOUT="120s"
PARALLEL=1
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --parallel) PARALLEL="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --db) DB_PATH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--timeout 60s] [--parallel 4] [--dry-run] [--db path]"
            echo ""
            echo "Repins all CIDs from the ipfs_index_node.db database."
            echo ""
            echo "Options:"
            echo "  --timeout   Per-CID pin timeout (default: 120s)"
            echo "  --parallel  Number of concurrent pins (default: 1)"
            echo "  --dry-run   List CIDs without pinning"
            echo "  --db        Path to SQLite database"
            exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ ! -f "$DB_PATH" ]; then
    echo "ERROR: Database not found at $DB_PATH"
    exit 1
fi

if ! "$IPFS_BIN" id &>/dev/null; then
    echo "ERROR: IPFS daemon not running (IPFS_PATH=$IPFS_PATH)"
    exit 1
fi

# Get all unique CIDs
CIDS=$(sqlite3 "$DB_PATH" "SELECT DISTINCT cid FROM files ORDER BY created_at ASC")
TOTAL=$(echo "$CIDS" | wc -l)

echo "Database: $DB_PATH"
echo "IPFS repo: $IPFS_PATH"
echo "CIDs to pin: $TOTAL"
echo "Timeout: $TIMEOUT | Parallel: $PARALLEL"
echo ""

if $DRY_RUN; then
    echo "$CIDS"
    exit 0
fi

# Check which CIDs are already pinned
echo "Checking existing pins..."
PINNED=$("$IPFS_BIN" pin ls --type=recursive -q 2>/dev/null || true)
ALREADY=0
NEEDED=()

while IFS= read -r cid; do
    if echo "$PINNED" | grep -q "^$cid$"; then
        ALREADY=$((ALREADY + 1))
    else
        NEEDED+=("$cid")
    fi
done <<< "$CIDS"

echo "Already pinned: $ALREADY"
echo "Need to pin: ${#NEEDED[@]}"
echo ""

if [ ${#NEEDED[@]} -eq 0 ]; then
    echo "All CIDs are already pinned."
    exit 0
fi

SUCCESS=0
FAIL=0
FAILED_CIDS=()
i=0

pin_cid() {
    local cid=$1
    local idx=$2
    local total=$3
    if "$IPFS_BIN" pin add --timeout "$TIMEOUT" "$cid" &>/dev/null; then
        echo "[${idx}/${total}] OK $cid"
        return 0
    else
        echo "[${idx}/${total}] FAIL $cid"
        return 1
    fi
}

if [ "$PARALLEL" -gt 1 ]; then
    # Parallel pinning with xargs
    printf '%s\n' "${NEEDED[@]}" | xargs -P "$PARALLEL" -I{} bash -c \
        "\"$IPFS_BIN\" pin add --timeout \"$TIMEOUT\" {} &>/dev/null && echo 'OK {}' || echo 'FAIL {}'" \
        | while IFS= read -r line; do
            i=$((i + 1))
            status="${line%% *}"
            cid="${line#* }"
            if [ "$status" = "OK" ]; then
                SUCCESS=$((SUCCESS + 1))
            else
                FAIL=$((FAIL + 1))
            fi
            echo "[$i/${#NEEDED[@]}] $status $cid"
        done
    echo ""
    echo "=== DONE (parallel mode - check counts above) ==="
else
    # Sequential pinning
    for cid in "${NEEDED[@]}"; do
        i=$((i + 1))
        echo -n "[$i/${#NEEDED[@]}] Pinning $cid... "
        if "$IPFS_BIN" pin add --timeout "$TIMEOUT" "$cid" &>/dev/null; then
            echo "OK"
            SUCCESS=$((SUCCESS + 1))
        else
            echo "FAIL"
            FAIL=$((FAIL + 1))
            FAILED_CIDS+=("$cid")
        fi
    done

    echo ""
    echo "=== DONE ==="
    echo "Total: ${#NEEDED[@]} | Success: $SUCCESS | Failed: $FAIL | Already pinned: $ALREADY"

    if [ ${#FAILED_CIDS[@]} -gt 0 ]; then
        echo ""
        echo "Failed CIDs:"
        printf '  %s\n' "${FAILED_CIDS[@]}"
    fi
fi
