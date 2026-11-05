import type {Client} from 'discord.js';
import {avatarCacheBytes} from './avatars';
import {log} from './log';
import {vaultMemory} from './vault/registry';

const INTERVAL_MS = 10 * 60 * 1000;

const mb = (n: number): number => Math.round(n / 1048576);

const report = (client: Client): void => {
  const m = process.memoryUsage();
  const v = vaultMemory();
  let members = 0;
  let messages = 0;
  for (const g of client.guilds.cache.values()) members += g.members.cache.size;
  for (const c of client.channels.cache.values()) if (c.isTextBased()) messages += c.messages.cache.size;
  log.info(
    'Memory: heap %d/%d MB, rss %d MB, external %d MB, array buffers %d MB; vaults %d (media %d MB, data %d MB); avatar cache %d MB; discord cache: users %d, channels %d, members %d, messages %d.',
    mb(m.heapUsed),
    mb(m.heapTotal),
    mb(m.rss),
    mb(m.external),
    mb(m.arrayBuffers),
    v.sessions,
    mb(v.media),
    mb(v.data),
    mb(avatarCacheBytes()),
    client.users.cache.size,
    client.channels.cache.size,
    members,
    messages,
  );
};

export const startMemoryLog = (client: Client): (() => void) => {
  const timer = setInterval(() => report(client), INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};
