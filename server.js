/**
 * Локальний сервер для AI Pulse (Node 18+, без залежностей).
 * - Роздає index.html та app.js
 * - /proxy?url=... пересилає запит до freeserp.ai на стороні сервера,
 *   тому браузер працює з тим самим origin і проблеми CORS немає.
 *
 * Запуск:  node server.js   →   http://localhost:3000
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ALLOWED_HOST = 'freeserp.ai'; // Проксі не працює як відкритий relay
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- API-проксі ---
    if (url.pathname === '/proxy') {
      try {
        const target = new URL(url.searchParams.get('url') ?? '');
        if (target.hostname !== ALLOWED_HOST) {
          res.writeHead(403).end('Host not allowed');
          return;
        }
        const upstream = await fetch(target, { headers: { Accept: 'application/json' } });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.writeHead(502).end(`Proxy error: ${err.message}`);
      }
      return;
    }

    // --- Статичні файли ---
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, () => console.log(`AI Pulse: http://localhost:${PORT}`));
