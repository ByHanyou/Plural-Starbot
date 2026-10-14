# Plural Starbot Terms of Service

Last updated: 2026-10-14

Plural Starbot ("the bot") is operated by The Hanyou System ("we", "us"). Contact: The1Hanyou@gmail.com.

By adding the bot to a Discord server, linking a Plural Star cloud vault to it, or using any of its commands, you agree to these terms and to Discord's own Terms of Service and Community Guidelines. If you do not agree, do not use the bot.

## 1. What the bot does

- **Health reminders.** On a schedule configured by server moderators, the bot posts reminders to chosen roles in a chosen channel.
- **Proxying.** When a message you send matches one of your members' proxy tags, or when autoproxy is on, the bot deletes your message and re-posts its content through a webhook under that member's name and avatar.
- **Profiles.** `/system` and `/member` show system and member profiles.
- **Front.** `/front` shows and changes who is fronting.
- **Moderation log.** Server moderators can choose a channel where every proxied message is logged with its sender.

Profiles, proxy tags, avatars and the current front come from your Plural Star cloud vault. The bot does not have its own member registry.

## 2. Linking a vault

To use proxying, profiles or front commands you link your Plural Star cloud vault by sending the bot your cloud password in a direct message. The bot derives the vault key from that password, registers itself as a device on your vault, and from then on reads your vault and writes front changes you make through its commands. It never stores the password itself.

You must only link a vault that is yours. You may unlink at any time with `/unlink`; this removes the device from your vault and deletes the key the bot held for you.

## 3. Acceptable use

You agree not to use the bot to:

- proxy as someone other than your own system's members, or otherwise impersonate another person;
- harass, threaten, or abuse anyone, or evade a server's moderation;
- post content that breaks Discord's rules or the rules of the server you are in;
- interfere with the bot's operation or attempt to access vaults or data that are not yours.

Server moderators keep their normal authority over proxied messages, including deleting them and logging them.

## 4. Your content

Content you send through the bot stays yours. Proxied messages are posted on your behalf under a member's name; they are still your messages, and you are responsible for them. The bot does not claim any rights over your vault data or your messages.

## 5. Availability and changes

The bot is provided as is, without warranty of any kind. It may be unavailable, changed, or discontinued at any time without notice. We are not liable for lost messages, missed reminders, or any other loss arising from its use, to the extent permitted by law.

## 6. Termination

You can stop using the bot at any time by unlinking and removing it from your servers. We may unlink a vault, block a user, or remove the bot from a server when these terms are broken or when needed to keep the service running.

## 7. Changes to these terms

Changes are published in the bot's repository with the date above updated. Continued use after a change means you accept it.

## 8. Privacy

How the bot handles data is described in the Privacy Policy: https://github.com/ByHanyou/Plural-Starbot/blob/main/PRIVACY.md

## 9. Contact

Questions about these terms: The1Hanyou@gmail.com.
