import {
  Client, SlashCommandBuilder, EmbedBuilder,
  PermissionFlagsBits, ChannelType, TextChannel,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';
import { nanoid } from '../../utils/nanoid';

export class RulesModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('rules')
        .setDescription('Manage the server rules panel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s
          .setName('create')
          .setDescription('Create a new rules panel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel to post rules in').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('Hex color').setRequired(false))
          .addStringOption(o => o.setName('footer').setDescription('Footer text').setRequired(false)))
        .addSubcommand(s => s
          .setName('add')
          .setDescription('Add a rule to the panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addIntegerOption(o => o.setName('number').setDescription('Rule number').setRequired(true).setMinValue(1).setMaxValue(50))
          .addStringOption(o => o.setName('title').setDescription('Rule title e.g. "Be Respectful"').setRequired(true))
          .addStringOption(o => o.setName('body').setDescription('Rule details').setRequired(true)))
        .addSubcommand(s => s
          .setName('edit')
          .setDescription('Edit an existing rule')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addIntegerOption(o => o.setName('number').setDescription('Rule number to edit').setRequired(true))
          .addStringOption(o => o.setName('title').setDescription('New title').setRequired(false))
          .addStringOption(o => o.setName('body').setDescription('New body').setRequired(false)))
        .addSubcommand(s => s
          .setName('remove')
          .setDescription('Remove a rule from the panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addIntegerOption(o => o.setName('number').setDescription('Rule number to remove').setRequired(true)))
        .addSubcommand(s => s
          .setName('update')
          .setDescription('Update the panel settings')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addStringOption(o => o.setName('title').setDescription('New panel title').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('New color').setRequired(false))
          .addStringOption(o => o.setName('footer').setDescription('New footer').setRequired(false))
          .addStringOption(o => o.setName('description').setDescription('Intro text above rules').setRequired(false)))
        .addSubcommand(s => s
          .setName('list')
          .setDescription('List all rules panels')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'create': return this.cmdCreate(interaction, db);
          case 'add':    return this.cmdAddRule(interaction, db);
          case 'edit':   return this.cmdEditRule(interaction, db);
          case 'remove': return this.cmdRemoveRule(interaction, db);
          case 'update': return this.cmdUpdatePanel(interaction, db);
          case 'list':   return this.cmdList(interaction, db);
        }
      },
    },
  ];

  // ─── Rebuild Panel ────────────────────────────────────────────────
  async rebuildPanel(panelId: string, guild: any) {
    const db    = this.db;
    const panel = db.prepare('SELECT * FROM rules_panels WHERE id = ?').get(panelId) as any;
    if (!panel || !panel.message_id) return;

    const rules = db.prepare('SELECT * FROM rules_items WHERE panel_id = ? ORDER BY number ASC').all(panelId) as any[];
    const channel = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
    if (!channel) return;

    try {
      const msg = await channel.messages.fetch(panel.message_id);

      const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setColor(panel.color as any)
        .setFooter({ text: panel.footer })
        .setTimestamp();

      if (panel.description) embed.setDescription(panel.description);

      for (const rule of rules) {
        embed.addFields({
          name:  `${rule.number}. ${rule.title}`,
          value: rule.body,
          inline: false,
        });
      }

      await msg.edit({ embeds: [embed] });
    } catch (err) {
      console.error('[Rules] rebuildPanel error:', err);
    }
  }

  // ─── Commands ─────────────────────────────────────────────────────
  private async cmdCreate(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel') as TextChannel;
    const title   = interaction.options.getString('title')  ?? '📜 Server Rules';
    const color   = interaction.options.getString('color')  ?? '#5865F2';
    const footer  = interaction.options.getString('footer') ?? 'Breaking rules may result in a mute, kick, or ban.';

    const panelId = nanoid(8);
    db.prepare(`
      INSERT INTO rules_panels (id, guild_id, channel_id, title, color, footer)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(panelId, interaction.guildId, channel.id, title, color, footer);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`*No rules added yet. Use \`/rules add\` with Panel ID: \`${panelId}\`*`)
      .setColor(color as any)
      .setFooter({ text: footer })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    db.prepare('UPDATE rules_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
    await interaction.editReply({ content: `✅ Rules panel created in ${channel}!\nPanel ID: \`${panelId}\`` });
  }

  private async cmdAddRule(interaction: any, db: DatabaseSync) {
    const panelId = interaction.options.getString('panel_id', true);
    const number  = interaction.options.getInteger('number', true);
    const title   = interaction.options.getString('title', true);
    const body    = interaction.options.getString('body', true);

    const panel = db.prepare('SELECT id FROM rules_panels WHERE id = ? AND guild_id = ?').get(panelId, interaction.guildId);
    if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });

    db.prepare('INSERT OR REPLACE INTO rules_items (panel_id, guild_id, number, title, body) VALUES (?, ?, ?, ?, ?)')
      .run(panelId, interaction.guildId, number, title, body);

    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.reply({ content: `✅ Rule **${number}. ${title}** added!`, ephemeral: true });
  }

  private async cmdEditRule(interaction: any, db: DatabaseSync) {
    const panelId = interaction.options.getString('panel_id', true);
    const number  = interaction.options.getInteger('number', true);
    const title   = interaction.options.getString('title');
    const body    = interaction.options.getString('body');

    const existing = db.prepare('SELECT * FROM rules_items WHERE panel_id = ? AND number = ?').get(panelId, number) as any;
    if (!existing) return interaction.reply({ content: '❌ Rule not found.', ephemeral: true });

    db.prepare('UPDATE rules_items SET title = COALESCE(?, title), body = COALESCE(?, body) WHERE panel_id = ? AND number = ?')
      .run(title, body, panelId, number);

    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.reply({ content: `✅ Rule #${number} updated!`, ephemeral: true });
  }

  private async cmdRemoveRule(interaction: any, db: DatabaseSync) {
    const panelId = interaction.options.getString('panel_id', true);
    const number  = interaction.options.getInteger('number', true);

    db.prepare('DELETE FROM rules_items WHERE panel_id = ? AND number = ?').run(panelId, number);
    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.reply({ content: `✅ Rule #${number} removed.`, ephemeral: true });
  }

  private async cmdUpdatePanel(interaction: any, db: DatabaseSync) {
    const panelId     = interaction.options.getString('panel_id', true);
    const title       = interaction.options.getString('title');
    const color       = interaction.options.getString('color');
    const footer      = interaction.options.getString('footer');
    const description = interaction.options.getString('description');

    const panel = db.prepare('SELECT id FROM rules_panels WHERE id = ? AND guild_id = ?').get(panelId, interaction.guildId);
    if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });

    db.prepare(`
      UPDATE rules_panels SET
        title       = COALESCE(?, title),
        color       = COALESCE(?, color),
        footer      = COALESCE(?, footer),
        description = COALESCE(?, description)
      WHERE id = ?
    `).run(title, color, footer, description, panelId);

    await this.rebuildPanel(panelId, interaction.guild);
    await interaction.reply({ content: '✅ Rules panel updated!', ephemeral: true });
  }

  private async cmdList(interaction: any, db: DatabaseSync) {
    const panels = db.prepare('SELECT * FROM rules_panels WHERE guild_id = ?').all(interaction.guildId) as any[];
    if (!panels.length) return interaction.reply({ content: '📋 No rules panels.', ephemeral: true });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📜 Rules Panels')
        .setDescription(panels.map((p: any) => `**${p.title}** — ID: \`${p.id}\` in <#${p.channel_id}>`).join('\n'))],
      ephemeral: true,
    });
  }
}
