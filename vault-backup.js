#!/usr/bin/env node
/**
 * IPFS Vault Backup Client
 * Encrypts and uploads files, skipping duplicates via MD5 check.
 *
 * Usage:
 *   node vault-backup.js file1.txt file2.md          # backup specific files
 *   node vault-backup.js --dir ~/documents/           # backup directory recursively
 *   node vault-backup.js --dry-run file1.txt          # check without uploading
 *   node vault-backup.js --server https://vault.x1.xyz file1.txt
 *   node vault-backup.js --key /path/to/key file1.txt
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const nacl = require('tweetnacl');
const bs58 = (require('bs58').default || require('bs58'));

const DERIVATION_MSG = 'IPFS_ENCRYPTION_KEY_V1';
const DEFAULT_SERVER = 'http://127.0.0.1:8772';
const DEFAULT_KEY_PATH = path.join(__dirname, '.wallet-key');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ipfs', '.ipfs2', '__pycache__']);

// --- Crypto ---

function loadWallet(keyPath) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    const match = raw.match(/SOLANA_PRIVATE_KEY=([^\s\n]+)/);
    const secretKey = bs58.decode(match ? match[1] : raw);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    const publicKey = bs58.encode(keypair.publicKey);
    const signature = nacl.sign.detached(Buffer.from(DERIVATION_MSG), keypair.secretKey);
    const aesKey = crypto.createHash('sha256').update(signature).digest();
    return { publicKey, aesKey };
}

function encrypt(aesKey, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}

// --- HTTP helpers ---

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                else resolve(JSON.parse(body));
            });
        }).on('error', reject);
    });
}

function multipartUpload(serverUrl, fileBuf, filename, pubkey, contentMd5) {
    return new Promise((resolve, reject) => {
        const boundary = '----VaultBackup' + crypto.randomBytes(8).toString('hex');
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="encrypted.json"\r\nContent-Type: application/json\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        const body = Buffer.concat([Buffer.from(header), fileBuf, Buffer.from(footer)]);

        const parsed = new URL(`${serverUrl}/api/v0/add?pin=true`);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            timeout: 60000,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
                'X-Pubkey': pubkey,
                'X-Filename': filename,
                'X-Content-MD5': contentMd5,
            }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) reject(new Error(`Upload HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                else resolve(JSON.parse(text.split('\n')[0]));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('upload timeout')); });
        req.write(body);
        req.end();
    });
}

// --- File discovery ---

function collectFiles(dirPath, base) {
    const files = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dirPath, entry.name);
        const rel = path.join(base, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            files.push(...collectFiles(full, rel));
        } else if (entry.isFile()) {
            files.push({ abs: full, name: rel });
        }
    }
    return files;
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);
    let serverUrl = DEFAULT_SERVER;
    let keyPath = DEFAULT_KEY_PATH;
    let dryRun = false;
    let dirMode = null;
    const filePaths = [];

    // Parse args
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--server' && args[i + 1]) { serverUrl = args[++i]; }
        else if (args[i] === '--key' && args[i + 1]) { keyPath = args[++i]; }
        else if (args[i] === '--dry-run') { dryRun = true; }
        else if (args[i] === '--dir' && args[i + 1]) { dirMode = args[++i]; }
        else if (args[i] === '--help' || args[i] === '-h') {
            console.log('Usage: vault-backup [--server URL] [--key PATH] [--dry-run] [--dir DIR] [files...]');
            process.exit(0);
        }
        else { filePaths.push(args[i]); }
    }

    // Collect files
    let files;
    if (dirMode) {
        const absDir = path.resolve(dirMode);
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
            console.error(`Error: ${absDir} is not a directory`);
            process.exit(1);
        }
        files = collectFiles(absDir, '');
    } else {
        files = filePaths.map(p => ({ abs: path.resolve(p), name: path.basename(p) }));
    }

    if (!files.length) {
        console.error('No files specified. Use --help for usage.');
        process.exit(1);
    }

    // Load wallet
    if (!fs.existsSync(keyPath)) {
        console.error(`Key file not found: ${keyPath}`);
        process.exit(1);
    }
    const { publicKey, aesKey } = loadWallet(keyPath);
    console.log(`Wallet: ${publicKey.slice(0, 8)}...${publicKey.slice(-6)}`);
    console.log(`Server: ${serverUrl}`);
    if (dryRun) console.log('Mode:   DRY RUN (no uploads)');
    console.log();

    // Fetch existing checksums
    let existingMap = new Map(); // cleanFilename → Set<md5>
    try {
        const data = await httpGet(`${serverUrl}/index/checksums?pubkey=${publicKey}`);
        for (const f of data.files) {
            const clean = f.filename.replace(/^[A-Za-z0-9]{8}-/, '');
            if (!existingMap.has(clean)) existingMap.set(clean, new Set());
            existingMap.get(clean).add(f.md5);
        }
        console.log(`Remote: ${data.count} files indexed (${existingMap.size} unique names)`);
    } catch (e) {
        console.log(`Warning: Could not fetch checksums (${e.message}). Uploading all.`);
    }
    console.log(`Local:  ${files.length} files to process\n`);

    let uploaded = 0, skipped = 0, failed = 0;
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
        const { abs, name } = files[i];
        const idx = `[${i + 1}/${total}]`;

        if (!fs.existsSync(abs)) {
            console.log(`${idx} MISS  ${name} (file not found)`);
            failed++;
            continue;
        }

        const content = fs.readFileSync(abs);
        const md5 = crypto.createHash('md5').update(content).digest('hex');
        const md5Short = md5.slice(0, 10);

        // Check if already uploaded with same content
        const existing = existingMap.get(name);
        if (existing && existing.has(md5)) {
            console.log(`${idx} SKIP  ${name} (unchanged, md5:${md5Short})`);
            skipped++;
            continue;
        }

        if (dryRun) {
            const label = existing ? 'WOULD UPDATE' : 'WOULD UPLOAD';
            console.log(`${idx} ${label}  ${name} (md5:${md5Short})`);
            uploaded++;
            continue;
        }

        // Encrypt
        const encData = encrypt(aesKey, content);
        const payload = JSON.stringify({
            version: 1,
            algorithm: 'AES-256-GCM',
            wallet: publicKey,
            derivationMsg: DERIVATION_MSG,
            data: encData
        });

        // Upload
        try {
            const result = await multipartUpload(serverUrl, Buffer.from(payload), name, publicKey, md5);
            const cid = result.Hash;
            const label = existing ? 'UP' : 'NEW';
            console.log(`${idx} ${label}    ${name} → ${cid} (md5:${md5Short})`);
            // Update local cache
            if (!existingMap.has(name)) existingMap.set(name, new Set());
            existingMap.get(name).add(md5);
            uploaded++;
        } catch (e) {
            console.log(`${idx} FAIL  ${name} (${e.message})`);
            failed++;
        }
    }

    console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed (of ${total})`);
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
