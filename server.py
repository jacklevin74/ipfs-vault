#!/usr/bin/env python3
"""
IPFS Encrypted Storage Server
- Proxies requests to IPFS API
- SQLite index for pubkey -> files mapping
- REST API for file management
"""
import http.server
import json
import sqlite3
import urllib.request
import urllib.error
import os
import time
from urllib.parse import urlparse, parse_qs
from datetime import datetime

IPFS_API = "http://127.0.0.1:5001"
PORT = 8771
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipfs_index.db")

# Initialize SQLite database
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pubkey TEXT NOT NULL,
            cid TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            size_bytes INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            encrypted BOOLEAN DEFAULT 1
        )
    ''')
    c.execute('CREATE INDEX IF NOT EXISTS idx_pubkey ON files(pubkey)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_cid ON files(cid)')
    conn.commit()
    conn.close()
    print(f"[DB] Initialized at {DB_PATH}")

class IPFSProxyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Pubkey, X-Filename')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def do_GET(self):
        parsed = urlparse(self.path)
        
        # API: List files for pubkey
        if parsed.path == '/index/files':
            self.handle_list_files(parsed)
        # API: Get file info
        elif parsed.path.startswith('/index/file/'):
            self.handle_get_file(parsed)
        # API Documentation
        elif parsed.path == '/doc' or parsed.path == '/doc/':
            self.serve_api_docs()
        # Static files
        else:
            super().do_GET()
    
    def do_POST(self):
        parsed = urlparse(self.path)
        
        # IPFS API proxy
        if parsed.path.startswith('/api/'):
            # Special handling for /api/v0/add to capture uploads
            if '/add' in parsed.path:
                self.handle_ipfs_add()
            else:
                self.proxy_to_ipfs()
        # API: Register file
        elif parsed.path == '/index/register':
            self.handle_register_file()
        else:
            self.send_error(404)
    
    def do_DELETE(self):
        parsed = urlparse(self.path)
        
        # API: Delete file from index
        if parsed.path.startswith('/index/file/'):
            self.handle_delete_file(parsed)
        else:
            self.send_error(404)
    
    def handle_ipfs_add(self):
        """Proxy IPFS add and optionally index the file"""
        # Get headers for indexing
        pubkey = self.headers.get('X-Pubkey', '')
        filename = self.headers.get('X-Filename', '')
        
        # Forward to IPFS
        ipfs_url = IPFS_API + self.path
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        try:
            req = urllib.request.Request(ipfs_url, data=body, method='POST')
            if 'Content-Type' in self.headers:
                req.add_header('Content-Type', self.headers['Content-Type'])
            
            with urllib.request.urlopen(req, timeout=60) as response:
                data = response.read()
                result = json.loads(data.decode())
                
                # Index the file if pubkey provided
                if pubkey and result.get('Hash'):
                    cid = result['Hash']
                    size = int(result.get('Size', 0))
                    prefix = cid[-8:]  # Last 8 chars of CID for uniqueness
                    
                    # Prepend CID prefix to filename for uniqueness
                    if filename:
                        indexed_filename = f"{prefix}-{filename}"
                    else:
                        indexed_filename = f"{prefix}-file"
                    
                    self.index_file(pubkey, cid, indexed_filename, size)
                    
                    # Add filename to response for client
                    result['IndexedFilename'] = indexed_filename
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
    
    def proxy_to_ipfs(self):
        """Generic IPFS API proxy"""
        ipfs_url = IPFS_API + self.path
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        try:
            req = urllib.request.Request(ipfs_url, data=body, method='POST')
            if 'Content-Type' in self.headers:
                req.add_header('Content-Type', self.headers['Content-Type'])
            
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
                self.send_response(200)
                content_type = response.headers.get('Content-Type', 'application/octet-stream')
                self.send_header('Content-Type', content_type)
                self.end_headers()
                self.wfile.write(data)
                
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
    
    def index_file(self, pubkey, cid, filename, size):
        """Add file to SQLite index"""
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('''
                INSERT OR REPLACE INTO files (pubkey, cid, filename, size_bytes)
                VALUES (?, ?, ?, ?)
            ''', (pubkey, cid, filename, size))
            conn.commit()
            conn.close()
            print(f"[Index] {pubkey[:8]}... -> {filename} ({cid[:12]}...)")
        except Exception as e:
            print(f"[Index Error] {e}")
    
    def handle_list_files(self, parsed):
        """List all files for a pubkey"""
        query = parse_qs(parsed.query)
        pubkey = query.get('pubkey', [''])[0]
        
        if not pubkey:
            self.send_json_response({'error': 'pubkey required'}, 400)
            return
        
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('''
                SELECT cid, filename, size_bytes, created_at, encrypted
                FROM files WHERE pubkey = ?
                ORDER BY created_at DESC
            ''', (pubkey,))
            
            files = []
            for row in c.fetchall():
                files.append({
                    'cid': row[0],
                    'filename': row[1],
                    'size': row[2],
                    'created_at': row[3],
                    'encrypted': bool(row[4])
                })
            
            conn.close()
            self.send_json_response({'files': files, 'count': len(files)})
            
        except Exception as e:
            self.send_json_response({'error': str(e)}, 500)
    
    def handle_get_file(self, parsed):
        """Get file info by CID"""
        cid = parsed.path.split('/')[-1]
        
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('''
                SELECT pubkey, cid, filename, size_bytes, created_at, encrypted
                FROM files WHERE cid = ?
            ''', (cid,))
            
            row = c.fetchone()
            conn.close()
            
            if row:
                self.send_json_response({
                    'pubkey': row[0],
                    'cid': row[1],
                    'filename': row[2],
                    'size': row[3],
                    'created_at': row[4],
                    'encrypted': bool(row[5])
                })
            else:
                self.send_json_response({'error': 'File not found'}, 404)
                
        except Exception as e:
            self.send_json_response({'error': str(e)}, 500)
    
    def handle_register_file(self):
        """Manually register a file in the index"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        try:
            data = json.loads(body)
            pubkey = data.get('pubkey')
            cid = data.get('cid')
            user_filename = data.get('filename', '')
            size = data.get('size', 0)
            
            if not pubkey or not cid:
                self.send_json_response({'error': 'pubkey and cid required'}, 400)
                return
            
            # Prepend CID prefix for uniqueness
            prefix = cid[-8:]
            if user_filename:
                filename = f"{prefix}-{user_filename}"
            else:
                filename = f"{prefix}-file"
            
            self.index_file(pubkey, cid, filename, size)
            self.send_json_response({'success': True, 'cid': cid, 'filename': filename})
            
        except json.JSONDecodeError:
            self.send_json_response({'error': 'Invalid JSON'}, 400)
        except Exception as e:
            self.send_json_response({'error': str(e)}, 500)
    
    def handle_delete_file(self, parsed):
        """Delete file from index (not from IPFS)"""
        cid = parsed.path.split('/')[-1]
        pubkey = self.headers.get('X-Pubkey', '')
        
        if not pubkey:
            self.send_json_response({'error': 'X-Pubkey header required'}, 400)
            return
        
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('DELETE FROM files WHERE cid = ? AND pubkey = ?', (cid, pubkey))
            deleted = c.rowcount
            conn.commit()
            conn.close()
            
            if deleted:
                self.send_json_response({'success': True, 'deleted': cid})
            else:
                self.send_json_response({'error': 'File not found or not owned by pubkey'}, 404)
                
        except Exception as e:
            self.send_json_response({'error': str(e)}, 500)
    
    def send_json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def serve_api_docs(self):
        """Serve API documentation"""
        docs = '''<!DOCTYPE html>
<html>
<head>
    <title>IPFS Encrypted Storage API</title>
    <style>
        body { font-family: system-ui; max-width: 900px; margin: 0 auto; padding: 20px; background: #0d1117; color: #c9d1d9; }
        h1 { color: #58a6ff; }
        h2 { color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 10px; margin-top: 40px; }
        pre { background: #161b22; padding: 15px; border-radius: 6px; overflow-x: auto; }
        code { color: #7ee787; }
        .endpoint { background: #21262d; padding: 10px 15px; border-radius: 6px; margin: 10px 0; }
        .method { display: inline-block; padding: 3px 8px; border-radius: 4px; font-weight: bold; margin-right: 10px; }
        .get { background: #238636; }
        .post { background: #1f6feb; }
        .delete { background: #da3633; }
        .param { color: #ffa657; }
    </style>
</head>
<body>
    <h1>🔐 IPFS Encrypted Storage API</h1>
    <p>Store encrypted data on IPFS with wallet-based key derivation.</p>
    
    <h2>File Index API</h2>
    
    <div class="endpoint">
        <span class="method get">GET</span>
        <code>/index/files?pubkey=<span class="param">{wallet_address}</span></code>
        <p>List all files uploaded by a wallet.</p>
        <pre>{
  "files": [
    {"cid": "Qm...", "filename": "my-file.txt", "size": 1234, "created_at": "2024-...", "encrypted": true}
  ],
  "count": 1
}</pre>
    </div>
    
    <div class="endpoint">
        <span class="method get">GET</span>
        <code>/index/file/<span class="param">{cid}</span></code>
        <p>Get metadata for a specific file.</p>
        <pre>{
  "pubkey": "AivknDqD...",
  "cid": "QmXxx...",
  "filename": "my-file.txt",
  "size": 1234,
  "created_at": "2024-...",
  "encrypted": true
}</pre>
    </div>
    
    <div class="endpoint">
        <span class="method post">POST</span>
        <code>/index/register</code>
        <p>Manually register a file in the index.</p>
        <p><strong>Body:</strong></p>
        <pre>{
  "pubkey": "AivknDqD...",
  "cid": "QmXxx...",
  "filename": "optional-name.txt",
  "size": 1234
}</pre>
    </div>
    
    <div class="endpoint">
        <span class="method delete">DELETE</span>
        <code>/index/file/<span class="param">{cid}</span></code>
        <p>Remove file from index (requires <code>X-Pubkey</code> header).</p>
        <p>Note: Does not delete from IPFS, only removes from index.</p>
    </div>
    
    <h2>IPFS Proxy API</h2>
    
    <div class="endpoint">
        <span class="method post">POST</span>
        <code>/api/v0/add?pin=true</code>
        <p>Upload file to IPFS. Add headers to auto-index:</p>
        <ul>
            <li><code>X-Pubkey</code>: Wallet address (for indexing)</li>
            <li><code>X-Filename</code>: Custom filename (optional, defaults to CID suffix)</li>
        </ul>
    </div>
    
    <div class="endpoint">
        <span class="method post">POST</span>
        <code>/api/v0/cat?arg=<span class="param">{cid}</span></code>
        <p>Retrieve file content from IPFS.</p>
    </div>
    
    <div class="endpoint">
        <span class="method post">POST</span>
        <code>/api/v0/pin/ls</code>
        <p>List pinned content.</p>
    </div>
    
    <h2>Encryption Flow</h2>
    <ol>
        <li>Connect wallet (X1, Phantom, Backpack)</li>
        <li>Sign derivation message → SHA256 → AES-256-GCM key</li>
        <li>Encrypt data client-side</li>
        <li>Upload encrypted blob to IPFS with <code>X-Pubkey</code> header</li>
        <li>CID and filename indexed in SQLite</li>
        <li>Reconnect wallet → list your files → decrypt any file</li>
    </ol>
    
    <p style="margin-top: 40px; color: #8b949e;">
        <a href="/crypto.html" style="color: #58a6ff;">← Back to App</a>
    </p>
</body>
</html>'''
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(docs.encode())

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    init_db()
    
    with http.server.HTTPServer(('0.0.0.0', PORT), IPFSProxyHandler) as httpd:
        print(f"IPFS Encrypted Storage running at http://0.0.0.0:{PORT}")
        print(f"API docs: http://0.0.0.0:{PORT}/doc")
        print(f"Proxying to {IPFS_API}")
        httpd.serve_forever()
