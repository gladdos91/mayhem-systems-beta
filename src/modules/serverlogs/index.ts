import {
  Client, SlashCommandBuilder, EmbedBuilder,
  PermissionFlagsBits, ChannelType, TextChannel,
  GuildMember, GuildBan, Message, PartialMessage,
  VoiceState, Role, GuildChannel, AuditLogEvent,
  Collection,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';

type LogEvent =
  | 'member_join' | 'member_leave' | 'member_ban'
  | 'message_delete' | 'message_edit'
  | 'role_change' | 'voice_channel' | 'channel_change';

export class ServerLogsModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('logs')
        .setDescription('Configure server logging')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s
          .setName('setup')
          .setDescription('Set the default log channel')
          .addChannelOption(o => o.setName('channel').setDescription('Default log channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s
          .setName('channel')
          .setDescription('Set a dedicated channel for a specific event type')
          .addStringOption(o => o.setName('event').setDescription('Event type').setRequired(true).addChoices(
            { name: 'Member Join',      value: 'member_join' },
            { name: 'Member Leave',     value: 'member_leave' },
            { name: 'Member Ban/Unban', value: 'member_ban' },
            { name: 'Message Delete',   value: 'message_delete' },
            { name: 'Message Edit',     value: 'message_edit' },
            { name: 'Role Changes',     value: 'role_change' },
            { name: 'Voice Activity',   value: 'voice_channel' },
            { name: 'Channel Changes',  value: 'channel_change' },
          ))
          .addChannelOption(o => o.setName('channel').setDescription('Channel for this event (leave empty to use default)').setRequired(false).addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s
          .setName('toggle')
          .setDescription('Enable or disable a specific log event')
          .addStringOption(o => o.setName('event').setDescription('Event to toggle').setRequired(true).addChoices(
            { name: 'Member Join',      value: 'member_join' },
            { name: 'Member Leave',     value: 'member_leave' },
            { name: 'Member Ban/Unban', value: 'member_ban' },
            { name: 'Message Delete',   value: 'message_delete' },
            { name: 'Message Edit',     value: 'message_edit' },
            { name: 'Role Changes',     value: 'role_change' },
            { name: 'Voice Activity',   value: 'voice_channel' },
            { name: 'Channel Changes',  value: 'channel_change' },
          ))
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true)))
        .addSubcommand(s => s
          .setName('status')
          .setDescription('View current log configuration')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        this.ensureConfig(db, interaction.guildId);
        switch (sub) {
          case 'setup':   return this.cmdSetup(interaction, db);
          case 'channel': return this.cmdChannel(interaction, db);
          case 'toggle':  return this.cmdToggle(interaction, db);
          case 'status':  return this.cmdStatus(interaction, db);
        }
      },
    },
  ];

  // ─── Helpers ──────────────────────────────────────────────────────
  private ensureConfig(db: DatabaseSync, guildId: string) {
    db.prepare('INSERT OR IGNORE INTO server_log_config (guild_id) VALUES (?)').run(guildId);
  }

  private getCfg(guildId: string) {
    return this.db.prepare('SELECT * FROM server_log_config WHERE guild_id = ?').get(guildId) as any;
  }

  /** Get the right channel for an event — falls back to default */
  private getLogChannel(cfg: any, event: LogEvent): TextChannel | null {
    const colMap: Record<LogEvent, string> = {
      member_join:     'member_join_channel',
      member_leave:    'member_leave_channel',
      member_ban:      'member_ban_channel',
      message_delete:  'message_delete_channel',
      message_edit:    'message_edit_channel',
      role_change:     'role_change_channel',
      voice_channel:   'voice_channel_channel',
      channel_change:  'channel_change_channel',
    };
    const channelId = cfg[colMap[event]] ?? cfg.default_channel;
    if (!channelId) return null;

    const guild = this.client.guilds.cache.find(g => !!g.channels.cache.get(channelId));
    return (guild?.channels.cache.get(channelId) as TextChannel) ?? null;
  }

  private isEnabled(cfg: any, event: LogEvent): boolean {
    if (!cfg?.enabled) return false;
    const colMap: Record<LogEvent, string> = {
      member_join:    'log_member_join',
      member_leave:   'log_member_leave',
      member_ban:     'log_member_ban',
      message_delete: 'log_message_delete',
      message_edit:   'log_message_edit',
      role_change:    'log_role_change',
      voice_channel:  'log_voice_channel',
      channel_change: 'log_channel_change',
    };
    return !!cfg[colMap[event]];
  }

  private async send(guildId: string, event: LogEvent, embed: EmbedBuilder) {
    const cfg = this.getCfg(guildId);
    if (!cfg || !this.isEnabled(cfg, event)) return;
    const ch = this.getLogChannel(cfg, event);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }

  // ─── Event Handlers ───────────────────────────────────────────────
  async onMemberJoin(member: GuildMember) {
    await this.send(member.guild.id, 'member_join', new EmbedBuilder()
      .setColor(0x57F287)
      .setAuthor({ name: `${member.user.tag} joined`, iconURL: member.user.displayAvatarURL() })
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'User',    value: `${member} (${member.id})`, inline: true },
        { name: 'Account', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Members', value: `${member.guild.memberCount}`, inline: true },
      )
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp());
  }

  async onMemberLeave(member: GuildMember) {
    const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None';
    await this.send(member.guild.id, 'member_leave', new EmbedBuilder()
      .setColor(0xED4245)
      .setAuthor({ name: `${member.user.tag} left`, iconURL: member.user.displayAvatarURL() })
      .addFields(
        { name: 'User',   value: `${member.user.tag} (${member.id})`, inline: true },
        { name: 'Joined', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp! / 1000)}:R>` : 'Unknown', inline: true },
        { name: 'Roles',  value: roles.length > 1024 ? roles.slice(0, 1020) + '...' : roles, inline: false },
      )
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp());
  }

  async onMemberBan(ban: GuildBan) {
    // Fetch audit log for ban reason
    let reason = ban.reason ?? 'No reason provided';
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBan, limit: 1 });
      const entry = logs.entries.first();
      if (entry?.target?.id === ban.user.id) reason = entry.reason ?? reason;
    } catch {}

    await this.send(ban.guild.id, 'member_ban', new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🔨 Member Banned')
      .setThumbnail(ban.user.displayAvatarURL())
      .addFields(
        { name: 'User',   value: `${ban.user.tag} (${ban.user.id})`, inline: true },
        { name: 'Reason', value: reason, inline: false },
      )
      .setFooter({ text: `User ID: ${ban.user.id}` })
      .setTimestamp());
  }

  async onMemberUnban(ban: GuildBan) {
    await this.send(ban.guild.id, 'member_ban', new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🔓 Member Unbanned')
      .addFields({ name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true })
      .setFooter({ text: `User ID: ${ban.user.id}` })
      .setTimestamp());
  }

  async onMessageDelete(message: Message | PartialMessage) {
    if (!message.guild || message.author?.bot) return;
    await this.send(message.guild.id, 'message_delete', new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('🗑️ Message Deleted')
      .setAuthor({
        name: message.author?.tag ?? 'Unknown',
        iconURL: message.author?.displayAvatarURL(),
      })
      .addFields(
        { name: 'Channel', value: `<#${message.channelId}>`,  inline: true },
        { name: 'Author',  value: `<@${message.author?.id}>`, inline: true },
        { name: 'Content', value: message.content?.slice(0, 1024) || '*Empty / attachment only*', inline: false },
      )
      .setFooter({ text: `Message ID: ${message.id}` })
      .setTimestamp());
  }

  async onMessageEdit(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;
    await this.send(newMessage.guild.id, 'message_edit', new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('✏️ Message Edited')
      .setAuthor({
        name: newMessage.author?.tag ?? 'Unknown',
        iconURL: newMessage.author?.displayAvatarURL(),
      })
      .setURL(newMessage.url)
      .addFields(
        { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
        { name: 'Author',  value: `<@${newMessage.author?.id}>`, inline: true },
        { name: 'Before',  value: oldMessage.content?.slice(0, 512) || '*Unknown*', inline: false },
        { name: 'After',   value: newMessage.content?.slice(0, 512) || '*Empty*',  inline: false },
      )
      .setFooter({ text: `Message ID: ${newMessage.id}` })
      .setTimestamp());
  }

  async onRoleChange(oldMember: GuildMember, newMember: GuildMember) {
    const added   = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
    if (!added.size && !removed.size) return;

    const embed = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle('🎭 Member Roles Updated')
      .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL() })
      .setFooter({ text: `User ID: ${newMember.id}` })
      .setTimestamp();

    if (added.size)   embed.addFields({ name: '✅ Roles Added',   value: added.map(r => `<@&${r.id}>`).join(', '), inline: true });
    if (removed.size) embed.addFields({ name: '❌ Roles Removed', value: removed.map(r => `<@&${r.id}>`).join(', '), inline: true });

    await this.send(newMember.guild.id, 'role_change', embed);
  }

  async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const member = newState.member ?? oldState.member;
    if (!member) return;

    let action = '', color = 0x5865F2;
    if (!oldState.channel && newState.channel) {
      action = `Joined **${newState.channel.name}**`;
      color  = 0x57F287;
    } else if (oldState.channel && !newState.channel) {
      action = `Left **${oldState.channel.name}**`;
      color  = 0xED4245;
    } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      action = `Moved from **${oldState.channel.name}** → **${newState.channel.name}**`;
      color  = 0xFEE75C;
    } else return;

    await this.send(member.guild.id, 'voice_channel', new EmbedBuilder()
      .setColor(color)
      .setTitle('🎙️ Voice Activity')
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setDescription(`${member} ${action}`)
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp());
  }

  async onChannelCreate(channel: GuildChannel) {
    await this.send(channel.guild.id, 'channel_change', new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('📁 Channel Created')
      .addFields(
        { name: 'Name', value: `#${channel.name}`, inline: true },
        { name: 'Type', value: ChannelType[channel.type] ?? 'Unknown', inline: true },
      )
      .setFooter({ text: `Channel ID: ${channel.id}` })
      .setTimestamp());
  }

  async onChannelDelete(channel: GuildChannel) {
    await this.send(channel.guild.id, 'channel_change', new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🗑️ Channel Deleted')
      .addFields({ name: 'Name', value: `#${channel.name}`, inline: true })
      .setFooter({ text: `Channel ID: ${channel.id}` })
      .setTimestamp());
  }

  // ─── Commands ─────────────────────────────────────────────────────
  private async cmdSetup(interaction: any, db: DatabaseSync) {
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE server_log_config SET default_channel = ?, enabled = 1 WHERE guild_id = ?').run(channel.id, interaction.guildId);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Server logs will be sent to ${channel} by default.`)],
      ephemeral: true,
    });
  }

  private async cmdChannel(interaction: any, db: DatabaseSync) {
    const event   = interaction.options.getString('event', true) as LogEvent;
    const channel = interaction.options.getChannel('channel');
    const colMap: Record<LogEvent, string> = {
      member_join:    'member_join_channel',
      member_leave:   'member_leave_channel',
      member_ban:     'member_ban_channel',
      message_delete: 'message_delete_channel',
      message_edit:   'message_edit_channel',
      role_change:    'role_change_channel',
      voice_channel:  'voice_channel_channel',
      channel_change: 'channel_change_channel',
    };
    const col = colMap[event];
    db.prepare(`UPDATE server_log_config SET ${col} = ? WHERE guild_id = ?`).run(channel?.id ?? null, interaction.guildId);
    const msg = channel ? `✅ **${event}** logs → ${channel}` : `✅ **${event}** will use the default log channel.`;
    await interaction.reply({ content: msg, ephemeral: true });
  }

  private async cmdToggle(interaction: any, db: DatabaseSync) {
    const event   = interaction.options.getString('event', true) as LogEvent;
    const enabled = interaction.options.getBoolean('enabled', true);
    const colMap: Record<LogEvent, string> = {
      member_join:    'log_member_join',
      member_leave:   'log_member_leave',
      member_ban:     'log_member_ban',
      message_delete: 'log_message_delete',
      message_edit:   'log_message_edit',
      role_change:    'log_role_change',
      voice_channel:  'log_voice_channel',
      channel_change: 'log_channel_change',
    };
    db.prepare(`UPDATE server_log_config SET ${colMap[event]} = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, interaction.guildId);
    await interaction.reply({ content: `✅ **${event}** logging **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdStatus(interaction: any, db: DatabaseSync) {
    const cfg = db.prepare('SELECT * FROM server_log_config WHERE guild_id = ?').get(interaction.guildId) as any;
    const on  = (v: any) => v ? '✅' : '❌';
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Server Log Configuration')
        .addFields(
          { name: 'Default Channel',  value: cfg?.default_channel ? `<#${cfg.default_channel}>` : 'Not set', inline: false },
          { name: 'Member Join',      value: on(cfg?.log_member_join),    inline: true },
          { name: 'Member Leave',     value: on(cfg?.log_member_leave),   inline: true },
          { name: 'Member Ban',       value: on(cfg?.log_member_ban),     inline: true },
          { name: 'Msg Delete',       value: on(cfg?.log_message_delete), inline: true },
          { name: 'Msg Edit',         value: on(cfg?.log_message_edit),   inline: true },
          { name: 'Role Changes',     value: on(cfg?.log_role_change),    inline: true },
          { name: 'Voice Activity',   value: on(cfg?.log_voice_channel),  inline: true },
          { name: 'Channel Changes',  value: on(cfg?.log_channel_change), inline: true },
        )],
      ephemeral: true,
    });
  }
}
