import {Client, DiscordAPIError, EmbedBuilder, HTTPError, SendableChannels} from 'discord.js';
import {log} from '../../log';
import {FACTS, TOPIC_META} from './content';
import {contentFor} from './memory';
import {ClockTime, computeTimes, dueGroupNames, formatClock, nextFireTime, timesLabel} from './schedule';
import {getSettings, HealthGroup, HealthSettings} from './settings';
import {wallAt} from './zones';

const hasKey = <T>(o: Readonly<Record<string, T>>, k: string): boolean => Object.hasOwn(o, k);

const unknownTopic = (k: string): Error => new Error(`unknown health topic: ${k}`);

const weightedTopic = (topics: string[]): string => {
  const cum: number[] = [];
  let total = 0;
  for (const t of topics) {
    if (!hasKey(FACTS, t)) throw unknownTopic(t);
    total += FACTS[t].length;
    cum.push(total);
  }
  if (!(total > 0)) throw new RangeError('the fact topics of this group have no facts');
  const x = Math.random() * total;
  let i = cum.findIndex(c => c > x);
  if (i === -1) i = cum.length - 1;
  return topics[i];
};

const buildEmbed = (guildId: string, group: HealthGroup): EmbedBuilder => {
  const content = contentFor(guildId);
  const reminderLines: string[] = [];
  for (const topic of group.reminder_topics) {
    if (!hasKey(TOPIC_META, topic)) throw unknownTopic(topic);
    if (!hasKey(content.nudgeDecks, topic)) throw unknownTopic(topic);
    reminderLines.push(`${TOPIC_META[topic].emoji} ${content.nudgeDecks[topic].draw()}`);
  }

  const factTopic = weightedTopic(group.fact_topics);
  if (!hasKey(content.factDecks, factTopic)) throw unknownTopic(factTopic);
  const fact = content.factDecks[factTopic].draw();
  if (!hasKey(TOPIC_META, factTopic)) throw unknownTopic(factTopic);
  const factMeta = TOPIC_META[factTopic];

  return new EmbedBuilder()
    .setDescription(reminderLines.join('\n'))
    .setColor(group.color)
    .addFields({name: `💡 ${factMeta.kicker}`, value: fact, inline: false});
};

const ALLOWED = {parse: ['roles' as const]};

const isHttpError = (e: unknown): boolean => e instanceof DiscordAPIError || e instanceof HTTPError;

export const getChannelOrNone = async (client: Client, s: HealthSettings): Promise<SendableChannels | null> => {
  const cid = s.channel_id;
  if (!cid) return null;
  let channel = client.channels.cache.get(cid) ?? null;
  if (!channel) {
    try {
      channel = await client.channels.fetch(cid);
    } catch (e) {
      if (isHttpError(e)) return null;
      throw e;
    }
  }
  return channel && channel.isSendable() ? channel : null;
};

const guildLabel = (client: Client, guildId: string): string => client.guilds.cache.get(guildId)?.name ?? guildId;

const channelLabel = (channel: SendableChannels): string => ('name' in channel && channel.name ? channel.name : channel.id);

const warnedRoleless = new Set<string>();

export const sendRound = async (client: Client, guildId: string, channel: SendableChannels, only: string[] | null): Promise<number> => {
  const s = getSettings(guildId);
  const where = guildLabel(client, guildId);
  let sent = 0;
  const skippedRoleless: string[] = [];
  for (const [name, group] of Object.entries(s.groups)) {
    if (only !== null && !only.includes(name)) continue;
    if (!group.role_id) {
      if (only !== null) {
        skippedRoleless.push(name);
        const warnKey = `${guildId}\u0000${name}`;
        if (!warnedRoleless.has(warnKey)) {
          warnedRoleless.add(warnKey);
          log.warn("[%s] '%s' is scheduled but has NO role assigned, so nothing is sent for it. Fix with /health role.", where, name);
        }
      }
      continue;
    }
    try {
      const embed = buildEmbed(guildId, group);
      await channel.send({content: `<@&${group.role_id}>`, embeds: [embed], allowedMentions: ALLOWED});
      sent += 1;
      log.info('[%s] Sent %s reminder.', where, name);
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status === 403) {
        log.error("[%s] Missing permission to post/mention for '%s' in #%s.", where, name, channelLabel(channel));
      } else {
        log.exception(e, "[%s] Failed sending '%s' reminder.", where, name);
      }
    }
  }
  if (skippedRoleless.length) log.info('[%s] Skipped this round (no role): %s', where, skippedRoleless.join(', '));
  contentFor(guildId).memory.save();
  return sent;
};

const reminderTick = async (client: Client, guildId: string): Promise<void> => {
  const s = getSettings(guildId);
  if (!s.enabled) return;
  const where = guildLabel(client, guildId);
  const channel = await getChannelOrNone(client, s);
  if (!channel) {
    log.warn('[%s] No channel set yet. Use /health channel. Skipping this round.', where);
    return;
  }
  const now = wallAt(s.timezone, Date.now());
  const due = dueGroupNames(s, now);
  log.info('[%s] Woke at %s (%s); due: %s', where, formatClock(now), s.timezone, due.length ? due.join(', ') : 'nobody');
  if (!due.length) return;
  await sendRound(client, guildId, channel, due);
};

class ReminderLoop {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    const gen = ++this.generation;
    const s = getSettings(this.guildId);
    let times: ClockTime[];
    try {
      times = computeTimes(s);
    } catch (e) {
      log.exception(e, "[%s] Could not compute the reminder schedule.", guildLabel(this.client, this.guildId));
      this.timer = null;
      return;
    }
    const zone = s.timezone;
    log.info(
      '[%s] Reminder schedule (%s): shared %s; loop wakes at %s',
      guildLabel(this.client, this.guildId),
      zone,
      timesLabel(s),
      times.map(formatClock).join(', '),
    );
    this.arm(gen, times, zone, nextFireTime(times, zone, Date.now()));
  }

  restart(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(gen: number, times: ClockTime[], zone: string, target: number): void {
    if (gen !== this.generation) return;
    this.timer = setTimeout(() => void this.wake(gen, times, zone, target), Math.max(0, target - Date.now()));
    this.timer.unref();
  }

  private async wake(gen: number, times: ClockTime[], zone: string, target: number): Promise<void> {
    if (gen !== this.generation) return;
    if (Date.now() < target) {
      this.arm(gen, times, zone, target);
      return;
    }
    let next: number;
    try {
      next = nextFireTime(times, zone, Math.max(Date.now(), target + 1));
    } catch (e) {
      log.exception(e, '[%s] Could not compute the next reminder time.', guildLabel(this.client, this.guildId));
      this.timer = null;
      return;
    }
    try {
      await reminderTick(this.client, this.guildId);
    } catch (e) {
      log.exception(e, '[%s] Reminder round failed.', guildLabel(this.client, this.guildId));
    }
    this.arm(gen, times, zone, next);
  }
}

const loops = new Map<string, ReminderLoop>();

export const ensureLoop = (client: Client, guildId: string): void => {
  let loop = loops.get(guildId);
  if (!loop) {
    loop = new ReminderLoop(client, guildId);
    loops.set(guildId, loop);
  }
  if (!loop.running) loop.start();
};

export const reschedule = (client: Client, guildId: string): void => {
  const loop = loops.get(guildId);
  if (loop?.running) loop.restart();
  else ensureLoop(client, guildId);
};

export const stopLoop = (guildId: string): void => {
  loops.get(guildId)?.stop();
  loops.delete(guildId);
};

export const forgetRolelessWarnings = (guildId: string): void => {
  for (const k of warnedRoleless) if (k.startsWith(`${guildId}\u0000`)) warnedRoleless.delete(k);
};
