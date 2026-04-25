import {
  Client, SlashCommandBuilder, EmbedBuilder,
  PermissionFlagsBits, ChannelType, TextChannel,
  MessageReaction, PartialMessageReaction,
  User, PartialUser, GuildMember, Interaction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';
import { nanoid } from '../../utils/nanoid';

export class ReactionRolesModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Manage reaction role panels')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand(s => s
          .setName('create')
          .setDescription('Create a new reaction role panel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel to post the panel in').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(false))
          .addStringOption(o => o.setName('description').setDescription('Panel description').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('Hex color').setRequired(false)))
        .addSubcommand(s => s
          .setName('add')
          .setDescription('Add a role to a panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addStringOption(o => o.setName('emoji').setDescription('Emoji to react with').setRequired(true))
          .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Label shown in embed').setRequired(false)))
        .addSubcommand(s => s
          .setName('remove')
          .setDescription('Remove a role from a panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addStringOption(o => o.setName('emoji').setDescription('Emoji to remove').setRequired(true)))
        .addSubcommand(s => s
          .setName('delete')
          .setDescription('Delete a reaction role panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true)))
        .addSubcommand(s => s
          .setName('list')
          .setDescription('List all reaction role panels')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'create': return this.cmdCreate(interaction, db);
          case 'add':    return this.cmdAdd(interaction, db);
          case 'remove': return this.cmdRemoveRole(interaction, db);
          case 'delete': return this.cmdDelete(interaction, db);
          case 'list':   return this.cmdList(interaction, db);
        }
      },
    },
  ];

  // ─── Reaction Add ─────────────────────────────────────────────────
  async onReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const db = this.db;
      const item = db.prepare(`
        SELECT rri.role_id, rri.panel_id FROM reaction_role_items rri
        JOIN reaction_role_panels rrp ON rrp.id = rri.panel_id
        WHERE rrp.message_id = ? AND rri.emoji = ?
      `).get(reaction.message.id, reaction.emoji.toString()) as any;

      if (!item) return;

      const guild  = reaction.message.guild!;
      const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id);
      if (!member) return;

      const role = guild.roles.cache.get(item.role_id);
      if (role) await member.roles.add(role, 'Reaction Role').catch(() => {});
    } catch (err) {
      console.error('[ReactionRoles] onReactionAdd error:', err);
    }
  }

  // ─── Reaction Remove ──────────────────────────────────────────────
  async onReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const db = this.db;
      const item = db.prepare(`
        SELECT rri.role_id FROM reaction_role_items rri
        JOIN reaction_role_panels rrp ON rrp.id = rri.panel_id
        WHERE rrp.message_id = ? AND rri.emoji = ?
      `).get(reaction.message.id, reaction.emoji.toString()) as any;

      if (!item) return;

      const guild  = reaction.message.guild!;
      const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id);
      if (!member) return;

      const role = guild.roles.cache.get(item.role_id);
      if (role) await member.roles.remove(role, 'Reaction Role removed').catch(() => {});
    } catch (err) {
      console.error('[ReactionRoles] onReactionRemove error:', err);
    }
  }

  // ─── Rebuild panel embed ──────────────────────────────────────────
  async rebuildPanel(panelId: string, guild: any) {
    const db = this.db;
    const panel = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ?').get(panelId) as any;
    if (!panel || !panel.message_id) return;

    const items = db.prepare('SELECT * FROM reaction_role_items WHERE panel_id = ?').all(panelId) as any[];
    const channel = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
    if (!channel) return;

    try {
      const msg = await channel.messages.fetch(panel.message_id);

      const rolesText = items.length
        ? items.map((i: any) => `${i.emoji} — <@&${i.role_id}>${i.label ? ` *${i.label}*` : ''}`).join('\n')
        : '*No roles added yet.*';

      const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(`${panel.description}\n\n${rolesText}`)
        .setColor(panel.color)
        .setFooter({ text: `Panel ID: ${panel.id}` })
        .setTimestamp();

      await msg.edit({ embeds: [embed] });

      // Re-add reactions
      await msg.reactions.removeAll().catch(() => {});
      for (const item of items) {
        await msg.react(item.emoji).catch(() => {});
      }
    } catch (err) {
      console.error('[ReactionRoles] rebuildPanel error:', err);
    }
  }

  // ─── Commands ─────────────────────────────────────────────────────
  private async cmdCreate(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const channel     = interaction.options.getChannel('channel') as TextChannel;
    const title       = interaction.options.getString('title')       ?? '🎭 Reaction Roles';
    const description = interaction.options.getString('description') ?? 'React below to assign yourself roles!';
    const color       = interaction.options.getString('color')       ?? '#5865F2';

    const panelId = nanoid(8);
    db.prepare(`
      INSERT INTO reaction_role_panels (id, guild_id, channel_id, title, description, color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(panelId, interaction.guildId, channel.id, title, description, color);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`${description}\n\n*Use \`/reactionrole add\` with Panel ID: \`${panelId}\` to add roles.*`)
      .setColor(color as any)
      .setFooter({ text: `Panel ID: ${panelId}` })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    db.prepare('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);

    await interaction.editReply({ content: `✅ Reaction role panel created in ${channel}!\nPanel ID: \`${panelId}\`` });
  }

  private async cmdAdd(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const panelId = interaction.options.getString('panel_id', true);
    const emoji   = interaction.options.getString('emoji', true);
    const role    = interaction.options.getRole('role', true);
    const label   = interaction.options.getString('label') ?? null;

    const panel = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?').get(panelId, interaction.guildId) as any;
    if (!panel) return interaction.editReply({ content: '❌ Panel not found.' });

    db.prepare('INSERT OR REPLACE INTO reaction_role_items (panel_id, guild_id, emoji, role_id, label) VALUES (?, ?, ?, ?, ?)')
      .run(panelId, interaction.guildId, emoji, role.id, label);

    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.editReply({ content: `✅ Added ${emoji} → <@&${role.id}> to the panel!` });
  }

  private async cmdRemoveRole(interaction: any, db: DatabaseSync) {
    const panelId = interaction.options.getString('panel_id', true);
    const emoji   = interaction.options.getString('emoji', true);

    db.prepare('DELETE FROM reaction_role_items WHERE panel_id = ? AND emoji = ?').run(panelId, emoji);
    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.reply({ content: `✅ Removed ${emoji} from the panel.`, ephemeral: true });
  }

  private async cmdDelete(interaction: any, db: DatabaseSync) {
    const panelId = interaction.options.getString('panel_id', true);
    const panel   = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?').get(panelId, interaction.guildId) as any;
    if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });

    const channel = interaction.guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
    if (channel && panel.message_id) {
      await channel.messages.delete(panel.message_id).catch(() => {});
    }

    db.prepare('DELETE FROM reaction_role_panels WHERE id = ?').run(panelId);
    await interaction.reply({ content: '✅ Reaction role panel deleted.', ephemeral: true });
  }

  private async cmdList(interaction: any, db: DatabaseSync) {
    const panels = db.prepare('SELECT * FROM reaction_role_panels WHERE guild_id = ?').all(interaction.guildId) as any[];
    if (!panels.length) return interaction.reply({ content: '📋 No reaction role panels.', ephemeral: true });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎭 Reaction Role Panels')
        .setDescription(panels.map((p: any) => `**${p.title}** — ID: \`${p.id}\` in <#${p.channel_id}>`).join('\n'))],
      ephemeral: true,
    });
  }
}
