# Plural Starbot

The Discord bot for Plural Star. It does two things:

- **Health reminders.** On a schedule the server sets, it pings chosen roles with a warm nudge about eating, drinking, taking meds, moving, resting your eyes, hygiene, or kindness, each with a related fact. Six reminder groups, each with its own role, schedule and colour, all configured in Discord with `/health`.
- **Proxying for plural systems.** Link your Plural Star cloud vault once, and the bot proxies your messages as your members (by each member's emoji, or autoproxy by whoever is fronting), shows system and member profiles, and lets you change the front from Discord. Everything comes from the vault; there is nothing to register in the bot.

Terms of Service: https://github.com/ByHanyou/Plural-Starbot/blob/main/TERMS.md
Privacy Policy: https://github.com/ByHanyou/Plural-Starbot/blob/main/PRIVACY.md

## Requirements

- Node.js 20 or newer.
- A Discord application with a bot user. Under **Bot → Privileged Gateway Intents**, **Message Content Intent** must be on (proxying reads messages). The invite needs the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Manage Messages, Manage Webhooks, Embed Links, Attach Files, Read Message History, Add Reactions, Mention Everyone (optional, for role pings).
- A reachable Plural Star cloud node. The bot is meant to run on the same machine as the node and talks to it over localhost.
- An HTTPS hostname on that machine for serving member avatars to Discord (the bot serves them itself; put the node's reverse proxy in front of it).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_BOT_TOKEN` – the bot token from the Developer Portal.
   - `CLOUD_NODE_URL` – the node's base URL as seen from the bot, for example `http://127.0.0.1:8080`.
   - `AVATAR_BASE_URL` – the public HTTPS base under which the bot's avatar route is reachable, for example `https://node.example.org/starbot`.
   - `AVATAR_PORT` – local port the avatar server listens on (the reverse proxy forwards `AVATAR_BASE_URL` here).
   - `DATA_DIR` – where the bot keeps its SQLite database (links, server settings, the 7-day proxied-message table).
3. `npm run build`, then `npm start`. For always-on hosting install `deploy/plural-starbot.service` next to the node's unit and `systemctl enable --now plural-starbot`.

Runtime files (`.env`, the database) are git-ignored, as are working notes such as `SPEC.md`.

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

Send the bot a direct message and run `/link`; it asks for your Plural Star cloud password. The bot derives your vault key from it, registers itself as a device named "Plural Starbot" on your vault, and keeps only that key and the auth secret. The password itself is never stored. `/unlink` removes the device and deletes the key.

### Proxying

- A member's **Emoji** field in their Plural Star profile (up to three emoji) is their proxy tag: a message that starts or ends with it is deleted and re-posted as that member. If several members share the same emoji, the one currently fronting is used (first listed), otherwise the first of them in your member list.
- `/autoproxy front` proxies every message as the first listed primary fronter; `/autoproxy member <name>` as a fixed member; `/autoproxy latch` as whichever member you last proxied as in that server (an emoji tag switches the latch; it expires after 6 hours without proxying); `/autoproxy off` turns it off. A message with an explicit tag always wins.
- React ❌ to a proxied message of yours to delete it, ❓ to see who sent it (private reply). `/proxy edit` edits your last proxied message, or one you point at by message ID.
- Attachments, replies and embeds are carried over.
- **Display name.** By default a proxied message is posted under the member's name. `/proxy format <template>` changes that using formatting tags filled from the member's profile: `{Emoji}`, `{Name}`, `{Pronouns}`, `{Role}` and `{Sys Tag}`; anything else in the template is kept as typed, and empty values disappear cleanly (for example `{Emoji} {Name} ({Pronouns}) | {Sys Tag}`). `/proxy systag <text>` sets your Sys Tag (20 characters max); `/proxy systag clear` removes it. Both commands take a `scope`: **everywhere** (your default) or **this server** (an override for the server you run it in). Run either without a value to see what is in effect and a preview.

### Profiles and front

All of these work on your own vault with nothing extra typed: the bot knows which vault is yours from the DM link. The optional `@user` at the end is only for looking at **someone else's** linked system (their private members stay hidden).

| Command | What it shows |
|---|---|
| `/system` (optionally `@user`) | System card: name, description, member count, linked account, avatar and banner |
| `/member <name>` (optionally `@user`) | Member card: display name, pronouns, role, colour, emoji, groups, description, avatar and banner |
| `/front show` (optionally `@user`) | Who is fronting, by tier, with how long |
| `/front set`, `/front add`, `/front remove`, `/front clear` | Change the front. `set` and `add` take `member` and `tier` (primary, cofront or coconscious; default primary); `remove` takes a member; `clear` empties every tier. Behaves exactly like Set Front in the app: history entry, start times, tiers |

Members marked private in Plural Star are shown only to their own system and are never named in front displays to others.

### Moderation log

`/proxylog channel #channel` makes the bot copy every proxied message in the server to that channel as an embed with the member shown, the content, the sender as a clickable mention, message IDs and a jump link. `/proxylog off` stops it. Requires Manage Server.

## Data

See the [Privacy Policy](https://github.com/ByHanyou/Plural-Starbot/blob/main/PRIVACY.md). In short: per linked user the bot stores the derived vault key and auth secret; per server its settings; per proxied message a 7-day record so edit, delete and lookup work. Vault contents are read into memory and never written to disk.

## Development

- `npm run typecheck` – TypeScript strict check.
- `npm run build` – compile to `dist/`.
- `npm run dev` – run from source with reload.

The vault engine (`src/cloud/cloudVault.ts`, `cloudCrypto.ts`, `cloudApi.ts`, `cloudTypes.ts`) is copied verbatim from the Plural Star app and must stay byte-identical with it.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
