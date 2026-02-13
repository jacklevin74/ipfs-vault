#!/usr/bin/env node
/**
 * Backfill plaintext MD5 for all files by decrypting with wallet key.
 * Usage: node backfill-md5-decrypt.js
 */
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'ipfs_index_node.db');
const KEY_PATH = path.join(__dirname, '.wallet-key');
const IPFS_API = 'http://127.0.0.1:5001';
const DERIVATION_MSG = 'IPFS_ENCRYPTION_KEY_V1';

// Derive AES key from wallet private key
function deriveAesKey(secretKeyBase58) {
    const secretKey = bs58.decode(secretKeyBase58);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    const signature = nacl.sign.detached(Buffer.from(DERIVATION_MSG), keypair.secretKey);
    return crypto.createHash('sha256').update(signature).digest();
}

// Fetch CID content from IPFS (offline, local only)
function fetchCid(cid) {
    return new Promise((resolve, reject) => {
        const url = `${IPFS_API}/api/v0/cat?arg=${cid}&offline=true`;
        const req = http.request(url, { method: 'POST', timeout: 10000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200 || body.includes('"Type":"error"')) {
                    reject(new Error('not available'));
                } else {
                    resolve(body);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// Decrypt AES-256-GCM content
function decrypt(aesKey, base64Data) {
    const combined = Buffer.from(base64Data, 'base64');
    const iv = combined.slice(0, 12);
    const authTag = combined.slice(combined.length - 16);
    const ciphertext = combined.slice(12, combined.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function main() {
    const secret = fs.readFileSync(KEY_PATH, 'utf8').trim();
    const aesKey = deriveAesKey(secret);
    console.log('AES key derived from wallet.');

    const db = new Database(DB_PATH);
    const rows = db.prepare('SELECT cid FROM files WHERE md5 IS NULL GROUP BY cid').all();
    console.log(`${rows.length} CIDs need MD5 backfill...\n`);

    let ok = 0, fail = 0;
    const update = db.prepare('UPDATE files SET md5 = ? WHERE cid = ?');

    for (let i = 0; i < rows.length; i++) {
        const { cid } = rows[i];
        try {
            const raw = await fetchCid(cid);
            const pkg = JSON.parse(raw);
            if (pkg.version !== 1 || !pkg.data) throw new Error('bad format');
            const plaintext = decrypt(aesKey, pkg.data);
            const md5 = crypto.createHash('md5').update(plaintext).digest('hex');
            update.run(md5, cid);
            ok++;
            console.log(`[${i+1}/${rows.length}] OK   ${cid}  md5:${md5}`);
        } catch (e) {
            fail++;
            console.log(`[${i+1}/${rows.length}] FAIL ${cid}  ${e.message}`);
        }
    }

    console.log(`\nDone: ${ok} updated, ${fail} failed (out of ${rows.length})`);

    // Summary
    const stats = db.prepare('SELECT COUNT(*) as total, COUNT(md5) as has_md5 FROM files').get();
    console.log(`DB: ${stats.has_md5}/${stats.total} files have MD5`);
    db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
