import { Router } from 'express';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';
import { nanoid } from '../../utils/nanoid';

export function reactionRolesRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // List panels
  router.get('/:guildId', requireGuild, (req, res) => {
    const panels = db.prepare('SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY created_at DESC').all(req.params.guildId) as any[];
    const enriched = panels.map(p => ({
      ...p,
      items: db.prepare('SELECT * FROM reaction_role_items WHERE panel_id = ?').all(p.id),
    }));
    res.json(enriched);
  });

  // Create panel
  router.post('/:guildId', requireGuild, async (req, res) => {
    const { channelId, title, description, color } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return res.status(400).json({ error: 'Channel not found' });

    const panelId = nanoid(8);
    const t = title ?? '🎭 Reaction Roles';
    const d = description ?? 'React below to assign yourself roles!';
    const c = color ?? '#5865F2';

    db.prepare('INSERT INTO reaction_role_panels (id, guild_id, channel_id, title, description, color) VALUES (?, ?, ?, ?, ?, ?)')
      .run(panelId, req.params.guildId, channelId, t, d, c);

    const embed = new EmbedBuilder().setTitle(t).setDescription(`${d}\n\n*No roles added yet.*`).setColor(c as any).setFooter({ text: `Panel ID: ${panelId}` }).setTimestamp();
    const msg = await channel.send({ embeds: [embed] });
    db.prepare('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
    res.json({ success: true, id: panelId });
  });

  // Add role to panel
  router.post('/:guildId/:panelId/items', requireGuild, async (req, res) => {
    const { emoji, roleId, label } = req.body;
    if (!emoji || !roleId) return res.status(400).json({ error: 'emoji and roleId required' });

    const panel = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?').get(req.params.panelId, req.params.guildId) as any;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    db.prepare('INSERT OR REPLACE INTO reaction_role_items (panel_id, guild_id, emoji, role_id, label) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.panelId, req.params.guildId, emoji, roleId, label ?? null);

    await rebuildPanel(req.params.panelId, req.params.guildId, client, db);
    res.json({ success: true });
  });

  // Remove role from panel
  router.delete('/:guildId/:panelId/items/:itemId', requireGuild, async (req, res) => {
    db.prepare('DELETE FROM reaction_role_items WHERE id = ? AND panel_id = ?').run(req.params.itemId, req.params.panelId);
    await rebuildPanel(req.params.panelId, req.params.guildId, client, db);
    res.json({ success: true });
  });

  // Delete panel
  router.delete('/:guildId/:panelId', requireGuild, async (req, res) => {
    const panel = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?').get(req.params.panelId, req.params.guildId) as any;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild && panel.message_id) {
      const ch = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
      if (ch) await ch.messages.delete(panel.message_id).catch(() => {});
    }
    db.prepare('DELETE FROM reaction_role_panels WHERE id = ?').run(req.params.panelId);
    res.json({ success: true });
  });

  return router;
}

async function rebuildPanel(panelId: string, guildId: string, client: Client, db: DatabaseSync) {
  const panel = db.prepare('SELECT * FROM reaction_role_panels WHERE id = ?').get(panelId) as any;
  if (!panel?.message_id) return;
  const items = db.prepare('SELECT * FROM reaction_role_items WHERE panel_id = ?').all(panelId) as any[];
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const ch = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
  if (!ch) return;
  try {
    const msg = await ch.messages.fetch(panel.message_id);
    const rolesText = items.length ? items.map((i: any) => `${i.emoji} — <@&${i.role_id}>${i.label ? ` *${i.label}*` : ''}`).join('\n') : '*No roles added yet.*';
    const embed = new EmbedBuilder().setTitle(panel.title).setDescription(`${panel.description}\n\n${rolesText}`).setColor(panel.color).setFooter({ text: `Panel ID: ${panel.id}` }).setTimestamp();
    await msg.edit({ embeds: [embed] });
    await msg.reactions.removeAll().catch(() => {});
    for (const item of items) await msg.react(item.emoji).catch(() => {});
  } catch {}
}
