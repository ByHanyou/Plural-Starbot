import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {splitDataUri} from './cloud/cloudCrypto';
import {config} from './config';
import {log} from './log';
import {allSessions} from './vault/registry';
import type {VaultSession} from './vault/session';
import {isPublicImageKey} from './vault/types';

const ROUTE = /\/avatar\/([0-9a-f]{64})$/;
const SERVED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CACHE_OK = 'public, max-age=86400';

const mimeOf = (dataUri: string): string => (/^data:([^;,]+)/.exec(dataUri)?.[1] || '').toLowerCase();

/** Image bytes for a vault object id, looked up across every session in memory (avatars and banners only). */
export const findImage = (id: string): {mime: string; bytes: Uint8Array} | null => {
  for (const s of allSessions()) {
    const key = s.mediaKeyForObjectId(id);
    if (!key || !isPublicImageKey(key)) continue;
    const uri = s.mediaDataUri(key);
    if (!uri) continue;
    const parts = splitDataUri(uri);
    if (!parts) continue;
    const mime = parts.mime.toLowerCase();
    if (!SERVED_TYPES.has(mime)) continue;
    return {mime, bytes: parts.bytes};
  }
  return null;
};

/** Public URL for a member/system avatar or banner key (e.g. ps:media:av:<memberId>), or undefined when there is none. */
export const avatarUrlFor = (session: VaultSession, key: string): string | undefined => {
  if (!isPublicImageKey(key)) return undefined;
  const id = session.mediaObjectId(key);
  const uri = session.mediaDataUri(key);
  if (!id || !uri || !SERVED_TYPES.has(mimeOf(uri))) return undefined;
  return `${config().avatarBaseUrl}/avatar/${id}`;
};

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  const method = req.method || 'GET';
  let path = '/';
  try {
    path = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {}
  const m = ROUTE.exec(path);
  if (!m) {
    res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end('Not found');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8'});
    res.end('Method not allowed');
    return;
  }
  const img = findImage(m[1]);
  if (!img) {
    res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': img.mime,
    'Content-Length': String(img.bytes.length),
    'Cache-Control': CACHE_OK,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : Buffer.from(img.bytes.buffer, img.bytes.byteOffset, img.bytes.length));
};

/** Starts the avatar server on 127.0.0.1:<port>; the reverse proxy forwards AVATAR_BASE_URL to it. */
export const startAvatarServer = (port: number, host = '127.0.0.1'): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        handle(req, res);
      } catch (e) {
        log.exception(e, 'Avatar request failed.');
        if (!res.headersSent) res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Server error');
      }
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', e => log.exception(e, 'Avatar server error.'));
      resolve(server);
    });
  });
