// -------------------------------------------------------------
// LOCAL TESTING ONLY - the garage server never runs this file.
//
// On the garage server, something sits in front of server.js that
// (1) serves the HTML/CSS/JS pages and (2) passes any request
// starting with /recipes/ on to server.js with that prefix removed
// (so /recipes/pantry arrives at server.js as /pantry).
//
// This file does that same job on your own computer, so the pages
// work exactly as they do on the garage server with no code
// changes. It also starts server.js for you, so one command runs
// everything:
//
//     npm run dev
//
// then open http://localhost:8080 in your browser. Ctrl+C stops both.
//
// Note: anything you add while testing locally gets saved into the
// CSV files in THIS folder - see the README before committing them.
// -------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEV_PORT = 8080;
const API_PORT = 3000; // must match PORT in server.js
const API_PREFIX = '/recipes';

// Only these kinds of files get served as pages - anything else
// (CSVs, credentials.js, server.js itself) is refused, so the dev
// server can't hand out your data files or passwords.
const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};
const BLOCKED_FILES = ['server.js', 'dev-server.js', 'credentials.js'];

// Start the real server.js as its own process, exactly as the
// garage server would run it.
const api = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'inherit' });
api.on('exit', code => {
    console.log(`server.js stopped (exit code ${code}) - stopping dev server too.`);
    process.exit(code || 0);
});
process.on('SIGINT', () => { api.kill(); process.exit(0); });

// Passes a /recipes/... request on to server.js with the prefix
// stripped, then streams server.js's reply back to the browser.
function proxyToApi(req, res) {
    const forwardPath = req.url.slice(API_PREFIX.length) || '/';
    const upstream = http.request({
        host: '127.0.0.1',
        port: API_PORT,
        method: req.method,
        path: forwardPath,
        headers: req.headers
    }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('server.js is not responding (it may still be starting up).');
    });
    req.pipe(upstream);
}

function serveStatic(req, res) {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(__dirname, urlPath);
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
    const insideFolder = filePath.startsWith(__dirname + path.sep);

    if (!type || !insideFolder || filePath.includes('node_modules') ||
        BLOCKED_FILES.includes(path.basename(filePath))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
    });
}

http.createServer((req, res) => {
    if (req.url.startsWith(API_PREFIX + '/')) {
        proxyToApi(req, res);
    } else {
        serveStatic(req, res);
    }
}).listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`Local site running at http://localhost:${DEV_PORT}`);
});
