import { Router } from 'express';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth } from '../middleware';

export function guildsRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // List guilds the user manages and the bot is in
  router.get('/', (req, res) => {
    const guilds = (req.session.guilds ?? []).map(g => {
      const botGuild = client.guilds.cache.get(g.id);
      return {
        id:          g.id,
        name:        g.name,
        icon:        g.icon
          ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
          : null,
        memberCount: botGuild?.memberCount ?? '?',
      };
    });
    res.json(guilds);
  });

  // Overview stats for a single guild
  router.get('/:guildId/stats', (req, res) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const openTickets  = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id=? AND status='open'").get(guildId) as any).c;
    const totalTickets = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE guild_id=?').get(guildId) as any).c;
    const activeVoice  = (db.prepare('SELECT COUNT(*) as c FROM temp_voice_channels WHERE guild_id=?').get(guildId) as any).c;
    const announcements = (db.prepare('SELECT COUNT(*) as c FROM announcements WHERE guild_id=?').get(guildId) as any).c;
    const warnings     = (db.prepare("SELECT COUNT(*) as c FROM automod_warnings WHERE guild_id=? AND created_at > unixepoch()-86400").get(guildId) as any).c;

    res.json({
      memberCount:   guild.memberCount,
      openTickets,
      totalTickets,
      activeVoice,
      announcements,
      warningsToday: warnings,
    });
  });

  // List all channels in a guild (for dropdowns)
  router.get('/:guildId/channels', (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const channels = guild.channels.cache
      .filter(c => [0, 5, 4].includes(c.type)) // text, announcement, category
      .map(c => ({ id: c.id, name: c.name, type: c.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(channels);
  });

  // List all roles in a guild
  router.get('/:guildId/roles', (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const roles = guild.roles.cache
      .filter(r => !r.managed && r.name !== '@everyone')
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(roles);
  });

  return router;
}
