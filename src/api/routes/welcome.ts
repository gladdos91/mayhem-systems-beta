import { Router } from 'express';
import { Client, TextChannel } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function welcomeRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // ── Get welcome config ───────────────────────────────────────────
  router.get('/:guildId', requireGuild, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(req.params.guildId);
    const cfg   = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(req.params.guildId);
    const roles = db.prepare('SELECT * FROM auto_roles WHERE guild_id = ? ORDER BY created_at ASC').all(req.params.guildId);
    res.json({ config: cfg, autoRoles: roles });
  });

  // ── Update welcome config ────────────────────────────────────────
  router.patch('/:guildId', requireGuild, (req, res) => {
    const allowed = [
      'enabled', 'channel_id', 'title', 'description', 'color',
      'image_url', 'thumbnail_type', 'footer_text',
      'dm_enabled', 'dm_message', 'ping_user',
    ];
    const updates: string[] = [];
    const vals:    any[]    = [];
    for (const key of allowed) {
      if (key in req.body) { updates.push(`${key} = ?`); vals.push(req.body[key]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.guildId);
    db.prepare(`UPDATE welcome_config SET ${updates.join(', ')} WHERE guild_id = ?`).run(...vals);
    res.json({ success: true });
  });

  // ── Send a test welcome ──────────────────────────────────────────
  router.post('/:guildId/test', requireGuild, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    try {
      const member = await guild.members.fetch(userId);
      // Reuse module logic via HTTP-triggered test
      const cfg = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(req.params.guildId) as any;
      if (!cfg?.channel_id) return res.status(400).json({ error: 'No welcome channel set' });
      const channel = guild.channels.cache.get(cfg.channel_id) as TextChannel | undefined;
      if (!channel) return res.status(400).json({ error: 'Welcome channel not found' });

      const { EmbedBuilder } = await import('discord.js');
      const resolve = (t: string) => t
        .replace(/{user}/gi, `<@${member.id}>`)
        .replace(/{username}/gi, member.user.username)
        .replace(/{server}/gi, guild.name)
        .replace(/{count}/gi, String(guild.memberCount));

      const embed = new EmbedBuilder()
        .setTitle(resolve(cfg.title))
        .setDescription(resolve(cfg.description))
        .setColor(cfg.color)
        .setFooter({ text: resolve(cfg.footer_text) })
        .setTimestamp();

      if (cfg.thumbnail_type === 'avatar') embed.setThumbnail(member.user.displayAvatarURL({ size: 128 }));
      if (cfg.image_url) embed.setImage(cfg.image_url);

      await channel.send({ content: cfg.ping_user ? `<@${member.id}>` : undefined, embeds: [embed] });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Auto Roles ───────────────────────────────────────────────────
  router.get('/:guildId/autoroles', requireGuild, (req, res) => {
    const roles = db.prepare('SELECT * FROM auto_roles WHERE guild_id = ? ORDER BY created_at ASC').all(req.params.guildId);
    res.json(roles);
  });

  router.post('/:guildId/autoroles', requireGuild, (req, res) => {
    const { roleId, label } = req.body;
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    db.prepare('INSERT OR IGNORE INTO auto_roles (guild_id, role_id, label) VALUES (?, ?, ?)').run(req.params.guildId, roleId, label ?? null);
    res.json({ success: true });
  });

  router.delete('/:guildId/autoroles/:roleId', requireGuild, (req, res) => {
    db.prepare('DELETE FROM auto_roles WHERE guild_id = ? AND role_id = ?').run(req.params.guildId, req.params.roleId);
    res.json({ success: true });
  });

  return router;
}
