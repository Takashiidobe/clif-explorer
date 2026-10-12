import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
};

const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};

export async function serve(dir, port = 0) {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = path === '/' ? 'index.html' : path;
    try {
      const body = await readFile(join(dir, file));
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain', ...ISOLATION_HEADERS }).end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'dist');
  const { url } = await serve(dir, Number(process.env.PORT ?? 8000));
  console.log(`serving ${dir} at ${url}`);
}
