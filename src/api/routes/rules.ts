import { Router } from 'express';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';
import { nanoid } from '../../utils/nanoid';

export function rulesRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // List panels
  router.get('/:guildId', requireGuild, (req, res) => {
    const panels = db.prepare('SELECT * FROM rules_panels WHERE guild_id = ? ORDER BY created_at DESC').all(req.params.guildId) as any[];
    const enriched = panels.map(p => ({
      ...p,
      rules: db.prepare('SELECT * FROM rules_items WHERE panel_id = ? ORDER BY number ASC').all(p.id),
    }));
    res.json(enriched);
  });

  // Create panel
  router.post('/:guildId', requireGuild, async (req, res) => {
    const { channelId, title, color, footer, description } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return res.status(400).json({ error: 'Channel not found' });

    const panelId = nanoid(8);
    const t = title   ?? '📜 Server Rules';
    const c = color   ?? '#5865F2';
    const f = footer  ?? 'Breaking rules may result in a mute, kick, or ban.';
    const d = description ?? null;

    db.prepare('INSERT INTO rules_panels (id, guild_id, channel_id, title, color, footer, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(panelId, req.params.guildId, channelId, t, c, f, d);

    const embed = new EmbedBuilder().setTitle(t).setDescription(d || '*No rules added yet.*').setColor(c as any).setFooter({ text: f }).setTimestamp();
    const msg = await channel.send({ embeds: [embed] });
    db.prepare('UPDATE rules_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
    res.json({ success: true, id: panelId });
  });

  // Update panel metadata
  router.patch('/:guildId/:panelId', requireGuild, async (req, res) => {
    const { title, color, footer, description } = req.body;
    db.prepare('UPDATE rules_panels SET title = COALESCE(?,title), color = COALESCE(?,color), footer = COALESCE(?,footer), description = COALESCE(?,description) WHERE id = ? AND guild_id = ?')
      .run(title, color, footer, description, req.params.panelId, req.params.guildId);
    await rebuildPanel(req.params.panelId, req.params.guildId, client, db);
    res.json({ success: true });
  });

  // Add / update a rule
  router.put('/:guildId/:panelId/rules/:number', requireGuild, async (req, res) => {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });
    db.prepare('INSERT OR REPLACE INTO rules_items (panel_id, guild_id, number, title, body) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.panelId, req.params.guildId, parseInt(req.params.number), title, body);
    await rebuildPanel(req.params.panelId, req.params.guildId, client, db);
    res.json({ success: true });
  });

  // Delete a rule
  router.delete('/:guildId/:panelId/rules/:number', requireGuild, async (req, res) => {
    db.prepare('DELETE FROM rules_items WHERE panel_id = ? AND number = ?').run(req.params.panelId, parseInt(req.params.number));
    await rebuildPanel(req.params.panelId, req.params.guildId, client, db);
    res.json({ success: true });
  });

  // Delete panel
  router.delete('/:guildId/:panelId', requireGuild, async (req, res) => {
    const panel = db.prepare('SELECT * FROM rules_panels WHERE id = ? AND guild_id = ?').get(req.params.panelId, req.params.guildId) as any;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });
    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild && panel.message_id) {
      const ch = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
      if (ch) await ch.messages.delete(panel.message_id).catch(() => {});
    }
    db.prepare('DELETE FROM rules_panels WHERE id = ?').run(req.params.panelId);
    res.json({ success: true });
  });

  return router;
}

async function rebuildPanel(panelId: string, guildId: string, client: Client, db: DatabaseSync) {
  const panel = db.prepare('SELECT * FROM rules_panels WHERE id = ?').get(panelId) as any;
  if (!panel?.message_id) return;
  const rules = db.prepare('SELECT * FROM rules_items WHERE panel_id = ? ORDER BY number ASC').all(panelId) as any[];
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const ch = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
  if (!ch) return;
  try {
    const msg = await ch.messages.fetch(panel.message_id);
    const embed = new EmbedBuilder().setTitle(panel.title).setColor(panel.color).setFooter({ text: panel.footer }).setTimestamp();
    if (panel.description) embed.setDescription(panel.description);
    for (const rule of rules) embed.addFields({ name: `${rule.number}. ${rule.title}`, value: rule.body });
    if (!rules.length) embed.setDescription(panel.description || '*No rules added yet.*');
    await msg.edit({ embeds: [embed] });
  } catch {}
}
