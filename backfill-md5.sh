#!/bin/bash
# Backfill MD5 checksums for all locally available CIDs
set -euo pipefail

DB="/home/jack/ipfs-web/ipfs_index_node.db"
IPFS_API="http://127.0.0.1:5001"

# Get CIDs that need MD5
CIDS=$(sqlite3 "$DB" "SELECT DISTINCT cid FROM files WHERE md5 IS NULL;")
TOTAL=$(echo "$CIDS" | wc -l)
OK=0
FAIL=0
i=0

echo "Backfilling MD5 for $TOTAL CIDs..."

for cid in $CIDS; do
    i=$((i + 1))
    # Use IPFS HTTP API with offline flag - fast fail for missing blocks
    RESPONSE=$(timeout 10 curl -s -X POST "${IPFS_API}/api/v0/cat?arg=${cid}&offline=true" 2>/dev/null)

    # Check if it's an error response
    if echo "$RESPONSE" | grep -q '"Type":"error"' 2>/dev/null; then
        FAIL=$((FAIL + 1))
        echo "[$i/$TOTAL] MISS $cid"
        continue
    fi

    if [ -z "$RESPONSE" ]; then
        FAIL=$((FAIL + 1))
        echo "[$i/$TOTAL] MISS $cid (empty)"
        continue
    fi

    # Compute MD5
    MD5=$(echo -n "$RESPONSE" | md5sum | awk '{print $1}')

    # Skip if it's the empty string md5
    if [ "$MD5" = "d41d8cd98f00b204e9800998ecf8427e" ]; then
        FAIL=$((FAIL + 1))
        echo "[$i/$TOTAL] MISS $cid (empty content)"
        continue
    fi

    # Update all rows with this CID
    sqlite3 "$DB" "UPDATE files SET md5 = '${MD5}' WHERE cid = '${cid}';"
    OK=$((OK + 1))
    echo "[$i/$TOTAL] OK   $cid  $MD5"
done

echo ""
echo "Done: $OK updated, $FAIL unavailable (out of $TOTAL)"
