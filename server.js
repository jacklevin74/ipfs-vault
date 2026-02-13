#!/usr/bin/env node
/**
 * IPFS Encrypted Storage Server (Node.js)
 * - Proxies requests to IPFS API
 * - SQLite index for pubkey -> files mapping
 * - REST API for file management
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Try to load better-sqlite3, fall back to sql.js if not available
let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    console.log('[DB] better-sqlite3 not found, will try sql.js');
    Database = null;
}

const PORT = process.env.PORT || 8772;
const IPFS_API = process.env.IPFS_API || 'http://127.0.0.1:5001';
const DB_PATH = path.join(__dirname, 'ipfs_index_node.db');
const STATIC_DIR = __dirname;

let db;

// Request ID counter
let reqIdCounter = 0;
function nextReqId() {
    return (reqIdCounter++ & 0xFFFF).toString(16).padStart(4, '0');
}

// ANSI colors (disabled when piped to file)
const isTTY = process.stdout.isTTY;
const c = {
    reset: isTTY ? '\x1b[0m' : '',
    dim: isTTY ? '\x1b[2m' : '',
    bold: isTTY ? '\x1b[1m' : '',
    green: isTTY ? '\x1b[32m' : '',
    yellow: isTTY ? '\x1b[33m' : '',
    red: isTTY ? '\x1b[31m' : '',
    cyan: isTTY ? '\x1b[36m' : '',
};

function statusColor(code) {
    if (code < 300) return c.green;
    if (code < 400) return c.yellow;
    return c.red;
}

function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1048576).toFixed(1) + 'MB';
}

// Logging utility
function log(category, message, data = null) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`${timestamp} [${category}] ${message}${dataStr}`);
}

// Request logger - logs incoming API requests and returns response tracker
function logRequest(req) {
    const start = Date.now();
    const { method, url } = req;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '-';
    const reqId = nextReqId();
    req.reqId = reqId;

    // Classify request
    const isApi = url.startsWith('/api/') || url.startsWith('/index/');
    const tag = isApi ? 'API' : 'STATIC';

    // Log incoming API request with key headers
    if (isApi) {
        const parts = [`${c.bold}#${reqId}${c.reset}`, `${c.cyan}${method}${c.reset}`, url];
        const contentLen = req.headers['content-length'];
        if (contentLen) parts.push(`${c.dim}←${formatBytes(parseInt(contentLen))}${c.reset}`);
        const pubkey = req.headers['x-pubkey'];
        if (pubkey) parts.push(`${c.dim}pubkey:${pubkey.slice(0, 12)}…${c.reset}`);
        const filename = req.headers['x-filename'];
        if (filename) parts.push(`${c.dim}file:${filename}${c.reset}`);
        log(tag, parts.join(' '));
    }

    return (statusCode, resBytes) => {
        const duration = Date.now() - start;
        const sc = statusColor(statusCode);
        const sizeStr = resBytes ? ` →${formatBytes(resBytes)}` : '';
        const cleanIp = ip.split(',')[0].trim();
        if (isApi) {
            log(tag, `${c.bold}#${reqId}${c.reset} ${method} ${url} ${sc}${statusCode}${c.reset} ${duration}ms${sizeStr} ${c.dim}${cleanIp}${c.reset}`);
        } else {
            log(tag, `${method} ${url} ${sc}${statusCode}${c.reset} ${duration}ms${sizeStr} ${c.dim}${cleanIp}${c.reset}`);
        }
    };
}

// Initialize SQLite database
function initDb() {
    if (Database) {
        db = new Database(DB_PATH);
        db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pubkey TEXT NOT NULL,
                cid TEXT NOT NULL UNIQUE,
                filename TEXT NOT NULL,
                size_bytes INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                encrypted BOOLEAN DEFAULT 1
            )
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_pubkey ON files(pubkey)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_cid ON files(cid)');
        // Add md5 column if missing (existing databases)
        try { db.exec('ALTER TABLE files ADD COLUMN md5 TEXT'); } catch (e) { /* already exists */ }
        console.log(`[DB] Initialized at ${DB_PATH}`);
    } else {
        // Fallback: in-memory store (for testing without sqlite)
        console.log('[DB] Using in-memory fallback (install better-sqlite3 for persistence)');
        db = {
            files: [],
            prepare: () => ({ run: () => {}, all: () => db.files, get: () => null })
        };
    }
}

// Index a file in the database
function indexFile(pubkey, cid, filename, size, md5 = null) {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO files (pubkey, cid, filename, size_bytes, md5)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(pubkey, cid, filename, size, md5);
        log('INDEX', 'File indexed', { pubkey: pubkey.slice(0, 12), cid: cid.slice(0, 16), filename, size, md5: md5 ? md5.slice(0, 8) + '...' : null });
    } catch (e) {
        log('INDEX', 'Index error', { error: e.message, cid });
    }
}

// Parse JSON body
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// Collect raw body as Buffer
function collectBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Send JSON response
function sendJson(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, X-Pubkey, X-Filename, X-Content-MD5'
    });
    res.end(JSON.stringify(data));
}

// Send static file
function sendStatic(res, filepath) {
    const ext = path.extname(filepath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf'
    };
    
    fs.readFile(filepath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

// Proxy request to IPFS API
function proxyToIpfs(req, res, ipfsPath, body) {
    const ipfsUrl = new URL(ipfsPath, IPFS_API);
    
    const options = {
        hostname: ipfsUrl.hostname,
        port: ipfsUrl.port,
        path: ipfsUrl.pathname + ipfsUrl.search,
        method: 'POST',
        headers: {}
    };
    
    if (req.headers['content-type']) {
        options.headers['Content-Type'] = req.headers['content-type'];
    }
    if (body && body.length > 0) {
        options.headers['Content-Length'] = body.length;
    }

    const proxyStart = Date.now();
    const reqId = req.reqId || '----';
    log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.dim}→${c.reset} POST ${ipfsUrl.origin}${ipfsUrl.pathname}`);

    const proxyReq = http.request(options, (proxyRes) => {
        const proxyMs = Date.now() - proxyStart;
        const sc = statusColor(proxyRes.statusCode);
        log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.dim}←${c.reset} ${sc}${proxyRes.statusCode}${c.reset} ${proxyMs}ms`);
        res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Pubkey, X-Filename, X-Content-MD5'
        });
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
        log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.red}ERROR${c.reset} ${e.message}`);
        sendJson(res, { error: e.message }, 500);
    });
    
    if (body && body.length > 0) {
        proxyReq.write(body);
    }
    proxyReq.end();
}

// Handle IPFS add with indexing
async function handleIpfsAdd(req, res) {
    const pubkey = req.headers['x-pubkey'] || '';
    const userFilename = req.headers['x-filename'] || '';
    const body = await collectBody(req);
    
    log('IPFS_ADD', 'Upload started', { size: body.length, hasPubkey: !!pubkey, filename: userFilename || '(none)' });
    
    const ipfsUrl = new URL(req.url.replace(/^\/api/, '/api'), IPFS_API);
    
    const options = {
        hostname: ipfsUrl.hostname,
        port: ipfsUrl.port,
        path: ipfsUrl.pathname + ipfsUrl.search,
        method: 'POST',
        headers: {
            'Content-Type': req.headers['content-type'],
            'Content-Length': body.length
        }
    };

    const proxyStart = Date.now();
    const reqId = req.reqId || '----';
    log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.dim}→${c.reset} POST ${ipfsUrl.origin}${ipfsUrl.pathname}`);

    const proxyReq = http.request(options, (proxyRes) => {
        const proxyMs = Date.now() - proxyStart;
        const sc = statusColor(proxyRes.statusCode);
        log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.dim}←${c.reset} ${sc}${proxyRes.statusCode}${c.reset} ${proxyMs}ms`);
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            try {
                const result = JSON.parse(data);
                
                // Index the file if pubkey provided
                if (pubkey && result.Hash) {
                    const cid = result.Hash;
                    const size = parseInt(result.Size) || 0;
                    const prefix = cid.slice(-8);

                    // Prepend CID prefix for uniqueness
                    const indexedFilename = userFilename
                        ? `${prefix}-${userFilename}`
                        : `${prefix}-file`;

                    // Use plaintext MD5 from client if provided, else hash encrypted content
                    const md5 = req.headers['x-content-md5'] || crypto.createHash('md5').update(body).digest('hex');

                    indexFile(pubkey, cid, indexedFilename, size, md5);
                    result.IndexedFilename = indexedFilename;
                    result.MD5 = md5;
                    log('IPFS_ADD', 'Upload complete', { cid: cid.slice(0, 16), size, md5 });
                } else {
                    log('IPFS_ADD', 'Upload complete (no index)', { cid: result.Hash?.slice(0, 16) });
                }
                
                sendJson(res, result);
            } catch (e) {
                log('IPFS_ADD', 'Upload response parse error', { error: e.message });
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(data);
            }
        });
    });
    
    proxyReq.on('error', (e) => {
        log('PROXY', `${c.bold}#${reqId}${c.reset} ${c.red}ERROR${c.reset} ${e.message}`);
        log('IPFS_ADD', 'Upload error', { error: e.message });
        sendJson(res, { error: e.message }, 500);
    });
    
    proxyReq.write(body);
    proxyReq.end();
}

// List files for pubkey
function handleListFiles(res, pubkey) {
    if (!pubkey) {
        sendJson(res, { error: 'pubkey required' }, 400);
        return;
    }
    
    try {
        const stmt = db.prepare(`
            SELECT cid, filename, size_bytes, created_at, encrypted, md5
            FROM files WHERE pubkey = ?
            ORDER BY created_at DESC
        `);
        const rows = stmt.all(pubkey);

        const files = rows.map(row => ({
            cid: row.cid,
            filename: row.filename,
            size: row.size_bytes,
            created_at: row.created_at,
            encrypted: Boolean(row.encrypted),
            md5: row.md5 || null
        }));
        
        log('LIST', 'Files listed', { pubkey: pubkey.slice(0, 12), count: files.length });
        sendJson(res, { files, count: files.length });
    } catch (e) {
        log('LIST', 'List error', { error: e.message, pubkey: pubkey.slice(0, 12) });
        sendJson(res, { error: e.message }, 500);
    }
}

// Get file info by CID
function handleGetFile(res, cid) {
    try {
        const stmt = db.prepare(`
            SELECT pubkey, cid, filename, size_bytes, created_at, encrypted, md5
            FROM files WHERE cid = ?
        `);
        const row = stmt.get(cid);

        if (row) {
            log('GET', 'File info retrieved', { cid: cid.slice(0, 16), filename: row.filename });
            sendJson(res, {
                pubkey: row.pubkey,
                cid: row.cid,
                filename: row.filename,
                size: row.size_bytes,
                created_at: row.created_at,
                encrypted: Boolean(row.encrypted),
                md5: row.md5 || null
            });
        } else {
            log('GET', 'File not found', { cid: cid.slice(0, 16) });
            sendJson(res, { error: 'File not found' }, 404);
        }
    } catch (e) {
        log('GET', 'Get error', { error: e.message, cid: cid.slice(0, 16) });
        sendJson(res, { error: e.message }, 500);
    }
}

// Register file manually
async function handleRegisterFile(req, res) {
    try {
        const data = await parseBody(req);
        const { pubkey, cid, filename: userFilename, size } = data;
        
        if (!pubkey || !cid) {
            log('REGISTER', 'Missing required fields', { hasPubkey: !!pubkey, hasCid: !!cid });
            sendJson(res, { error: 'pubkey and cid required' }, 400);
            return;
        }
        
        const prefix = cid.slice(-8);
        const filename = userFilename ? `${prefix}-${userFilename}` : `${prefix}-file`;
        
        log('REGISTER', 'Registering file', { pubkey: pubkey.slice(0, 12), cid: cid.slice(0, 16), filename });
        indexFile(pubkey, cid, filename, size || 0);
        sendJson(res, { success: true, cid, filename });
    } catch (e) {
        log('REGISTER', 'Register error', { error: e.message });
        sendJson(res, { error: e.message }, 400);
    }
}

// Delete file from index
function handleDeleteFile(res, cid, pubkey) {
    if (!pubkey) {
        log('DELETE', 'Missing pubkey header', { cid: cid.slice(0, 16) });
        sendJson(res, { error: 'X-Pubkey header required' }, 400);
        return;
    }
    
    try {
        const stmt = db.prepare('DELETE FROM files WHERE cid = ? AND pubkey = ?');
        const result = stmt.run(cid, pubkey);
        
        if (result.changes > 0) {
            log('DELETE', 'File deleted', { cid: cid.slice(0, 16), pubkey: pubkey.slice(0, 12) });
            // Also unpin from IPFS
            unpinFromIpfs(cid);
            sendJson(res, { success: true, deleted: cid, unpinned: true });
        } else {
            log('DELETE', 'File not found or unauthorized', { cid: cid.slice(0, 16), pubkey: pubkey.slice(0, 12) });
            sendJson(res, { error: 'File not found or not owned by pubkey' }, 404);
        }
    } catch (e) {
        log('DELETE', 'Delete error', { error: e.message, cid: cid.slice(0, 16) });
        sendJson(res, { error: e.message }, 500);
    }
}

// List checksums for pubkey (or all files)
function handleChecksums(res, pubkey) {
    try {
        let stmt, rows;
        if (pubkey) {
            stmt = db.prepare(`
                SELECT cid, filename, size_bytes, md5, created_at
                FROM files WHERE pubkey = ?
                ORDER BY created_at DESC
            `);
            rows = stmt.all(pubkey);
        } else {
            stmt = db.prepare(`
                SELECT cid, filename, size_bytes, md5, created_at
                FROM files ORDER BY created_at DESC
            `);
            rows = stmt.all();
        }

        const files = rows.map(row => ({
            cid: row.cid,
            filename: row.filename,
            size: row.size_bytes,
            md5: row.md5 || null,
            created_at: row.created_at
        }));

        log('CHECKSUMS', 'Checksums listed', { pubkey: pubkey ? pubkey.slice(0, 12) : 'all', count: files.length });
        sendJson(res, { files, count: files.length });
    } catch (e) {
        log('CHECKSUMS', 'Checksums error', { error: e.message });
        sendJson(res, { error: e.message }, 500);
    }
}

// Update MD5 for a CID
async function handleUpdateMd5(req, res) {
    try {
        const data = await parseBody(req);
        const { cid, md5 } = data;
        const pubkey = req.headers['x-pubkey'];

        if (!cid || !md5 || !pubkey) {
            sendJson(res, { error: 'cid, md5, and X-Pubkey header required' }, 400);
            return;
        }
        if (!/^[a-f0-9]{32}$/.test(md5)) {
            sendJson(res, { error: 'invalid md5 format' }, 400);
            return;
        }

        const stmt = db.prepare('UPDATE files SET md5 = ? WHERE cid = ? AND pubkey = ?');
        const result = stmt.run(md5, cid, pubkey);

        if (result.changes > 0) {
            log('MD5', 'Updated', { cid: cid.slice(0, 16), md5: md5.slice(0, 8) });
            sendJson(res, { success: true, cid, md5 });
        } else {
            sendJson(res, { error: 'File not found or not owned' }, 404);
        }
    } catch (e) {
        log('MD5', 'Update error', { error: e.message });
        sendJson(res, { error: e.message }, 500);
    }
}

// Unpin CID from IPFS (async, fire-and-forget)
function unpinFromIpfs(cid) {
    log('IPFS_UNPIN', 'Unpinning', { cid: cid.slice(0, 16) });
    const ipfsUrl = new URL(`/api/v0/pin/rm?arg=${cid}`, IPFS_API);
    
    const req = http.request({
        hostname: ipfsUrl.hostname,
        port: ipfsUrl.port,
        path: ipfsUrl.pathname + ipfsUrl.search,
        method: 'POST'
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                log('IPFS_UNPIN', 'Unpinned successfully', { cid: cid.slice(0, 16) });
            } else {
                log('IPFS_UNPIN', 'Unpin failed', { cid: cid.slice(0, 16), response: data.slice(0, 100) });
            }
        });
    });
    
    req.on('error', (e) => {
        log('IPFS_UNPIN', 'Unpin error', { cid: cid.slice(0, 16), error: e.message });
    });
    
    req.end();
}

// API Documentation
function serveApiDocs(res) {
    const docPath = path.join(__dirname, 'doc.html');
    fs.readFile(docPath, 'utf8', (err, html) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading documentation');
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
    });
}

// Main request handler
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const finishLog = logRequest(req);

    // Wrap res to capture status code and response size
    const originalWriteHead = res.writeHead.bind(res);
    let statusCode = 200;
    res.writeHead = (code, ...args) => {
        statusCode = code;
        return originalWriteHead(code, ...args);
    };
    let resBytes = 0;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = (chunk, ...args) => {
        if (chunk) resBytes += Buffer.byteLength(chunk);
        return originalWrite(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
        if (chunk) resBytes += Buffer.byteLength(chunk);
        return originalEnd(chunk, ...args);
    };
    res.on('finish', () => finishLog(statusCode, resBytes));
    
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Pubkey, X-Filename, X-Content-MD5'
        });
        res.end();
        return;
    }
    
    try {
        // API Documentation
        if (pathname === '/doc' || pathname === '/doc/') {
            serveApiDocs(res);
            return;
        }
        
        // Index API
        if (pathname === '/index/files') {
            handleListFiles(res, url.searchParams.get('pubkey'));
            return;
        }
        
        if (pathname.startsWith('/index/file/')) {
            const cid = pathname.split('/').pop();
            if (req.method === 'DELETE') {
                handleDeleteFile(res, cid, req.headers['x-pubkey']);
            } else {
                handleGetFile(res, cid);
            }
            return;
        }
        
        if (pathname === '/index/checksums') {
            handleChecksums(res, url.searchParams.get('pubkey'));
            return;
        }

        if (pathname === '/index/md5' && req.method === 'POST') {
            await handleUpdateMd5(req, res);
            return;
        }

        if (pathname === '/index/register' && req.method === 'POST') {
            await handleRegisterFile(req, res);
            return;
        }
        
        // IPFS API proxy
        if (pathname.startsWith('/api/')) {
            if (pathname.includes('/add')) {
                await handleIpfsAdd(req, res);
            } else {
                const body = await collectBody(req);
                proxyToIpfs(req, res, req.url, body);
            }
            return;
        }
        
        // Static files
        let filepath = pathname === '/' ? '/index.html' : pathname;
        filepath = path.join(STATIC_DIR, filepath);
        
        if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
            sendStatic(res, filepath);
            return;
        }
        
        // 404
        sendJson(res, { error: 'Not Found' }, 404);
        
    } catch (e) {
        console.error(`[Error] ${e.message}`);
        sendJson(res, { error: e.message }, 500);
    }
}

// Start server
initDb();
const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`IPFS Encrypted Storage (Node.js) running at http://0.0.0.0:${PORT}`);
    console.log(`API docs: http://0.0.0.0:${PORT}/doc`);
    console.log(`Proxying to ${IPFS_API}`);
});
