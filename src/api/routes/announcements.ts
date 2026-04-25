import { Router } from 'express';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function announcementsRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // List announcements for a guild
  router.get('/:guildId', requireGuild, (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM announcements WHERE guild_id = ?
      ORDER BY sent_at DESC LIMIT 50
    `).all(req.params.guildId);
    res.json(rows);
  });

  // Send announcement from panel
  router.post('/:guildId', requireGuild, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, title, content, color, imageUrl, thumbnail, footer, mention } = req.body;

    if (!channelId || !title || !content) {
      return res.status(400).json({ error: 'channelId, title, and content are required' });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ error: 'Invalid channel' });
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(content)
      .setColor((color ?? '#5865F2') as any)
      .setTimestamp()
      .setFooter({
        text: footer ?? `Announced via Web Panel`,
        iconURL: client.user?.displayAvatarURL(),
      });

    if (imageUrl)  embed.setImage(imageUrl);
    if (thumbnail) embed.setThumbnail(thumbnail);

    try {
      const sent = await channel.send({
        content: mention || undefined,
        embeds: [embed],
      });

      const result = db.prepare(`
        INSERT INTO announcements
          (guild_id, channel_id, message_id, title, content, color, image_url, thumbnail, footer, author, mention)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(guildId, channelId, sent.id, title, content,
             color ?? '#5865F2', imageUrl ?? null, thumbnail ?? null,
             footer ?? null, req.session.userId!, mention ?? null);

      res.json({ success: true, id: result.lastInsertRowid, messageId: sent.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Edit announcement
  router.patch('/:guildId/:id', requireGuild, async (req, res) => {
    const { guildId, id } = req.params;
    const { title, content } = req.body;

    const row = db.prepare('SELECT * FROM announcements WHERE id = ? AND guild_id = ?').get(id, guildId) as any;
    if (!row) return res.status(404).json({ error: 'Announcement not found' });

    const newTitle   = title   ?? row.title;
    const newContent = content ?? row.content;

    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const channel = guild.channels.cache.get(row.channel_id) as TextChannel | undefined;
      if (channel && row.message_id) {
        try {
          const msg = await channel.messages.fetch(row.message_id);
          const updated = EmbedBuilder.from(msg.embeds[0])
            .setTitle(newTitle)
            .setDescription(newContent)
            .setTimestamp();
          await msg.edit({ embeds: [updated] });
        } catch {}
      }
    }

    db.prepare('UPDATE announcements SET title = ?, content = ? WHERE id = ?').run(newTitle, newContent, id);
    res.json({ success: true });
  });

  // Delete announcement record
  router.delete('/:guildId/:id', requireGuild, (req, res) => {
    const { guildId, id } = req.params;
    db.prepare('DELETE FROM announcements WHERE id = ? AND guild_id = ?').run(id, guildId);
    res.json({ success: true });
  });

  return router;
}
