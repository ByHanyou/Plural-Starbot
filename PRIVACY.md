# Plural Starbot Privacy Policy

Last updated: 2026-10-14

Plural Starbot ("the bot") is operated by The Hanyou System ("we", "us"). Contact: The1Hanyou@gmail.com.

This policy explains what the bot stores, what it processes without storing, and how to remove your data.

## 1. What the bot stores

The bot keeps as little as it can. On its own server it stores:

| Data | Why | Kept until |
|---|---|---|
| Your Discord user ID together with the vault link record: the key and authentication secret derived from your Plural Star cloud password, the vault's lookup ID, the manifest version, link and last-check timestamps, and the list of vault entries the bot holds with their content hashes | To open your vault, act as one of its devices, and know what has changed since its last check | You run `/unlink` |
| Per-server settings chosen by moderators: reminder channel, roles, schedule and timezone, plus the reminder bot's two-day memory of which nudges and facts it has posted; proxy log channel; per user: autoproxy settings, proxy display-name format and Sys Tag (a global default and any per-server override) | To run reminders, proxying and logging the way the server configured them | The setting is changed or the bot leaves the server |
| For each proxied message: the new message ID, the original message ID, the server, the channel, the member, your user ID and the time | So that you can edit or delete a proxied message and so moderators can see who sent it | 7 days, then deleted automatically |
| Operational logs on the bot's server, which can include Discord user IDs, server names and error details, never message content or vault contents | To diagnose problems | Rotated with the server's logs |

The bot never stores your cloud password. It does not store your vault contents on disk: your members, front, system profile and avatars are read from your vault into memory while the bot runs and are re-read from the vault, not kept.

## 2. What the bot processes without storing

- **Message content.** The bot receives the content of messages in the servers it is in (Discord's Message Content intent). It only acts on a message when it starts or ends with one of your members' emoji or your autoproxy setting applies; that message is deleted and its content re-posted through a webhook. Messages that do not match are not kept.
- **Attachments.** Files on a proxied message are re-uploaded with the proxied message and then not kept.
- **Avatars.** To show a member's avatar on a proxied message, the bot serves that avatar image from your vault over HTTPS at an unguessable address. Anyone who has the address can view the image, as with any Discord avatar.
- **Vault writes.** When you change the front with the bot's commands, the bot writes the new front and the matching history entry into your vault, exactly as the Plural Star app would.

## 3. Where the data lives

The bot runs on the same server as the Plural Star cloud node, in the United States. Your vault itself is end-to-end encrypted; the node cannot read it. The bot can read it only because you gave it the key when you linked.

## 4. Who sees what

- **Discord** receives the proxied messages, webhooks and reactions as part of normal operation.
- **Server moderators** can turn on a log channel; proxied messages are then copied there with your Discord tag and user ID. That log is a normal Discord channel under the server's control, not ours.
- **Other users** see your members through proxied messages and the `/member`, `/system` and `/front` commands. Members marked private in Plural Star are left out of what other users get from those commands and from front displays; but a private member you choose to proxy as (by tag or autoproxy) appears on that proxied message, and in the server's proxy log, like any other.

We do not sell data, share it with advertisers, or use it for anything other than running the bot.

## 5. Removing your data

- `/unlink` removes the bot from your vault's devices and deletes the stored key and secret for your Discord account.
- Proxied-message records expire after 7 days on their own; deleting a proxied message removes its record immediately.
- Server settings are removed when a moderator clears them or removes the bot.
- For anything else, email The1Hanyou@gmail.com from an account that can prove it owns the Discord user in question.

## 6. Children

The bot is for users who meet Discord's minimum age requirement. We do not knowingly collect data from anyone below it.

## 7. Changes

Changes are published in the bot's repository with the date above updated.

## 8. Contact

The1Hanyou@gmail.com
