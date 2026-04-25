import {
  Client, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ChannelType, TextChannel,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';

export class AnnouncementsModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Send an announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(sub => sub
          .setName('send')
          .setDescription('Send a rich announcement embed')
          .addChannelOption(o => o
            .setName('channel').setDescription('Channel to announce in').setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
          .addStringOption(o => o
            .setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(256))
          .addStringOption(o => o
            .setName('content').setDescription('Announcement body').setRequired(true).setMaxLength(4000))
          .addStringOption(o => o
            .setName('color').setDescription('Embed color hex e.g. #FF5733').setRequired(false))
          .addStringOption(o => o
            .setName('image').setDescription('Image URL to attach').setRequired(false))
          .addStringOption(o => o
            .setName('thumbnail').setDescription('Thumbnail URL (small top-right image)').setRequired(false))
          .addStringOption(o => o
            .setName('footer').setDescription('Footer text').setRequired(false))
          .addRoleOption(o => o
            .setName('mention').setDescription('Role to mention (or @everyone)').setRequired(false))
          .addBooleanOption(o => o
            .setName('everyone').setDescription('Ping @everyone').setRequired(false)))
        .addSubcommand(sub => sub
          .setName('history')
          .setDescription('View recent announcements')
          .addIntegerOption(o => o.setName('limit').setDescription('Number to show (1–10)').setRequired(false).setMinValue(1).setMaxValue(10)))
        .addSubcommand(sub => sub
          .setName('edit')
          .setDescription('Edit a previous announcement')
          .addIntegerOption(o => o.setName('id').setDescription('Announcement ID from history').setRequired(true))
          .addStringOption(o => o.setName('title').setDescription('New title').setRequired(false))
          .addStringOption(o => o.setName('content').setDescription('New content').setRequired(false))) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'send':    return this.cmdSend(interaction, db);
          case 'history': return this.cmdHistory(interaction, db);
          case 'edit':    return this.cmdEdit(interaction, db);
        }
      },
    },
  ];

  // ─── Send ─────────────────────────────────────────────────────────
  private async cmdSend(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });

    const channel   = interaction.options.getChannel('channel') as TextChannel;
    const title     = interaction.options.getString('title', true);
    const content   = interaction.options.getString('content', true);
    const color     = (interaction.options.getString('color') ?? '#5865F2') as `#${string}`;
    const imageUrl  = interaction.options.getString('image')     ?? null;
    const thumbnail = interaction.options.getString('thumbnail') ?? null;
    const footer    = interaction.options.getString('footer')    ?? null;
    const role      = interaction.options.getRole('mention');
    const everyone  = interaction.options.getBoolean('everyone') ?? false;

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(content)
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: footer ?? `Announced by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });

    if (imageUrl)  embed.setImage(imageUrl);
    if (thumbnail) embed.setThumbnail(thumbnail);

    // Mention string
    let mention = '';
    if (everyone) mention = '@everyone';
    else if (role) mention = `<@&${role.id}>`;

    const sent = await channel.send({
      content: mention || undefined,
      embeds: [embed],
    });

    // Store in DB
    const result = db.prepare(`
      INSERT INTO announcements (guild_id, channel_id, message_id, title, content, color, image_url, thumbnail, footer, author, mention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      interaction.guildId, channel.id, sent.id,
      title, content, color, imageUrl, thumbnail, footer,
      interaction.user.id, mention || null,
    );

    await interaction.editReply({
      content: `✅ Announcement sent to ${channel}! (ID: \`${result.lastInsertRowid}\`)`,
    });
  }

  // ─── History ──────────────────────────────────────────────────────
  private async cmdHistory(interaction: any, db: DatabaseSync) {
    const limit = interaction.options.getInteger('limit') ?? 5;

    const rows = db.prepare(`
      SELECT id, title, channel_id, sent_at, author
      FROM announcements
      WHERE guild_id = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(interaction.guildId, limit) as any[];

    if (!rows.length) {
      return interaction.reply({ content: '📭 No announcements found.', ephemeral: true });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📢 Recent Announcements')
        .setDescription(rows.map(r =>
          `**#${r.id}** — **${r.title}** in <#${r.channel_id}> by <@${r.author}> <t:${r.sent_at}:R>`
        ).join('\n'))],
      ephemeral: true,
    });
  }

  // ─── Edit ─────────────────────────────────────────────────────────
  private async cmdEdit(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });

    const id      = interaction.options.getInteger('id', true);
    const title   = interaction.options.getString('title');
    const content = interaction.options.getString('content');

    const row = db.prepare('SELECT * FROM announcements WHERE id = ? AND guild_id = ?').get(id, interaction.guildId) as any;
    if (!row) return interaction.editReply({ content: '❌ Announcement not found.' });

    const newTitle   = title   ?? row.title;
    const newContent = content ?? row.content;

    // Update embed in Discord
    const channel = interaction.guild.channels.cache.get(row.channel_id) as TextChannel | undefined;
    if (channel && row.message_id) {
      try {
        const msg = await channel.messages.fetch(row.message_id);
        const embed = EmbedBuilder.from(msg.embeds[0])
          .setTitle(newTitle)
          .setDescription(newContent)
          .setTimestamp();
        await msg.edit({ embeds: [embed] });
      } catch {
        await interaction.editReply({ content: '⚠️ Could not edit the original message (may have been deleted). DB updated.' });
      }
    }

    db.prepare('UPDATE announcements SET title = ?, content = ? WHERE id = ?').run(newTitle, newContent, id);
    await interaction.editReply({ content: `✅ Announcement #${id} updated.` });
  }
}
