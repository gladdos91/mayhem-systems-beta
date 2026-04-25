import {
  Client, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  Message, GuildMember, TextChannel, Interaction,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';

// In-memory spam tracker: guildId -> userId -> timestamps[]
const spamTracker = new Map<string, Map<string, number[]>>();

type AutoModAction = 'delete' | 'warn' | 'mute' | 'kick' | 'ban';

export class AutoModModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('automod')
        .setDescription('Configure auto-moderation')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
          .setName('status')
          .setDescription('View current automod configuration'))
        .addSubcommand(sub => sub
          .setName('toggle')
          .setDescription('Enable or disable automod')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true)))
        .addSubcommand(sub => sub
          .setName('badwords')
          .setDescription('Configure bad word filter')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))
          .addStringOption(o => o.setName('action').setDescription('delete | warn | mute | kick | ban').setRequired(false))
          .addStringOption(o => o.setName('words').setDescription('Comma-separated list of words to add').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('spam')
          .setDescription('Configure spam filter')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))
          .addIntegerOption(o => o.setName('threshold').setDescription('Messages before action (default 5)').setRequired(false).setMinValue(2).setMaxValue(20))
          .addIntegerOption(o => o.setName('interval').setDescription('Time window in seconds (default 5)').setRequired(false).setMinValue(2).setMaxValue(60))
          .addStringOption(o => o.setName('action').setDescription('warn | mute | kick | ban').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('links')
          .setDescription('Configure link/invite filter')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))
          .addBooleanOption(o => o.setName('invites_only').setDescription('Only block Discord invites').setRequired(false))
          .addStringOption(o => o.setName('whitelist').setDescription('Comma-separated whitelisted domains').setRequired(false))
          .addStringOption(o => o.setName('action').setDescription('delete | warn | mute').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('caps')
          .setDescription('Configure excessive caps filter')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))
          .addIntegerOption(o => o.setName('threshold').setDescription('% caps to trigger (default 70)').setRequired(false).setMinValue(50).setMaxValue(100))
          .addIntegerOption(o => o.setName('min_length').setDescription('Min message length (default 10)').setRequired(false))
          .addStringOption(o => o.setName('action').setDescription('delete | warn | mute').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('mentions')
          .setDescription('Configure mention spam filter')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))
          .addIntegerOption(o => o.setName('threshold').setDescription('Max mentions per message (default 5)').setRequired(false).setMinValue(2).setMaxValue(20))
          .addStringOption(o => o.setName('action').setDescription('delete | warn | mute | kick | ban').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('exempt')
          .setDescription('Add exempt roles/channels')
          .addRoleOption(o => o.setName('role').setDescription('Role to exempt from automod').setRequired(false))
          .addChannelOption(o => o.setName('channel').setDescription('Channel to exempt from automod').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('logchannel')
          .setDescription('Set the channel for automod logs')
          .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(true)))
        .addSubcommand(sub => sub
          .setName('warnings')
          .setDescription('View warnings for a user')
          .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)))
        .addSubcommand(sub => sub
          .setName('clearwarns')
          .setDescription('Clear warnings for a user')
          .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true))) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        this.ensureConfig(db, interaction.guildId);
        switch (sub) {
          case 'status':      return this.cmdStatus(interaction, db);
          case 'toggle':      return this.cmdToggle(interaction, db);
          case 'badwords':    return this.cmdBadWords(interaction, db);
          case 'spam':        return this.cmdSpam(interaction, db);
          case 'links':       return this.cmdLinks(interaction, db);
          case 'caps':        return this.cmdCaps(interaction, db);
          case 'mentions':    return this.cmdMentions(interaction, db);
          case 'exempt':      return this.cmdExempt(interaction, db);
          case 'logchannel':  return this.cmdLogChannel(interaction, db);
          case 'warnings':    return this.cmdWarnings(interaction, db);
          case 'clearwarns':  return this.cmdClearWarns(interaction, db);
        }
      },
    },
  ];

  // ─── Message Handler ──────────────────────────────────────────────
  async onMessageCreate(message: Message) {
    if (!message.guild || message.author.bot) return;
    const db = this.db;

    const cfg = this.getConfig(db, message.guild.id);
    if (!cfg || !cfg.enabled) return;

    // Check exemptions
    if (this.isExempt(cfg, message.member, message.channelId)) return;

    const checks: (() => Promise<boolean>)[] = [
      () => this.checkBadWords(message, cfg),
      () => this.checkSpam(message, cfg),
      () => this.checkLinks(message, cfg),
      () => this.checkCaps(message, cfg),
      () => this.checkMentions(message, cfg),
    ];

    for (const check of checks) {
      if (await check()) break; // Stop after first hit
    }
  }

  // ─── Checks ───────────────────────────────────────────────────────
  private async checkBadWords(message: Message, cfg: any): Promise<boolean> {
    if (!cfg.bad_words_enabled) return false;

    const words: string[] = JSON.parse(cfg.bad_words_list ?? '[]');
    const content = message.content.toLowerCase();
    const matched = words.find(w => content.includes(w.toLowerCase()));
    if (!matched) return false;

    await this.takeAction(message, cfg.bad_words_action, `Bad word detected: "${matched}"`, cfg);
    return true;
  }

  private async checkSpam(message: Message, cfg: any): Promise<boolean> {
    if (!cfg.spam_enabled) return false;

    const guildId = message.guild!.id;
    const userId  = message.author.id;
    const now     = Date.now();
    const window  = (cfg.spam_interval ?? 5) * 1000;

    if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
    const guildTracker = spamTracker.get(guildId)!;

    const timestamps = (guildTracker.get(userId) ?? []).filter(t => now - t < window);
    timestamps.push(now);
    guildTracker.set(userId, timestamps);

    if (timestamps.length >= (cfg.spam_threshold ?? 5)) {
      guildTracker.set(userId, []);
      await this.takeAction(message, cfg.spam_action, 'Spam detected', cfg);
      return true;
    }
    return false;
  }

  private async checkLinks(message: Message, cfg: any): Promise<boolean> {
    if (!cfg.links_enabled) return false;

    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const inviteRegex = /(discord\.gg\/[^\s]+|discord\.com\/invite\/[^\s]+)/gi;
    const whitelist: string[] = JSON.parse(cfg.links_whitelist ?? '[]');

    let hasViolation = false;

    if (cfg.invites_enabled && inviteRegex.test(message.content)) {
      hasViolation = true;
    } else if (cfg.links_enabled && !cfg.invites_only) {
      const urls = message.content.match(urlRegex) ?? [];
      hasViolation = urls.some(url => !whitelist.some(w => url.includes(w)));
    }

    if (!hasViolation) return false;
    await this.takeAction(message, cfg.links_action, 'Unauthorized link/invite', cfg);
    return true;
  }

  private async checkCaps(message: Message, cfg: any): Promise<boolean> {
    if (!cfg.caps_enabled) return false;
    if (message.content.length < (cfg.caps_min_length ?? 10)) return false;

    const upper = (message.content.match(/[A-Z]/g) ?? []).length;
    const alpha = (message.content.match(/[A-Za-z]/g) ?? []).length;
    if (alpha === 0) return false;

    const pct = (upper / alpha) * 100;
    if (pct < (cfg.caps_threshold ?? 70)) return false;

    await this.takeAction(message, cfg.caps_action, `Excessive caps (${Math.round(pct)}%)`, cfg);
    return true;
  }

  private async checkMentions(message: Message, cfg: any): Promise<boolean> {
    if (!cfg.mentions_enabled) return false;

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    if (mentionCount < (cfg.mentions_threshold ?? 5)) return false;

    await this.takeAction(message, cfg.mentions_action, `Mention spam (${mentionCount} mentions)`, cfg);
    return true;
  }

  // ─── Action Executor ──────────────────────────────────────────────
  private async takeAction(message: Message, action: AutoModAction, reason: string, cfg: any) {
    const member = message.member as GuildMember;
    if (!member) return;

    // Always delete on violations (unless action is only 'warn')
    if (action !== 'warn') {
      await message.delete().catch(() => {});
    }

    // Add warning to DB
    this.db.prepare(`
      INSERT INTO automod_warnings (guild_id, user_id, moderator, reason)
      VALUES (?, ?, 'AutoMod', ?)
    `).run(message.guild!.id, message.author.id, reason);

    switch (action) {
      case 'delete':
        await message.delete().catch(() => {});
        break;
      case 'warn':
        await message.channel.send({
          embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`⚠️ ${message.author} — ${reason}`)],
        }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
        break;
      case 'mute':
        await member.timeout((cfg.spam_mute_duration ?? 5) * 60 * 1000, reason).catch(() => {});
        break;
      case 'kick':
        await member.kick(reason).catch(() => {});
        break;
      case 'ban':
        await message.guild!.members.ban(member.id, { reason }).catch(() => {});
        break;
    }

    // Log the action
    if (cfg.log_channel) {
      const logCh = message.guild!.channels.cache.get(cfg.log_channel) as TextChannel | undefined;
      if (logCh) {
        await logCh.send({
          embeds: [new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🛡️ AutoMod Action')
            .addFields(
              { name: 'User',    value: `${message.author.tag} (${message.author.id})`, inline: true },
              { name: 'Action',  value: action.toUpperCase(),                            inline: true },
              { name: 'Reason',  value: reason,                                          inline: false },
              { name: 'Channel', value: `<#${message.channelId}>`,                       inline: true },
            )
            .setTimestamp()],
        }).catch(() => {});
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  private ensureConfig(db: DatabaseSync, guildId: string) {
    db.prepare('INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)').run(guildId);
  }

  private getConfig(db: DatabaseSync, guildId: string) {
    return db.prepare('SELECT * FROM automod_config WHERE guild_id = ?').get(guildId) as any;
  }

  private isExempt(cfg: any, member: GuildMember | null, channelId: string): boolean {
    if (!member) return false;
    const exemptRoles:    string[] = JSON.parse(cfg.exempt_roles    ?? '[]');
    const exemptChannels: string[] = JSON.parse(cfg.exempt_channels ?? '[]');
    if (exemptChannels.includes(channelId)) return true;
    return member.roles.cache.some(r => exemptRoles.includes(r.id));
  }

  // ─── Commands ─────────────────────────────────────────────────────
  private async cmdStatus(interaction: any, db: DatabaseSync) {
    const cfg = this.getConfig(db, interaction.guildId);
    const on = (v: any) => v ? '✅ On' : '❌ Off';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛡️ AutoMod Configuration')
        .addFields(
          { name: 'Overall',     value: on(cfg.enabled),            inline: true },
          { name: 'Bad Words',   value: on(cfg.bad_words_enabled),  inline: true },
          { name: 'Spam',        value: on(cfg.spam_enabled),       inline: true },
          { name: 'Links',       value: on(cfg.links_enabled),      inline: true },
          { name: 'Invites',     value: on(cfg.invites_enabled),    inline: true },
          { name: 'Caps',        value: on(cfg.caps_enabled),       inline: true },
          { name: 'Mentions',    value: on(cfg.mentions_enabled),   inline: true },
          { name: 'Log Channel', value: cfg.log_channel ? `<#${cfg.log_channel}>` : 'Not set', inline: true },
        )],
      ephemeral: true,
    });
  }

  private async cmdToggle(interaction: any, db: DatabaseSync) {
    const enabled = interaction.options.getBoolean('enabled', true);
    db.prepare('UPDATE automod_config SET enabled = ? WHERE guild_id = ?').run(enabled ? 1 : 0, interaction.guildId);
    await interaction.reply({ content: `✅ AutoMod is now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdBadWords(interaction: any, db: DatabaseSync) {
    const enabled = interaction.options.getBoolean('enabled', true);
    const action  = interaction.options.getString('action') ?? null;
    const words   = interaction.options.getString('words') ?? null;

    const existing = this.getConfig(db, interaction.guildId);
    let wordList: string[] = JSON.parse(existing.bad_words_list ?? '[]');

    if (words) {
      const newWords = words.split(',').map((w: string) => w.trim().toLowerCase()).filter(Boolean);
      wordList = [...new Set([...wordList, ...newWords])];
    }

    db.prepare(`
      UPDATE automod_config SET
        bad_words_enabled = ?,
        bad_words_action  = COALESCE(?, bad_words_action),
        bad_words_list    = ?
      WHERE guild_id = ?
    `).run(enabled ? 1 : 0, action, JSON.stringify(wordList), interaction.guildId);

    await interaction.reply({
      content: `✅ Bad word filter **${enabled ? 'enabled' : 'disabled'}**. Words tracked: ${wordList.length}`,
      ephemeral: true,
    });
  }

  private async cmdSpam(interaction: any, db: DatabaseSync) {
    const enabled   = interaction.options.getBoolean('enabled', true);
    const threshold = interaction.options.getInteger('threshold');
    const interval  = interaction.options.getInteger('interval');
    const action    = interaction.options.getString('action');

    db.prepare(`
      UPDATE automod_config SET
        spam_enabled    = ?,
        spam_threshold  = COALESCE(?, spam_threshold),
        spam_interval   = COALESCE(?, spam_interval),
        spam_action     = COALESCE(?, spam_action)
      WHERE guild_id = ?
    `).run(enabled ? 1 : 0, threshold, interval, action, interaction.guildId);

    await interaction.reply({ content: `✅ Spam filter **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdLinks(interaction: any, db: DatabaseSync) {
    const enabled     = interaction.options.getBoolean('enabled', true);
    const invOnly     = interaction.options.getBoolean('invites_only');
    const whitelist   = interaction.options.getString('whitelist');
    const action      = interaction.options.getString('action');

    const existing    = this.getConfig(db, interaction.guildId);
    let wl: string[]  = JSON.parse(existing.links_whitelist ?? '[]');
    if (whitelist) wl = [...new Set([...wl, ...whitelist.split(',').map((s: string) => s.trim())])];

    db.prepare(`
      UPDATE automod_config SET
        links_enabled   = ?,
        invites_enabled = COALESCE(?, invites_enabled),
        links_action    = COALESCE(?, links_action),
        links_whitelist = ?
      WHERE guild_id = ?
    `).run(enabled ? 1 : 0, invOnly !== null ? (invOnly ? 1 : 0) : null, action, JSON.stringify(wl), interaction.guildId);

    await interaction.reply({ content: `✅ Link filter **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdCaps(interaction: any, db: DatabaseSync) {
    const enabled   = interaction.options.getBoolean('enabled', true);
    const threshold = interaction.options.getInteger('threshold');
    const minLen    = interaction.options.getInteger('min_length');
    const action    = interaction.options.getString('action');

    db.prepare(`
      UPDATE automod_config SET
        caps_enabled    = ?,
        caps_threshold  = COALESCE(?, caps_threshold),
        caps_min_length = COALESCE(?, caps_min_length),
        caps_action     = COALESCE(?, caps_action)
      WHERE guild_id = ?
    `).run(enabled ? 1 : 0, threshold, minLen, action, interaction.guildId);

    await interaction.reply({ content: `✅ Caps filter **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdMentions(interaction: any, db: DatabaseSync) {
    const enabled   = interaction.options.getBoolean('enabled', true);
    const threshold = interaction.options.getInteger('threshold');
    const action    = interaction.options.getString('action');

    db.prepare(`
      UPDATE automod_config SET
        mentions_enabled   = ?,
        mentions_threshold = COALESCE(?, mentions_threshold),
        mentions_action    = COALESCE(?, mentions_action)
      WHERE guild_id = ?
    `).run(enabled ? 1 : 0, threshold, action, interaction.guildId);

    await interaction.reply({ content: `✅ Mention spam filter **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdExempt(interaction: any, db: DatabaseSync) {
    const role    = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');

    const existing = this.getConfig(db, interaction.guildId);
    let roles: string[]    = JSON.parse(existing.exempt_roles    ?? '[]');
    let channels: string[] = JSON.parse(existing.exempt_channels ?? '[]');

    if (role    && !roles.includes(role.id))       roles.push(role.id);
    if (channel && !channels.includes(channel.id)) channels.push(channel.id);

    db.prepare('UPDATE automod_config SET exempt_roles = ?, exempt_channels = ? WHERE guild_id = ?')
      .run(JSON.stringify(roles), JSON.stringify(channels), interaction.guildId);

    await interaction.reply({
      content: `✅ Exemptions updated. Roles: ${roles.length} | Channels: ${channels.length}`,
      ephemeral: true,
    });
  }

  private async cmdLogChannel(interaction: any, db: DatabaseSync) {
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE automod_config SET log_channel = ? WHERE guild_id = ?').run(channel.id, interaction.guildId);
    await interaction.reply({ content: `✅ AutoMod logs will be sent to ${channel}.`, ephemeral: true });
  }

  private async cmdWarnings(interaction: any, db: DatabaseSync) {
    const user  = interaction.options.getUser('user', true);
    const warns = db.prepare(`
      SELECT reason, created_at FROM automod_warnings
      WHERE guild_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT 10
    `).all(interaction.guildId, user.id) as any[];

    if (warns.length === 0) {
      return interaction.reply({ content: `✅ ${user.tag} has no warnings.`, ephemeral: true });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle(`⚠️ Warnings for ${user.tag}`)
        .setDescription(warns.map((w, i) =>
          `**${i + 1}.** ${w.reason} — <t:${w.created_at}:R>`).join('\n'))],
      ephemeral: true,
    });
  }

  private async cmdClearWarns(interaction: any, db: DatabaseSync) {
    const user = interaction.options.getUser('user', true);
    const { changes } = db.prepare(
      'DELETE FROM automod_warnings WHERE guild_id = ? AND user_id = ?'
    ).run(interaction.guildId, user.id) as any;

    await interaction.reply({ content: `✅ Cleared ${changes} warnings for ${user.tag}.`, ephemeral: true });
  }
}
