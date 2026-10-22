# Plural Starbot

The Discord bot for Plural Star. It does two things:

- **Health reminders.** On a schedule the server sets, it pings chosen roles with a warm nudge about eating, drinking, taking meds, moving, resting your eyes, hygiene, or kindness, each with a related fact. Six reminder groups, each with its own role, schedule and colour, all configured in Discord with `/health`.
- **Proxying for plural systems.** Link your Plural Star cloud vault once, and the bot proxies your messages as your members (by each member's emoji, or autoproxy by whoever is fronting), shows system and member profiles, and lets you change the front from Discord. Everything comes from the vault; there is nothing to register in the bot.

Terms of Service: https://github.com/ByHanyou/Plural-Starbot/blob/main/TERMS.md
Privacy Policy: https://github.com/ByHanyou/Plural-Starbot/blob/main/PRIVACY.md

## Requirements

- Node.js 24.7 or newer.
- A Discord application with a bot user. Under **Bot → Privileged Gateway Intents**, **Message Content Intent** must be on (proxying reads messages). The invite needs the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Manage Messages, Manage Webhooks, Embed Links, Attach Files, Read Message History, Add Reactions, Mention Everyone (optional, for role pings).
- A reachable Plural Star cloud node. The bot is meant to run on the same machine as the node and talks to it over localhost.
- An HTTPS hostname on that machine for serving member avatars to Discord (the bot serves them itself; put the node's reverse proxy in front of it).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_BOT_TOKEN` – the bot token from the Developer Portal.
   - `CLOUD_NODE_URL` – the node's base URL as seen from the bot, for example `http://127.0.0.1:7523`.
   - `AVATAR_BASE_URL` – the public HTTPS base under which the bot's avatar route is reachable, for example `https://node.example.org/starbot`.
   - `AVATAR_PORT` – local port the avatar server listens on (the reverse proxy forwards `AVATAR_BASE_URL` here).
   - `DATA_DIR` – where the bot keeps its SQLite database (links, server settings, the proxied-message table). With the systemd unit below it must be `/var/lib/plural-starbot`, the only directory the unit lets the bot write to.
3. `npm run build`, then `npm start`. For always-on hosting install `deploy/plural-starbot.service` next to the node's unit and `systemctl enable --now plural-starbot`.

Runtime files (`.env`, the database) are git-ignored, as are working notes such as `SPEC.md`.

### Tunables

Every timing and limit below has a default and can be changed in `.env`. A value the bot cannot use (not a whole number, not a timezone name, an unknown log level) stops it from starting, with the reason printed.

| Variable | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; `debug` and `info` lines go to stdout, `warn` and `error` to stderr |
| `DEV_GUILD_ID` | empty | development only: the ID of one server. Every command is registered to that server, where changes show up at once, and the global command list is cleared. Leave it empty on a bot other people use |
| `BUTTON_WAIT_MS` | `1500` | how long a button press waits for the vault before deferring the reply |
| `PROFILE_STALE_MINUTES` | `15` | age after which a profile card says its front may be stale |
| `DEFAULT_TIMEZONE` | `America/New_York` | timezone of a server that has not set one with `/health timezone` |
| `MEMORY_REUSE_COOLDOWN_HOURS` | `48` | how long a health nudge or fact is not repeated in a server |
| `LATCH_HOURS` | `6` | how long `/autoproxy latch` keeps the last proxied member |
| `DOWNLOAD_TIMEOUT_SECONDS` | `60` | timeout for downloading an attachment to re-upload it through the webhook |
| `VAULT_CHECK_INTERVAL_SECONDS` | `120` | how often a linked vault is checked for changes |
| `VAULT_FRESH_SECONDS` | `30` | a vault read younger than this is reused instead of refreshed |
| `VAULT_SETTLE_TIMEOUT_SECONDS` | `20` | how long a write waits for the vault to confirm the push |
| `VAULT_HTTP_TIMEOUT_SECONDS` | `30` | timeout of one HTTP call to the node |
| `PROXIED_RETENTION_DAYS` | `7` | how long proxied-message records are kept for edit, delete and lookup |
| `PURGE_INTERVAL_MINUTES` | `60` | how often expired proxied-message records are deleted |
| `LOOKUPS_PER_MINUTE` | `4` | vault lookups the bot sends to the node per minute, across all users |
| `LINK_SLOTS` | `2` | `/link` operations that may run at the same time |
| `VAULT_JSON_TIMEOUT_SECONDS` | `15` | timeout of one JSON call of the vault engine to the node |
| `VAULT_OBJECT_TIMEOUT_SECONDS` | `120` | timeout of one object upload or download of the vault engine |
| `VAULT_PUSH_DEBOUNCE_SECONDS` | `4` | how long the vault engine waits after a local change before pushing |
| `VAULT_RETRY_BASE_SECONDS` | `5` | first retry delay after a failed vault sync; doubles each time |
| `VAULT_RETRY_MAX_SECONDS` | `300` | longest retry delay after failed vault syncs |
| `VAULT_CHECK_MIN_INTERVAL_SECONDS` | `20` | minimum gap between two vault checks started by a wake |
| `VAULT_UNLINK_WAIT_SECONDS` | `20` | how long an unlink waits for a running sync to finish |
| `VAULT_SENT_SAVE_SECONDS` | `5` | how often the link state is saved during a long upload |
| `LINK_ATTEMPTS` | `3` | `/link` attempts one user may make within `LINK_ATTEMPT_WINDOW_MINUTES` |
| `LINK_ATTEMPT_WINDOW_MINUTES` | `10` | the window those attempts are counted in |
| `SHUTDOWN_SETTLE_SECONDS` | `5` | how long a shutdown waits for running vault syncs to finish |
| `SESSION_LOAD_CONCURRENCY` | `4` | linked vaults opened at the same time at startup |

## Using it

### Health reminders

Type `/health` in any channel (requires Manage Server):

| Command | What it does |
|---|---|
| `/health channel` | Channel reminders post in |
| `/health role` | Role to ping for a group (Nutrition, Medicine, Activity, Eye Strain, Hygiene, Kindness) |
| `/health starttime` / `/health interval` | Shared schedule: first ping (24-hour `HH:MM`) and hours between pings (1, 2, 3, 4, 6, 8, 12, 24) |
| `/health groupschedule` | Give one group its own start time and interval, or send it back to the shared one |
| `/health timezone` | IANA timezone, e.g. `America/New_York` |
| `/health test` | Fire one round now |
| `/health show` | Current settings and the exact ping times |
| `/health enable` / `/health disable` | Turn the schedule on or pause it |

`/help` (anywhere, including DMs) shows this whole command list inside Discord.

### Linking your vault

Send the bot a direct message and run `/link`; it asks for your Plural Star cloud password. The bot derives your vault key from it, registers itself as a device named "Plural Starbot" on your vault, and keeps only that key, the auth secret and the device key the node issues to it. The password itself is never stored. `/unlink` removes the device and deletes the key.

### Proxying

- A member's **Emoji** field in their Plural Star profile (up to three emoji) is their proxy tag: a message that starts or ends with it is deleted and re-posted as that member. If several members share the same emoji, the one currently fronting is used (first listed), otherwise the first of them in your member list.
- `/autoproxy front` proxies every message as the first listed primary fronter; `/autoproxy member <name>` as a fixed member; `/autoproxy latch` as whichever member you last proxied as in that server (an emoji tag switches the latch; it expires after 6 hours without proxying, `LATCH_HOURS`); `/autoproxy off` turns it off. A message with an explicit tag always wins.
- React ❌ to a proxied message of yours to delete it, ❓ to see who sent it (private reply). `/proxy edit` edits your last proxied message, or one you point at by message ID.
- Attachments are carried over up to the server's upload limit, with a note for any file that is too large. A reply keeps a quote of the message it answers, and suppressed link previews and silent notifications stay that way.
- **Display name.** By default a proxied message is posted under the member's name. `/proxy format <template>` changes that using formatting tags filled from the member's profile: `{Emoji}`, `{Name}`, `{Pronouns}`, `{Role}` and `{Sys Tag}`; anything else in the template is kept as typed, and empty values disappear cleanly (for example `{Emoji} {Name} ({Pronouns}) | {Sys Tag}`). Add `member:<emoji or name>` to give one member their own format, used instead of yours: pick them from the list, or type their name or emoji (when several members share that emoji, type the name). Facets can have one; custom fronts are never proxied, so they cannot. `default` or `reset` as the template removes that member's format, so they go back to yours. `/proxy systag <text>` sets your Sys Tag (20 characters max); `/proxy systag clear` removes it. Both commands take a `scope`: **everywhere** (your default) or **this server** (an override for the server you run it in). The most specific format wins: a member's own format for this server, then their own format everywhere, then yours for this server, then yours everywhere. Run either without a value to see what is in effect and a preview (with `member`, for that member).

### Profiles and front

All of these work on your own vault with nothing extra typed: the bot knows which vault is yours from the DM link. The optional `@user` at the end is only for looking at **someone else's** linked system (their private members stay hidden).

| Command | What it shows |
|---|---|
| `/system` (optionally `@user`) | System card: name, description, member count, linked account, avatar and banner |
| `/member <name>` (optionally `@user`) | Member card: display name, pronouns, role, colour, emoji, tags, groups, description, avatar and banner, with Custom Fields on further pages |
| `/front show` (optionally `@user`) | Who is fronting, by tier, with how long |
| `/front set`, `/front add`, `/front remove`, `/front clear` | Change the front. `set` adds one or more members (comma-separated) to a tier and keeps who is already there; `add` takes one member; both take `tier` (primary, cofront or coconscious; default primary) and move the members out of other tiers; `remove` takes a member; `clear` empties every tier. Behaves exactly like Set Front in the app: history entry, start times, tiers |

Members marked private in Plural Star are shown only to their own system and are never named in front displays to others.

### Moderation log

`/proxylog channel #channel` makes the bot copy every proxied message in the server to that channel as an embed with the member shown, the content, the sender as a clickable mention, message IDs and a jump link. `/proxylog off` stops it. Requires Manage Server.

## Data

See the [Privacy Policy](https://github.com/ByHanyou/Plural-Starbot/blob/main/PRIVACY.md). In short: per linked user the bot stores the derived vault key, the auth secret and its device key; per server its settings; per proxied message a record kept 7 days (`PROXIED_RETENTION_DAYS`) so edit, delete and lookup work. Vault contents are read into memory and never written to disk.

## Development

- `npm run typecheck` – TypeScript strict check.
- `npm run build` – compile to `dist/`.
- `npm run dev` – run from source with reload.

The vault engine and the rich-text parser come from the Plural Star app. `src/cloud/cloudCrypto.ts`, `cloudApi.ts`, `cloudTypes.ts`, `cloudManifest.ts`, `cloudPlan.ts`, `sealedCache.ts` and `src/markdown/parse.ts` must stay byte-identical with the app's copies. `src/cloud/cloudVault.ts`, `cloudKeys.ts` and `cloudLinking.ts` differ from the app's copies only in their imports and logging calls, and must not drift further.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
