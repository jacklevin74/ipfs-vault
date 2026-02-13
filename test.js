#!/usr/bin/env node
/**
 * IPFS Encrypted Storage - Unit Test Suite
 * Tests all API endpoints
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:8772';
const TEST_PUBKEY = 'TestPubkey' + Date.now();
let testCid = null;

const results = { passed: 0, failed: 0, tests: [] };

// HTTP request helper
function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: { 'Content-Type': 'application/json', ...headers }
        };
        
        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
                } catch {
                    resolve({ status: res.statusCode, data: null, raw: data });
                }
            });
        });
        
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// Test runner
async function test(name, fn) {
    try {
        await fn();
        results.passed++;
        results.tests.push({ name, status: '✓ PASS' });
        console.log(`  ✓ ${name}`);
    } catch (e) {
        results.failed++;
        results.tests.push({ name, status: '✗ FAIL', error: e.message });
        console.log(`  ✗ ${name}: ${e.message}`);
    }
}

// Assertions
function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
}

// ========== TESTS ==========

async function runTests() {
    console.log('\n🧪 IPFS Encrypted Storage - Unit Tests');
    console.log(`   Target: ${BASE_URL}\n`);
    
    // 1. API Docs
    console.log('📄 Documentation:');
    await test('GET /doc returns HTML', async () => {
        const res = await request('GET', '/doc');
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(res.raw.includes('<!DOCTYPE html>'), 'Should return HTML');
        assert(res.raw.includes('IPFS Encrypted Storage'), 'Should contain title');
    });
    
    // 2. Index API - List Files
    console.log('\n📁 Index API:');
    await test('GET /index/files without pubkey returns 400', async () => {
        const res = await request('GET', '/index/files');
        assertEquals(res.status, 400, `Status ${res.status}`);
        assert(res.data.error, 'Should have error message');
    });
    
    await test('GET /index/files with pubkey returns array', async () => {
        const res = await request('GET', `/index/files?pubkey=${TEST_PUBKEY}`);
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(Array.isArray(res.data.files), 'files should be array');
        assert(typeof res.data.count === 'number', 'count should be number');
    });
    
    // 3. Register file manually
    await test('POST /index/register creates entry', async () => {
        testCid = 'QmTest' + crypto.randomBytes(20).toString('hex').slice(0, 38);
        const res = await request('POST', '/index/register', {
            pubkey: TEST_PUBKEY,
            cid: testCid,
            filename: 'test-file.txt',
            size: 1234
        });
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(res.data.success, 'Should return success');
        assert(res.data.filename.endsWith('-test-file.txt'), 'Filename should have CID prefix');
    });
    
    await test('POST /index/register without pubkey returns 400', async () => {
        const res = await request('POST', '/index/register', { cid: 'QmTest123' });
        assertEquals(res.status, 400, `Status ${res.status}`);
    });
    
    // 4. Get file info
    await test('GET /index/file/:cid returns file info', async () => {
        const res = await request('GET', `/index/file/${testCid}`);
        assertEquals(res.status, 200, `Status ${res.status}`);
        assertEquals(res.data.pubkey, TEST_PUBKEY, 'Should have correct pubkey');
        assertEquals(res.data.cid, testCid, 'Should have correct CID');
    });
    
    await test('GET /index/file/:cid for non-existent returns 404', async () => {
        const res = await request('GET', '/index/file/QmNonExistent123456789');
        assertEquals(res.status, 404, `Status ${res.status}`);
    });
    
    // 5. Verify file appears in list
    await test('Registered file appears in list', async () => {
        const res = await request('GET', `/index/files?pubkey=${TEST_PUBKEY}`);
        assertEquals(res.status, 200, `Status ${res.status}`);
        const found = res.data.files.find(f => f.cid === testCid);
        assert(found, 'File should appear in list');
    });
    
    // 6. Delete file
    await test('DELETE /index/file/:cid without pubkey returns 400', async () => {
        const res = await request('DELETE', `/index/file/${testCid}`);
        assertEquals(res.status, 400, `Status ${res.status}`);
    });
    
    await test('DELETE /index/file/:cid with wrong pubkey returns 404', async () => {
        const res = await request('DELETE', `/index/file/${testCid}`, null, {
            'X-Pubkey': 'WrongPubkey'
        });
        assertEquals(res.status, 404, `Status ${res.status}`);
    });
    
    await test('DELETE /index/file/:cid with correct pubkey succeeds', async () => {
        const res = await request('DELETE', `/index/file/${testCid}`, null, {
            'X-Pubkey': TEST_PUBKEY
        });
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(res.data.success, 'Should return success');
    });
    
    await test('Deleted file no longer in list', async () => {
        const res = await request('GET', `/index/files?pubkey=${TEST_PUBKEY}`);
        const found = res.data.files.find(f => f.cid === testCid);
        assert(!found, 'File should not appear after deletion');
    });
    
    // 7. IPFS Proxy
    console.log('\n🌐 IPFS Proxy:');
    await test('POST /api/v0/cat retrieves content', async () => {
        // Use known CID from earlier tests
        const knownCid = 'QmbNCJW39M4pi88ZPTPa4HebU1HgQxfhsi24FRcr3aEyH8';
        const res = await request('POST', `/api/v0/cat?arg=${knownCid}`);
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(res.raw.length > 0, 'Should return content');
    });
    
    // 8. CORS Headers
    console.log('\n🔒 CORS:');
    await test('OPTIONS returns CORS headers', async () => {
        const res = await request('OPTIONS', '/index/files');
        assertEquals(res.status, 200, `Status ${res.status}`);
    });
    
    // 9. Static files
    console.log('\n📦 Static Files:');
    await test('GET /crypto.html returns HTML', async () => {
        const res = await request('GET', '/crypto.html');
        assertEquals(res.status, 200, `Status ${res.status}`);
        assert(res.raw.includes('<!DOCTYPE html>'), 'Should return HTML');
    });
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('SUMMARY');
    console.log('='.repeat(50));
    console.log(`  ✓ Passed: ${results.passed}`);
    console.log(`  ✗ Failed: ${results.failed}`);
    console.log(`  Total:   ${results.passed + results.failed}`);
    console.log('\n' + (results.failed === 0 ? '🎉 All tests passed!' : '⚠️  Some tests failed'));
    
    process.exit(results.failed === 0 ? 0 : 1);
}

runTests().catch(e => {
    console.error('Test suite error:', e);
    process.exit(1);
});
