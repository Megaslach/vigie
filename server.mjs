// Serveur local de Vigie : sert l'interface et garde les actualités à jour.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, refresh, snapshot } from './news.mjs';

const PORT = Number(process.env.PORT) || 4747;
const REFRESH_EVERY = 15 * 60 * 1000;
const MIN_MANUAL_GAP = 60 * 1000;
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

await load();
let current = snapshot();
let running = null;

const runRefresh = () => running ??= refresh()
  .then(snap => { current = snap; })
  .catch(err => console.error('Mise à jour échouée :', err))
  .finally(() => { running = null; });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/news.json') return json(res, 200, current);
  if (req.method === 'GET' && path === '/status.json') return json(res, 200, { generatedAt: current.generatedAt, refreshing: !!running, local: true });
  if (req.method === 'POST' && path === '/refresh') {
    if (Date.now() - current.generatedAt > MIN_MANUAL_GAP) runRefresh();
    return json(res, 202, { refreshing: !!running });
  }
  const file = req.method === 'GET' && FILES[path];
  if (!file) return json(res, 404, { error: 'introuvable' });
  try {
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(await readFile(join(PUBLIC, file[0])));
  } catch (err) {
    console.error(err);
    res.destroy();
  }
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Le port ${PORT} est déjà utilisé : Vigie tourne peut-être déjà.` : err);
  process.exit(1);
});

// 127.0.0.1 uniquement : rien n'est exposé sur le réseau.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Vigie : http://localhost:${PORT}`);
  runRefresh();
  setInterval(runRefresh, REFRESH_EVERY);
});
