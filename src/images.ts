import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import sharp, {type Metadata} from 'sharp';
import {CLOUD_OBJECT_MAX_MB} from './cloud/cloudKeys';
import {tunables} from './config';
import {log} from './log';
import {errorText} from './util';

export const IMAGE_MAX_BYTES = CLOUD_OBJECT_MAX_MB * 1024 * 1024;
const SIDE_LIMIT = 10000;
const PIXEL_LIMIT = SIDE_LIMIT * SIDE_LIMIT;
const AVATAR_MAX = 256;
const JPEG_QUALITY = 80;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type ImageKind = 'avatar' | 'banner' | 'field';

export interface EncodedImage {
  mime: string;
  bytes: Uint8Array;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export const TOO_LARGE = `The image is larger than ${CLOUD_OBJECT_MAX_MB} MB.`;
const PRIVATE_LINK = 'That link points at a private or local address, which I do not fetch.';
const NOT_IMAGE = 'That file is not an image I can read. Use JPEG, PNG, GIF, WebP, AVIF or TIFF.';
const EMPTY = 'The download was empty.';

const isPrivateV4 = (ip: string): boolean => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const isPrivateV6 = (ip: string): boolean => {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateV4(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
};

export const isPrivateAddress = (ip: string): boolean => (isIP(ip) === 4 ? isPrivateV4(ip) : isPrivateV6(ip));

const webUrl = (link: string, base?: URL): URL => {
  let u: URL;
  try {
    u = new URL(link, base);
  } catch {
    throw new ImageError(base ? 'That link redirects to an invalid address.' : 'That is not a valid link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImageError('An image link must start with http:// or https://.');
  return u;
};

const checkHost = async (u: URL): Promise<void> => {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new ImageError(PRIVATE_LINK);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ImageError(PRIVATE_LINK);
    return;
  }
  let address: string;
  try {
    address = (await lookup(host)).address;
  } catch (e) {
    log.debug('Could not resolve %s: %s', host, errorText(e));
    throw new ImageError("That link's host could not be found.");
  }
  if (isPrivateAddress(address)) throw new ImageError(PRIVATE_LINK);
};

const discard = async (res: Response): Promise<void> => {
  try {
    await res.body?.cancel();
  } catch (e) {
    log.debug('Could not discard a response body: %s', errorText(e));
  }
};

const readCapped = async (res: Response): Promise<Uint8Array> => {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > IMAGE_MAX_BYTES) {
    await discard(res);
    throw new ImageError(TOO_LARGE);
  }
  const body = res.body;
  if (!body) throw new ImageError(EMPTY);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.length;
    if (total > IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ImageError(TOO_LARGE);
    }
    chunks.push(value);
  }
  if (!total) throw new ImageError(EMPTY);
  return Buffer.concat(chunks);
};

export const fetchImage = async (link: string): Promise<Uint8Array> => {
  let url = webUrl(link);
  for (let hop = 0; ; hop++) {
    await checkHost(url);
    let res: Response;
    try {
      res = await fetch(url, {signal: AbortSignal.timeout(tunables().downloadTimeoutMs), redirect: 'manual'});
    } catch (e) {
      log.debug('Image download from %s failed: %s', url.host, errorText(e));
      throw new ImageError('The image could not be downloaded. Check the link, or try again later.');
    }
    if (REDIRECTS.has(res.status)) {
      const to = res.headers.get('location');
      await discard(res);
      if (!to || hop >= MAX_REDIRECTS) throw new ImageError('That link redirects too many times.');
      url = webUrl(to, url);
      continue;
    }
    if (!res.ok) {
      await discard(res);
      throw new ImageError(`The image could not be downloaded (HTTP ${res.status}).`);
    }
    return readCapped(res);
  }
};

let queue: Promise<unknown> = Promise.resolve();

const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
};

const sniff = async (input: Uint8Array): Promise<Metadata> => {
  try {
    return await sharp(input, {limitInputPixels: PIXEL_LIMIT}).metadata();
  } catch (e) {
    log.debug('Image metadata could not be read: %s', errorText(e));
    throw new ImageError(NOT_IMAGE);
  }
};

export const encodeImage = (kind: ImageKind, input: Uint8Array, transparentAvatar: boolean): Promise<EncodedImage> =>
  serial(async () => {
    const meta = await sniff(input);
    if (!meta.width || !meta.height) throw new ImageError(NOT_IMAGE);
    if (meta.width * meta.height > PIXEL_LIMIT) throw new ImageError(`That image has too many pixels. Use one that is at most ${SIDE_LIMIT} by ${SIDE_LIMIT}.`);
    if (meta.format === 'gif') return {mime: 'image/gif', bytes: input};
    const max = kind === 'avatar' ? AVATAR_MAX : SIDE_LIMIT;
    const png = kind === 'avatar' && transparentAvatar;
    const pipeline = sharp(input, {limitInputPixels: PIXEL_LIMIT})
      .rotate()
      .resize({width: max, height: max, fit: 'inside', withoutEnlargement: true});
    let bytes: Buffer;
    try {
      bytes = await (png ? pipeline.png() : pipeline.jpeg({quality: JPEG_QUALITY})).toBuffer();
    } catch (e) {
      log.debug('Image could not be re-encoded: %s', errorText(e));
      throw new ImageError(NOT_IMAGE);
    }
    if (bytes.length > IMAGE_MAX_BYTES) throw new ImageError(TOO_LARGE);
    return {mime: png ? 'image/png' : 'image/jpeg', bytes};
  });
