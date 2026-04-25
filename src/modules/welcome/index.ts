import {
  Client, GuildMember, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, TextChannel,
  ChannelType,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';

/** Replace {user}, {server}, {count} placeholders */
function resolvePlaceholders(text: string, member: GuildMember): string {
  return text
    .replace(/{user}/gi,    `<@${member.id}>`)
    .replace(/{username}/gi, member.user.username)
    .replace(/{server}/gi,  member.guild.name)
    .replace(/{count}/gi,   String(member.guild.memberCount));
}

export class WelcomeModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure welcome messages and auto roles')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s
          .setName('setup')
          .setDescription('Set the welcome channel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel to post welcome messages in').setRequired(true).addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s
          .setName('message')
          .setDescription('Set the welcome embed message')
          .addStringOption(o => o.setName('title').setDescription('Embed title (use {user} {server} {count})').setRequired(false))
          .addStringOption(o => o.setName('description').setDescription('Embed body (use {user} {server} {count})').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #57F287').setRequired(false))
          .addStringOption(o => o.setName('image').setDescription('Banner image URL').setRequired(false))
          .addStringOption(o => o.setName('footer').setDescription('Footer text').setRequired(false))
          .addStringOption(o => o.setName('thumbnail').setDescription('avatar | none').setRequired(false)))
        .addSubcommand(s => s
          .setName('dm')
          .setDescription('Configure DM welcome message')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable DM welcome').setRequired(true))
          .addStringOption(o => o.setName('message').setDescription('DM message text').setRequired(false)))
        .addSubcommand(s => s
          .setName('toggle')
          .setDescription('Enable or disable welcome messages')
          .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
        .addSubcommand(s => s
          .setName('test')
          .setDescription('Send a test welcome message for yourself'))
        .addSubcommand(s => s
          .setName('status')
          .setDescription('View current welcome configuration')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        this.ensureConfig(db, interaction.guildId);
        switch (sub) {
          case 'setup':   return this.cmdSetup(interaction, db);
          case 'message': return this.cmdMessage(interaction, db);
          case 'dm':      return this.cmdDm(interaction, db);
          case 'toggle':  return this.cmdToggle(interaction, db);
          case 'test':    return this.cmdTest(interaction, db);
          case 'status':  return this.cmdStatus(interaction, db);
        }
      },
    },

    // ── Auto Roles ────────────────────────────────────────────────
    {
      data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Manage roles automatically assigned when a member joins')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand(s => s
          .setName('add')
          .setDescription('Add a role to auto-assign on join')
          .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Optional label').setRequired(false)))
        .addSubcommand(s => s
          .setName('remove')
          .setDescription('Remove an auto-assigned role')
          .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true)))
        .addSubcommand(s => s
          .setName('list')
          .setDescription('List all auto-assigned roles')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'add':    return this.cmdAutoRoleAdd(interaction, db);
          case 'remove': return this.cmdAutoRoleRemove(interaction, db);
          case 'list':   return this.cmdAutoRoleList(interaction, db);
        }
      },
    },
  ];

  // ─── Member Join Handler ─────────────────────────────────────────
  async onGuildMemberAdd(member: GuildMember) {
    const db = this.db;
    const cfg = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(member.guild.id) as any;

    // ── Auto Roles ──────────────────────────────────────────────
    const autoRoles = db.prepare('SELECT role_id FROM auto_roles WHERE guild_id = ?').all(member.guild.id) as any[];
    for (const r of autoRoles) {
      const role = member.guild.roles.cache.get(r.role_id);
      if (role && role.position < member.guild.members.me!.roles.highest.position) {
        await member.roles.add(role, 'Auto Role on join').catch(() => {});
      }
    }

    if (!cfg || !cfg.enabled) return;

    // ── Welcome embed ───────────────────────────────────────────
    if (cfg.channel_id) {
      const channel = member.guild.channels.cache.get(cfg.channel_id) as TextChannel | undefined;
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle(resolvePlaceholders(cfg.title, member))
          .setDescription(resolvePlaceholders(cfg.description, member))
          .setColor((cfg.color ?? '#57F287') as any)
          .setTimestamp()
          .setFooter({ text: resolvePlaceholders(cfg.footer_text, member) });

        if (cfg.thumbnail_type === 'avatar') {
          embed.setThumbnail(member.user.displayAvatarURL({ size: 128 }));
        }
        if (cfg.image_url) embed.setImage(cfg.image_url);

        const ping = cfg.ping_user ? `<@${member.id}> ` : '';
        await channel.send({ content: ping || undefined, embeds: [embed] }).catch(() => {});
      }
    }

    // ── DM welcome ──────────────────────────────────────────────
    if (cfg.dm_enabled && cfg.dm_message) {
      await member.send(resolvePlaceholders(cfg.dm_message, member)).catch(() => {});
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  private ensureConfig(db: DatabaseSync, guildId: string) {
    db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(guildId);
  }

  // ─── Welcome Commands ─────────────────────────────────────────────
  private async cmdSetup(interaction: any, db: DatabaseSync) {
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE welcome_config SET channel_id = ? WHERE guild_id = ?').run(channel.id, interaction.guildId);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Welcome messages will be sent to ${channel}.`)],
      ephemeral: true,
    });
  }

  private async cmdMessage(interaction: any, db: DatabaseSync) {
    const title     = interaction.options.getString('title');
    const desc      = interaction.options.getString('description');
    const color     = interaction.options.getString('color');
    const image     = interaction.options.getString('image');
    const footer    = interaction.options.getString('footer');
    const thumbnail = interaction.options.getString('thumbnail');

    const updates: string[] = [];
    const vals: any[]       = [];
    if (title)     { updates.push('title = ?');          vals.push(title); }
    if (desc)      { updates.push('description = ?');    vals.push(desc); }
    if (color)     { updates.push('color = ?');          vals.push(color); }
    if (image)     { updates.push('image_url = ?');      vals.push(image); }
    if (footer)    { updates.push('footer_text = ?');    vals.push(footer); }
    if (thumbnail) { updates.push('thumbnail_type = ?'); vals.push(thumbnail); }

    if (updates.length) {
      vals.push(interaction.guildId);
      db.prepare(`UPDATE welcome_config SET ${updates.join(', ')} WHERE guild_id = ?`).run(...vals);
    }

    await interaction.reply({ content: '✅ Welcome message updated!', ephemeral: true });
  }

  private async cmdDm(interaction: any, db: DatabaseSync) {
    const enabled = interaction.options.getBoolean('enabled', true);
    const message = interaction.options.getString('message');
    db.prepare(`
      UPDATE welcome_config SET dm_enabled = ?, dm_message = COALESCE(?, dm_message) WHERE guild_id = ?
    `).run(enabled ? 1 : 0, message, interaction.guildId);
    await interaction.reply({ content: `✅ DM welcome ${enabled ? 'enabled' : 'disabled'}.`, ephemeral: true });
  }

  private async cmdToggle(interaction: any, db: DatabaseSync) {
    const enabled = interaction.options.getBoolean('enabled', true);
    db.prepare('UPDATE welcome_config SET enabled = ? WHERE guild_id = ?').run(enabled ? 1 : 0, interaction.guildId);
    await interaction.reply({ content: `✅ Welcome messages **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  private async cmdTest(interaction: any, db: DatabaseSync) {
    const member = interaction.member as GuildMember;
    await this.onGuildMemberAdd(member);
    await interaction.reply({ content: '✅ Test welcome sent!', ephemeral: true });
  }

  private async cmdStatus(interaction: any, db: DatabaseSync) {
    const cfg = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(interaction.guildId) as any;
    const roles = db.prepare('SELECT role_id FROM auto_roles WHERE guild_id = ?').all(interaction.guildId) as any[];
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('👋 Welcome Configuration')
        .addFields(
          { name: 'Status',     value: cfg?.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
          { name: 'Channel',    value: cfg?.channel_id ? `<#${cfg.channel_id}>` : 'Not set', inline: true },
          { name: 'DM Welcome', value: cfg?.dm_enabled ? '✅ On' : '❌ Off', inline: true },
          { name: 'Auto Roles', value: roles.length ? roles.map((r: any) => `<@&${r.role_id}>`).join(', ') : 'None', inline: false },
        )],
      ephemeral: true,
    });
  }

  // ─── Auto Role Commands ───────────────────────────────────────────
  private async cmdAutoRoleAdd(interaction: any, db: DatabaseSync) {
    const role  = interaction.options.getRole('role', true);
    const label = interaction.options.getString('label') ?? role.name;
    try {
      db.prepare('INSERT OR IGNORE INTO auto_roles (guild_id, role_id, label) VALUES (?, ?, ?)').run(interaction.guildId, role.id, label);
      await interaction.reply({ content: `✅ <@&${role.id}> will now be assigned to new members.`, ephemeral: true });
    } catch {
      await interaction.reply({ content: '❌ Failed to add auto role.', ephemeral: true });
    }
  }

  private async cmdAutoRoleRemove(interaction: any, db: DatabaseSync) {
    const role = interaction.options.getRole('role', true);
    const { changes } = db.prepare('DELETE FROM auto_roles WHERE guild_id = ? AND role_id = ?').run(interaction.guildId, role.id) as any;
    if (changes) {
      await interaction.reply({ content: `✅ <@&${role.id}> removed from auto roles.`, ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ That role is not in the auto roles list.', ephemeral: true });
    }
  }

  private async cmdAutoRoleList(interaction: any, db: DatabaseSync) {
    const roles = db.prepare('SELECT role_id, label FROM auto_roles WHERE guild_id = ?').all(interaction.guildId) as any[];
    if (!roles.length) {
      return interaction.reply({ content: '📋 No auto roles configured.', ephemeral: true });
    }
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎭 Auto Roles')
        .setDescription(roles.map((r: any, i: number) => `**${i + 1}.** <@&${r.role_id}>${r.label ? ` — ${r.label}` : ''}`).join('\n'))],
      ephemeral: true,
    });
  }
}
