import {
  DiscordAPIError,
  ForumChannel,
  GuildTextBasedChannel,
  MediaChannel,
  Message,
  NewsChannel,
  RESTJSONErrorCodes,
  StageChannel,
  TextChannel,
  VoiceChannel,
  Webhook,
  WebhookMessageCreateOptions,
  WebhookType,
} from 'discord.js';
import {log} from '../../log';

const WEBHOOK_NAME = 'Plural Starbot';

export type WebhookHost = TextChannel | NewsChannel | VoiceChannel | StageChannel | ForumChannel | MediaChannel;

export interface WebhookTarget {
  host: WebhookHost;
  threadId?: string;
}

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

export const forgetWebhook = (hostId: string): void => {
  cache.delete(hostId);
};

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
