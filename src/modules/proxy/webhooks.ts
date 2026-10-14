// One bot-owned webhook per channel, cached in memory and re-created when Discord says it is gone.
import {
  DiscordAPIError,
  ForumChannel,
  GuildTextBasedChannel,
  MediaChannel,
  NewsChannel,
  RESTJSONErrorCodes,
  StageChannel,
  TextChannel,
  VoiceChannel,
  Webhook,
  WebhookMessageCreateOptions,
  WebhookType,
} from 'discord.js';
import type {Message} from 'discord.js';
import {log} from '../../log';

export const WEBHOOK_NAME = 'Plural Starbot';

/** Channels that own webhooks. Threads post through their parent's webhook with threadId. */
export type WebhookHost = TextChannel | NewsChannel | VoiceChannel | StageChannel | ForumChannel | MediaChannel;

export interface WebhookTarget {
  host: WebhookHost;
  /** Set when the message lives in a thread. */
  threadId?: string;
}

/** Where a channel's proxied messages are posted, or null for channels without webhooks. */
export const targetOf = (channel: GuildTextBasedChannel): WebhookTarget | null => {
  if (channel.isThread()) {
    const parent = channel.parent;
    return parent ? {host: parent, threadId: channel.id} : null;
  }
  return {host: channel};
};

type BotHook = Webhook<WebhookType.Incoming>;

const cache = new Map<string, BotHook>();
const pending = new Map<string, Promise<BotHook>>();

export const isApiError = (e: unknown, code: number): boolean => e instanceof DiscordAPIError && e.code === code;

/** The bot's webhook in a channel: cached, else an existing one the bot owns, else a new one. Needs Manage Webhooks. */
export const webhookFor = (host: WebhookHost): Promise<BotHook> => {
  const hit = cache.get(host.id);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(host.id);
  if (inFlight) return inFlight;
  const botId = host.client.user.id;
  const p = (async () => {
    const hooks = await host.fetchWebhooks();
    let hook: BotHook | undefined;
    for (const w of hooks.values()) {
      if (w.isIncoming() && w.token && w.owner?.id === botId) {
        hook = w;
        break;
      }
    }
    if (!hook) {
      hook = await host.createWebhook({name: WEBHOOK_NAME, reason: 'Proxying messages for Plural Star systems'});
      log.info("Created the proxy webhook in #%s ('%s').", host.name, host.guild.name);
    }
    cache.set(host.id, hook);
    return hook;
  })().finally(() => pending.delete(host.id));
  pending.set(host.id, p);
  return p;
};

/** Drops a cached webhook (it was deleted, or its channel was). */
export const forgetWebhook = (hostId: string): void => {
  cache.delete(hostId);
};

/** Sends through the channel's webhook; when the cached webhook was deleted, re-creates it and retries once. */
export const sendViaWebhook = async (target: WebhookTarget, options: WebhookMessageCreateOptions): Promise<Message<true>> => {
  const opts: WebhookMessageCreateOptions = target.threadId ? {...options, threadId: target.threadId} : options;
  const hook = await webhookFor(target.host);
  try {
    return await hook.send(opts);
  } catch (e) {
    if (!isApiError(e, RESTJSONErrorCodes.UnknownWebhook)) throw e;
    forgetWebhook(target.host.id);
    return (await webhookFor(target.host)).send(opts);
  }
};
