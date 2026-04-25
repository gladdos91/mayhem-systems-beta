import { Router } from 'express';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function tempvoiceRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // Get config
  router.get('/:guildId/config', requireGuild, (req, res) => {
    const cfg = db.prepare('SELECT * FROM temp_voice_config WHERE guild_id = ?').get(req.params.guildId);
    res.json(cfg ?? null);
  });

  // Update / create config
  router.put('/:guildId/config', requireGuild, (req, res) => {
    const { hubChannelId, categoryId, defaultLimit } = req.body;
    if (!hubChannelId || !categoryId) {
      return res.status(400).json({ error: 'hubChannelId and categoryId are required' });
    }

    db.prepare(`
      INSERT INTO temp_voice_config (guild_id, hub_channel_id, category_id, default_limit)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        hub_channel_id = excluded.hub_channel_id,
        category_id    = excluded.category_id,
        default_limit  = excluded.default_limit
    `).run(req.params.guildId, hubChannelId, categoryId, defaultLimit ?? 0);

    res.json({ success: true });
  });

  // List active temp voice channels
  router.get('/:guildId/active', requireGuild, (req, res) => {
    const rows = db.prepare('SELECT * FROM temp_voice_channels WHERE guild_id = ?').all(req.params.guildId) as any[];

    const guild = client.guilds.cache.get(req.params.guildId);
    const enriched = rows.map(row => {
      const channel = guild?.channels.cache.get(row.channel_id);
      const owner   = guild?.members.cache.get(row.owner_id);
      return {
        ...row,
        channelName:  (channel as any)?.name ?? 'Unknown',
        memberCount:  (channel as any)?.members?.size ?? 0,
        userLimit:    (channel as any)?.userLimit ?? 0,
        ownerName:    owner?.displayName ?? row.owner_id,
        ownerAvatar:  owner?.displayAvatarURL({ size: 32 }) ?? null,
      };
    });

    res.json(enriched);
  });

  // Force-delete a temp channel
  router.delete('/:guildId/:channelId', requireGuild, async (req, res) => {
    const { guildId, channelId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const channel = guild.channels.cache.get(channelId);
      if (channel) await channel.delete('Deleted via web panel').catch(() => {});
    }
    db.prepare('DELETE FROM temp_voice_channels WHERE channel_id = ? AND guild_id = ?').run(channelId, guildId);
    res.json({ success: true });
  });

  // User voice settings
  router.get('/:guildId/user-settings', requireGuild, (req, res) => {
    const rows = db.prepare('SELECT * FROM temp_voice_user_settings').all();
    res.json(rows);
  });

  return router;
}
