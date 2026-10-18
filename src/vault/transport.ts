import type {CloudRequest, CloudResponse, CloudTransport} from '../cloud/cloudTypes';
import {lookupWindow} from './throttle';

const DEFAULT_TIMEOUT_MS = 30000;

export class VaultCreateRefused extends Error {
  constructor() {
    super('Plural Starbot never creates vaults.');
    this.name = 'VaultCreateRefused';
  }
}

const isPost = (req: CloudRequest, suffix: string): boolean => {
  if (req.method !== 'POST') return false;
  try {
    return new URL(req.url).pathname.replace(/\/+$/, '').endsWith(suffix);
  } catch {
    return false;
  }
};

const isCreateRequest = (req: CloudRequest): boolean => isPost(req, '/cloud/vault/create');

const isLookupRequest = (req: CloudRequest): boolean => isPost(req, '/cloud/vault/lookup');

export const fetchTransport: CloudTransport = {
  async request(req: CloudRequest): Promise<CloudResponse> {
    if (isCreateRequest(req)) throw new VaultCreateRefused();
    if (isLookupRequest(req)) await lookupWindow.acquire();
    const headers: Record<string, string> = {...req.headers};
    const hasBody = typeof req.bodyBase64 === 'string' && req.method !== 'GET' && req.method !== 'HEAD';
    if (hasBody && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/octet-stream';
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.from(req.bodyBase64 as string, 'base64') : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      const out: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      const bodyBase64 = req.method === 'HEAD' ? '' : Buffer.from(await res.arrayBuffer()).toString('base64');
      return {status: res.status, headers: out, bodyBase64};
    } catch (e) {
      if (controller.signal.aborted) throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },
};
