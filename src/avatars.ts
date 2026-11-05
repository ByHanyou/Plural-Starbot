import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {config} from './config';
import {log} from './log';
import {errorText} from './util';
import {allSessions} from './vault/registry';
import type {VaultSession} from './vault/session';
import {isPublicImageKey} from './vault/types';

const ROUTE = /\/avatar\/([0-9a-f]{64})$/;
const SERVED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CACHE_OK = 'public, max-age=86400';
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface Image {
  mime: string;
  body: Buffer;
}

interface Located {
  session: VaultSession;
  key: string;
  mime: string;
}

const cache = new Map<string, Image>();
let cacheBytes = 0;
const loading = new Map<string, Promise<Image | null>>();

export const avatarCacheBytes = (): number => cacheBytes;

const remember = (id: string, img: Image): void => {
  if (img.body.length > CACHE_MAX_BYTES) return;
  const old = cache.get(id);
  if (old) {
    cache.delete(id);
    cacheBytes -= old.body.length;
  }
  cache.set(id, img);
  cacheBytes += img.body.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= v.body.length;
  }
};

const cached = (id: string): Image | undefined => {
  const img = cache.get(id);
  if (!img) return undefined;
  cache.delete(id);
  cache.set(id, img);
  return img;
};

const locate = (id: string): Located | null => {
  for (const s of allSessions()) {
    const key = s.mediaKeyForObjectId(id);
    if (!key || !isPublicImageKey(key)) continue;
    const mime = s.mediaMime(key);
    if (!mime || !SERVED_TYPES.has(mime)) continue;
    return {session: s, key, mime};
  }
  return null;
};

const fetchImage = async (id: string, at: Located): Promise<Image | null> => {
  const bytes = await at.session.readMedia(at.key);
  if (!bytes) return null;
  const img: Image = {mime: at.mime, body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)};
  remember(id, img);
  return img;
};

const loadImage = (id: string): Promise<Image | null> => {
  const at = locate(id);
  if (!at) return Promise.resolve(null);
  const have = cached(id);
  if (have) return Promise.resolve(have);
  const inFlight = loading.get(id);
  if (inFlight) return inFlight;
  const p = fetchImage(id, at).finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
};

export const avatarUrlFor = (session: VaultSession, key: string): string | undefined => {
  if (!isPublicImageKey(key)) return undefined;
  const id = session.mediaObjectId(key);
  const mime = session.mediaMime(key);
  if (!id || !mime || !SERVED_TYPES.has(mime)) return undefined;
  return `${config().avatarBaseUrl}/avatar/${id}`;
};

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end('Not found');
};

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const method = req.method || 'GET';
  let path = '/';
  try {
    path = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {}
  const m = ROUTE.exec(path);
  if (!m) {
    notFound(res);
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8'});
    res.end('Method not allowed');
    return;
  }
  let img: Image | null;
  try {
    img = await loadImage(m[1]);
  } catch (e) {
    log.debug('Could not fetch image %s from the vault: %s', m[1], errorText(e));
    img = null;
  }
  if (!img) {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': img.mime,
    'Content-Length': String(img.body.length),
    'Cache-Control': CACHE_OK,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : img.body);
};

export const startAvatarServer = (port: number, host = '127.0.0.1'): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch(e => {
        log.exception(e, 'Avatar request failed.');
        if (!res.headersSent) res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Server error');
      });
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', e => log.exception(e, 'Avatar server error.'));
      resolve(server);
    });
  });
