# X1 Vault — Encrypted IPFS Storage

**Wallet-derived encryption + IPFS + content-addressed storage.**

Your wallet is your key. No passwords, no accounts, no trust required. Sign a message with your wallet → derive an AES-256-GCM key → encrypt client-side → upload to IPFS. Only you can decrypt.

**Live:** [vault.x1.xyz/ipfs/crypto.html](https://vault.x1.xyz/ipfs/crypto.html)

---

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│  Client (Browser / CLI)                                      │
│                                                              │
│  1. Connect wallet (X1 / Phantom / Backpack / Solflare)      │
│  2. Sign "IPFS_ENCRYPTION_KEY_V1" → Ed25519 signature        │
│  3. SHA-256(signature) → 32-byte AES-256-GCM key             │
│  4. Encrypt file locally (AES-256-GCM, random 12-byte IV)    │
│  5. Upload ciphertext + headers to server                    │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  X1 Vault Server (this repo)                                 │
│                                                              │
│  - Proxies encrypted blob to IPFS daemon (ipfs add --pin)    │
│  - Indexes: pubkey → CID → filename → size → MD5            │
│  - Returns CID to client                                     │
│  - Server NEVER sees plaintext — only ciphertext passes      │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  IPFS Node                                                   │
│                                                              │
│  - Stores encrypted blob, content-addressed by CID           │
│  - Pinned for persistence                                    │
│  - Retrievable by anyone with CID (but useless without key)  │
└──────────────────────────────────────────────────────────────┘
```

**Key insight:** The server is a dumb pipe. It indexes metadata (pubkey, CID, filename, size) but never touches encryption keys or plaintext. Even a fully compromised server reveals nothing — all data on IPFS is AES-256-GCM ciphertext.

---

## Features

- **Zero-knowledge server** — encryption/decryption happens entirely client-side
- **Wallet-derived keys** — deterministic from wallet signature, no key management
- **Content-addressed** — CIDs provide tamper-evident references
- **MD5 deduplication** — skip re-uploading unchanged files (plaintext MD5 sent as header, compared server-side)
- **Multi-wallet support** — X1 Wallet, Phantom, Backpack, Solflare
- **SQLite index** — fast file listing, search, checksums per pubkey
- **IPFS pinning** — files persist as long as the node is running
- **Web UI** — upload, browse, decrypt, and manage files in the browser
- **CLI backup client** — `vault-backup.js` for scripted/automated backups
- **Dual implementation** — Node.js (production, port 8772) and Python (reference, port 8771)

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- **IPFS daemon** running locally (`ipfs daemon` or Kubo)
- **A Solana/X1 wallet** (for encryption key derivation)

### Install & Run

```bash
git clone https://github.com/jacklevin74/ipfs-vault.git
cd ipfs-vault
npm install
npm start
```

Server starts at `http://localhost:8772`. Open `http://localhost:8772/crypto.html` in your browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8772` | Server port |
| `IPFS_API` | `http://127.0.0.1:5001` | IPFS daemon API endpoint |

---

## Web Interfaces

| Page | URL | Description |
|------|-----|-------------|
| **Encrypted Storage** | `/crypto.html` | Main UI — connect wallet, upload, browse, decrypt |
| **File Browser** | `/browse.html` | Browse and search uploaded files |
| **API Docs** | `/doc` or `/doc.html` | Interactive API documentation |

### Encryption Flow (Browser)

1. Click "Connect Wallet" — selects X1 Wallet, Phantom, Backpack, or Solflare
2. Wallet signs the derivation message `IPFS_ENCRYPTION_KEY_V1`
3. Signature is SHA-256 hashed → 32-byte AES-256-GCM key (stays in browser memory)
4. Select a file or paste text → encrypted in-browser with random 12-byte IV
5. Ciphertext uploaded to server → proxied to IPFS → CID returned
6. To decrypt: connect same wallet → select file from your list → decrypted in-browser

---

## API Reference

### File Index

#### `GET /index/files?pubkey={wallet_address}`

List all files uploaded by a wallet.

```bash
curl "http://localhost:8772/index/files?pubkey=2jchoLFVoxmJUcygc2cDfAqQb1yWUEjJihsw2ARbDRy3"
```

Response:
```json
{
  "files": [
    {
      "cid": "QmfH5pke91q6jTDCiUWLh8AVaZzJjqE6fXN9n9tsrHuPhB",
      "filename": "tsrHuPhB-backup-manifest.json",
      "size": 10190,
      "created_at": "2026-03-27 14:05:14",
      "encrypted": true,
      "md5": "4021794e8f4832c18beff68d394331f1"
    }
  ],
  "count": 1
}
```

#### `GET /index/file/{cid}`

Get metadata for a specific file.

```bash
curl "http://localhost:8772/index/file/QmfH5pke91q6jTDCiUWLh8AVaZzJjqE6fXN9n9tsrHuPhB"
```

Response:
```json
{
  "pubkey": "2jchoLFVoxmJUcygc2cDfAqQb1yWUEjJihsw2ARbDRy3",
  "cid": "QmfH5pke91q6jTDCiUWLh8AVaZzJjqE6fXN9n9tsrHuPhB",
  "filename": "tsrHuPhB-backup-manifest.json",
  "size": 10190,
  "created_at": "2026-03-27 14:05:14",
  "encrypted": true,
  "md5": "4021794e8f4832c18beff68d394331f1"
}
```

#### `POST /index/register`

Manually register a file in the index (for files uploaded directly to IPFS).

```bash
curl -X POST http://localhost:8772/index/register \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "YOUR_PUBKEY", "cid": "QmXxx...", "filename": "my-file.txt", "size": 1234}'
```

#### `DELETE /index/file/{cid}`

Remove a file from the index and unpin from IPFS. Requires `X-Pubkey` header for ownership verification.

```bash
curl -X DELETE http://localhost:8772/index/file/QmXxx... \
  -H "X-Pubkey: YOUR_PUBKEY"
```

#### `GET /index/checksums?pubkey={wallet_address}`

List all files with their MD5 checksums (used for deduplication).

```bash
curl "http://localhost:8772/index/checksums?pubkey=YOUR_PUBKEY"
```

#### `POST /index/md5`

Update the MD5 checksum for a file. Requires `X-Pubkey` header.

```bash
curl -X POST http://localhost:8772/index/md5 \
  -H "Content-Type: application/json" \
  -H "X-Pubkey: YOUR_PUBKEY" \
  -d '{"cid": "QmXxx...", "md5": "d41d8cd98f00b204e9800998ecf8427e"}'
```

### IPFS Proxy

All IPFS API calls are proxied through the server with automatic indexing on upload.

#### `POST /api/v0/add?pin=true`

Upload a file to IPFS. Add headers for automatic indexing:

| Header | Required | Description |
|--------|----------|-------------|
| `X-Pubkey` | Optional | Wallet address — enables indexing |
| `X-Filename` | Optional | Human-readable filename |
| `X-Content-MD5` | Optional | MD5 of **plaintext** (for dedup, not ciphertext) |
| `Content-Type` | Yes | `multipart/form-data` |

```bash
curl -X POST "http://localhost:8772/api/v0/add?pin=true" \
  -H "X-Pubkey: YOUR_PUBKEY" \
  -H "X-Filename: secret-notes.txt" \
  -H "X-Content-MD5: d41d8cd98f00b204e9800998ecf8427e" \
  -F "file=@encrypted-blob.bin"
```

Response:
```json
{
  "Name": "encrypted-blob.bin",
  "Hash": "QmfH5pke91q6jTDCiUWLh8AVaZzJjqE6fXN9n9tsrHuPhB",
  "Size": "10190",
  "IndexedFilename": "tsrHuPhB-secret-notes.txt",
  "MD5": "d41d8cd98f00b204e9800998ecf8427e"
}
```

#### `POST /api/v0/cat?arg={cid}`

Retrieve file content (returns encrypted ciphertext).

```bash
curl -X POST "http://localhost:8772/api/v0/cat?arg=QmXxx..."
```

#### `POST /api/v0/pin/ls`

List all pinned content on the IPFS node.

---

## CLI Backup Client

`vault-backup.js` provides automated encrypted backups with MD5-based deduplication.

```bash
# Backup specific files
node vault-backup.js file1.txt file2.md

# Backup a directory recursively
node vault-backup.js --dir ~/documents/

# Dry run — check what would be uploaded
node vault-backup.js --dry-run file1.txt

# Use a specific server
node vault-backup.js --server https://vault.x1.xyz file1.txt

# Use a specific wallet key
node vault-backup.js --key /path/to/wallet-key file1.txt
```

### Deduplication

The client computes MD5 of each **plaintext** file before encryption, sends it as `X-Content-MD5`. The server stores this in the index. On subsequent uploads, the client checks existing checksums via `/index/checksums` and skips files that haven't changed.

This works because:
- Same plaintext → same MD5 (deterministic)
- Same plaintext + same key → different ciphertext (random IV)
- MD5 of plaintext reveals nothing about content (preimage resistance)

---

## Cryptographic Design

### Key Derivation

```
Wallet Private Key (Ed25519)
        │
        ▼
Sign("IPFS_ENCRYPTION_KEY_V1")  ← deterministic Ed25519 signature
        │
        ▼
SHA-256(signature)  →  32-byte AES key
```

- **Deterministic:** Same wallet always produces the same key
- **One-way:** Cannot recover wallet key from AES key
- **No storage needed:** Key is re-derived on every session from wallet signature

### Encryption

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **IV:** 12 bytes, randomly generated per file
- **Auth tag:** 16 bytes, appended to ciphertext
- **Format:** `[IV (12 bytes)] [ciphertext] [auth tag (16 bytes)]`
- **Encoding:** Base64 for transport

### Security Properties

| Property | Guarantee |
|----------|-----------|
| Confidentiality | AES-256-GCM — 256-bit key, quantum-resistant against Grover's |
| Integrity | GCM auth tag detects tampering |
| Authenticity | Only wallet holder can derive the key |
| Forward secrecy | ❌ Not provided — key is deterministic from wallet |
| Server trust | Zero — server never sees plaintext or keys |
| IPFS exposure | CID is public, content is ciphertext |

### Threat Model

| Threat | Mitigated? | How |
|--------|------------|-----|
| Server compromise | ✅ | Server only has ciphertext + metadata |
| IPFS node compromise | ✅ | All stored data is AES-256-GCM ciphertext |
| Network eavesdropping | ✅ | TLS in transit + encrypted at rest |
| Wallet key theft | ❌ | If wallet is compromised, all files are decryptable |
| Metadata analysis | ⚠️ Partial | Filenames visible in index; file sizes visible |
| Quantum computing | ✅ | AES-256 resists Grover's (128-bit effective security) |

---

## Maintenance Tools

### Repin Script

Re-pin all CIDs from the database (useful after IPFS repo migration or garbage collection):

```bash
./repin.sh                    # Repin all CIDs
./repin.sh --dry-run          # List CIDs without pinning
./repin.sh --timeout 60s      # Custom timeout per CID
./repin.sh --parallel 4       # Concurrent pins
```

### MD5 Backfill

Backfill plaintext MD5 checksums for files uploaded before the dedup feature:

```bash
node backfill-md5-decrypt.js
```

This fetches each CID from IPFS, decrypts with the wallet key, computes MD5, and updates the index.

---

## Architecture

```
ipfs-vault/
├── server.js              # Node.js production server (port 8772)
├── server.py              # Python reference server (port 8771)
├── vault-backup.js        # CLI backup client with dedup
├── backfill-md5-decrypt.js # MD5 backfill utility
├── repin.sh               # Bulk re-pin script
├── crypto.html            # Web UI: encrypted upload/download
├── browse.html            # Web UI: file browser with search
├── doc.html               # Web UI: interactive API docs
├── index.html             # Landing page
├── whitepaper.tex         # Technical whitepaper (LaTeX)
├── whitepaper.pdf         # Compiled whitepaper
├── package.json           # Node.js dependencies
└── .gitignore             # Excludes: node_modules, *.db, .wallet-key, logs
```

### Database Schema

SQLite with a single `files` table:

```sql
CREATE TABLE files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey      TEXT NOT NULL,          -- wallet address (owner)
    cid         TEXT NOT NULL UNIQUE,   -- IPFS content identifier
    filename    TEXT NOT NULL,          -- human-readable name (CID-prefixed)
    size_bytes  INTEGER,               -- file size in bytes
    md5         TEXT,                   -- plaintext MD5 (for dedup)
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    encrypted   BOOLEAN DEFAULT 1
);
```

Indexes on `pubkey` and `cid` for fast lookups.

### Filename Convention

All indexed filenames are prefixed with the last 8 characters of the CID for uniqueness:

```
QmfH5pke91q6jTDCiUWLh8AVaZzJjqE6fXN9n9tsrHuPhB
                                        ^^^^^^^^
                                        tsrHuPhB

Stored as: tsrHuPhB-backup-manifest.json
```

This prevents collisions when the same filename is uploaded multiple times.

---

## Deployment

### Production (vault.x1.xyz)

The production instance runs behind nginx with TLS:

```nginx
server {
    listen 443 ssl;
    server_name vault.x1.xyz;
    
    location /ipfs/ {
        proxy_pass http://127.0.0.1:8772/;
        proxy_set_header X-Forwarded-For $remote_addr;
        client_max_body_size 100M;
    }
}
```

IPFS daemon runs separately with a dedicated repo:

```bash
export IPFS_PATH=~/.ipfs2
ipfs daemon &
node server.js &
```

### Docker (Optional)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8772
CMD ["node", "server.js"]
```

Note: Requires a running IPFS daemon accessible at `IPFS_API`.

---

## Use Cases

### AI Agent Memory (OpenClaw)

OpenClaw agents use X1 Vault for persistent memory across sessions:

- Session logs encrypted and backed up daily via cron
- Backup manifests track what was uploaded and when
- Agent reconnects wallet on startup → full memory restoration
- 11,500+ encrypted files stored as of March 2026

### Blockchain Data Archival

- Transaction receipts, validator logs, governance proposals
- Encrypted with operator's wallet — auditable but private
- CIDs stored on-chain as tamper-evident references

### xChat Message Storage

- E2E encrypted messages stored on IPFS via the [xchat-vault-storage](https://github.com/jacklevin74/xchat-vault-storage) adapter
- Each message blob encrypted to recipient's wallet key
- CIDs resolve message history without centralized database

---

## Whitepaper

The full technical whitepaper is included as `whitepaper.pdf` (compiled from `whitepaper.tex`).

**"X1 Vault: Encrypted IPFS Storage for Blockchain and AI Systems"** — covers cryptographic design, deduplication protocol, threat model, and architecture in depth.

---

## License

MIT

---

**Built for [X1 Blockchain](https://x1.xyz)** — decentralized, encrypted, content-addressed storage for the sovereign internet.
