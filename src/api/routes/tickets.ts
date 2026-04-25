import { Router } from 'express';
import { Client, TextChannel } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';
import { TicketsModule } from '../../modules/tickets';
import { nanoid } from '../../utils/nanoid';

let _ticketsModule: TicketsModule | null = null;
export function setTicketsModule(m: TicketsModule) { _ticketsModule = m; }

export function ticketsRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // ── Panels ────────────────────────────────────────────────────────

  router.get('/:guildId/panels', requireGuild, (req, res) => {
    const panels = db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at DESC').all(req.params.guildId) as any[];
    const enriched = panels.map(p => ({
      ...p,
      categories: db.prepare('SELECT * FROM ticket_categories WHERE panel_id = ? ORDER BY sort_order ASC, label ASC').all(p.id),
    }));
    res.json(enriched);
  });

  router.post('/:guildId/panels', requireGuild, async (req, res) => {
    const { channelId, title, description, color, panelStyle } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const panelId = nanoid(8);
    db.prepare(`
      INSERT INTO ticket_panels (id, guild_id, channel_id, title, description, color, panel_style)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(panelId, req.params.guildId, channelId,
      title ?? '🎫 Support Tickets',
      description ?? 'Select a ticket category below to open a support ticket.',
      color ?? '#5865F2',
      panelStyle ?? 'buttons');

    // Deploy initial panel
    await _ticketsModule?.rebuildPanel(panelId, db, guild);
    res.json({ success: true, id: panelId });
  });

  router.patch('/:guildId/panels/:panelId', requireGuild, async (req, res) => {
    const { title, description, color, panelStyle, allowMultipleOpen, channelId } = req.body;
    db.prepare(`
      UPDATE ticket_panels SET
        title               = COALESCE(?, title),
        description         = COALESCE(?, description),
        color               = COALESCE(?, color),
        panel_style         = COALESCE(?, panel_style),
        allow_multiple_open = COALESCE(?, allow_multiple_open),
        channel_id          = COALESCE(?, channel_id)
      WHERE id = ? AND guild_id = ?
    `).run(title, description, color, panelStyle,
           allowMultipleOpen !== undefined ? (allowMultipleOpen ? 1 : 0) : null,
           channelId ?? null,
           req.params.panelId, req.params.guildId);

    res.json({ success: true });
  });

  router.delete('/:guildId/panels/:panelId', requireGuild, async (req, res) => {
    const panel = db.prepare('SELECT * FROM ticket_panels WHERE id = ? AND guild_id = ?')
      .get(req.params.panelId, req.params.guildId) as any;
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild && panel.message_id) {
      const ch = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
      if (ch) await ch.messages.delete(panel.message_id).catch(() => {});
    }
    db.prepare('DELETE FROM ticket_panels WHERE id = ?').run(req.params.panelId);
    res.json({ success: true });
  });

  // Deploy / refresh panel
  router.post('/:guildId/panels/:panelId/deploy', requireGuild, async (req, res) => {
    const panel = db.prepare('SELECT id FROM ticket_panels WHERE id = ? AND guild_id = ?')
      .get(req.params.panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const ok = await _ticketsModule?.rebuildPanel(req.params.panelId, db, guild);
    res.json({ success: !!ok });
  });

  // ── Categories ────────────────────────────────────────────────────

  router.get('/:guildId/panels/:panelId/categories', requireGuild, (req, res) => {
    const cats = db.prepare('SELECT * FROM ticket_categories WHERE panel_id = ? ORDER BY sort_order ASC, label ASC')
      .all(req.params.panelId) as any[];
    const enriched = cats.map(c => ({
      ...c,
      admin_roles: JSON.parse(c.admin_roles ?? '[]'),
      questions: db.prepare('SELECT * FROM ticket_form_questions WHERE category_id = ? ORDER BY sort_order ASC').all(c.id),
    }));
    res.json(enriched);
  });

  router.post('/:guildId/panels/:panelId/categories', requireGuild, async (req, res) => {
    const { label, emoji, description, color, categoryId, channelPrefix, adminRoles, welcomeMessage, allowGroup } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });

    const panel = db.prepare('SELECT id FROM ticket_panels WHERE id = ? AND guild_id = ?')
      .get(req.params.panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    const catId = nanoid(8);
    const count = (db.prepare('SELECT COUNT(*) as c FROM ticket_categories WHERE panel_id = ?').get(req.params.panelId) as any).c;

    db.prepare(`
      INSERT INTO ticket_categories
        (id, panel_id, guild_id, label, emoji, description, color, category_id, channel_prefix, admin_roles, welcome_message, allow_group, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(catId, req.params.panelId, req.params.guildId,
      label, emoji ?? '🎫', description ?? '', color ?? 'Primary',
      categoryId ?? null, channelPrefix ?? 'ticket-',
      JSON.stringify(adminRoles ?? []),
      welcomeMessage ?? null, allowGroup ? 1 : 0, count);

    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild) await _ticketsModule?.rebuildPanel(req.params.panelId, db, guild);

    res.json({ success: true, id: catId });
  });

  router.patch('/:guildId/panels/:panelId/categories/:catId', requireGuild, async (req, res) => {
    const { label, emoji, description, color, categoryId, channelPrefix, adminRoles, welcomeMessage, allowGroup, sortOrder } = req.body;
    db.prepare(`
      UPDATE ticket_categories SET
        label           = COALESCE(?, label),
        emoji           = COALESCE(?, emoji),
        description     = COALESCE(?, description),
        color           = COALESCE(?, color),
        category_id     = COALESCE(?, category_id),
        channel_prefix  = COALESCE(?, channel_prefix),
        admin_roles     = COALESCE(?, admin_roles),
        welcome_message = COALESCE(?, welcome_message),
        allow_group     = COALESCE(?, allow_group),
        sort_order      = COALESCE(?, sort_order)
      WHERE id = ? AND guild_id = ?
    `).run(label, emoji, description, color, categoryId, channelPrefix,
           adminRoles ? JSON.stringify(adminRoles) : null,
           welcomeMessage, allowGroup !== undefined ? (allowGroup ? 1 : 0) : null,
           sortOrder ?? null,
           req.params.catId, req.params.guildId);

    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild) await _ticketsModule?.rebuildPanel(req.params.panelId, db, guild);
    res.json({ success: true });
  });

  router.delete('/:guildId/panels/:panelId/categories/:catId', requireGuild, async (req, res) => {
    db.prepare('DELETE FROM ticket_categories WHERE id = ? AND guild_id = ?').run(req.params.catId, req.params.guildId);
    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild) await _ticketsModule?.rebuildPanel(req.params.panelId, db, guild);
    res.json({ success: true });
  });

  // ── Form Questions ────────────────────────────────────────────────

  router.get('/:guildId/categories/:catId/questions', requireGuild, (req, res) => {
    const qs = db.prepare('SELECT * FROM ticket_form_questions WHERE category_id = ? ORDER BY sort_order ASC').all(req.params.catId);
    res.json(qs);
  });

  router.post('/:guildId/categories/:catId/questions', requireGuild, (req, res) => {
    const { label, style, placeholder, required } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });

    const count = (db.prepare('SELECT COUNT(*) as c FROM ticket_form_questions WHERE category_id = ?').get(req.params.catId) as any).c;
    if (count >= 5) return res.status(400).json({ error: 'Maximum 5 questions per category (Discord modal limit)' });

    const result = db.prepare(`
      INSERT INTO ticket_form_questions (category_id, guild_id, sort_order, label, style, placeholder, required)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.catId, req.params.guildId, count, label, style ?? 'short', placeholder ?? null, required ? 1 : 0);

    res.json({ success: true, id: result.lastInsertRowid });
  });

  router.patch('/:guildId/categories/:catId/questions/:qId', requireGuild, (req, res) => {
    const { label, style, placeholder, required, sortOrder } = req.body;
    db.prepare(`
      UPDATE ticket_form_questions SET
        label       = COALESCE(?, label),
        style       = COALESCE(?, style),
        placeholder = COALESCE(?, placeholder),
        required    = COALESCE(?, required),
        sort_order  = COALESCE(?, sort_order)
      WHERE id = ? AND category_id = ?
    `).run(label, style, placeholder, required !== undefined ? (required ? 1 : 0) : null,
           sortOrder ?? null, req.params.qId, req.params.catId);
    res.json({ success: true });
  });

  router.delete('/:guildId/categories/:catId/questions/:qId', requireGuild, (req, res) => {
    db.prepare('DELETE FROM ticket_form_questions WHERE id = ? AND category_id = ?').run(req.params.qId, req.params.catId);
    res.json({ success: true });
  });

  // ── Tickets (live) ────────────────────────────────────────────────

  router.get('/:guildId', requireGuild, (req, res) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100').all(req.params.guildId, status)
      : db.prepare('SELECT * FROM tickets WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.guildId);

    const enriched = (rows as any[]).map(t => {
      const cat = db.prepare('SELECT label FROM ticket_categories WHERE id = ?').get(t.category_id) as any;
      return { ...t, categoryName: cat?.label ?? 'Unknown' };
    });
    res.json(enriched);
  });

  router.post('/:guildId/:ticketId/close', requireGuild, async (req, res) => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(req.params.ticketId, req.params.guildId) as any;
    if (!ticket || ticket.status !== 'open') return res.status(400).json({ error: 'Ticket not open' });

    db.prepare("UPDATE tickets SET status = 'closed', closed_at = unixepoch() WHERE id = ?").run(ticket.id);
    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild) {
      const ch = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
      if (ch) await ch.send({ content: '🔒 Ticket closed via web panel.' }).catch(() => {});
    }
    res.json({ success: true });
  });

  router.delete('/:guildId/:ticketId', requireGuild, async (req, res) => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(req.params.ticketId, req.params.guildId) as any;
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const guild = client.guilds.cache.get(req.params.guildId);
    if (guild) {
      const ch = guild.channels.cache.get(ticket.channel_id);
      if (ch) await ch.delete('Deleted via panel').catch(() => {});
    }
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    res.json({ success: true });
  });

  router.get('/:guildId/:ticketId/transcript', requireGuild, (req, res) => {
    const t = db.prepare('SELECT transcript FROM tickets WHERE id = ? AND guild_id = ?').get(req.params.ticketId, req.params.guildId) as any;
    if (!t?.transcript) return res.status(404).json({ error: 'No transcript' });
    res.setHeader('Content-Type', 'text/html');
    res.send(t.transcript);
  });

  router.get('/:guildId/stats/summary', requireGuild, (req, res) => {
    const g = req.params.guildId;
    res.json({
      open:   (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id=? AND status='open'").get(g) as any).c,
      closed: (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id=? AND status='closed'").get(g) as any).c,
      today:  (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id=? AND created_at > unixepoch()-86400").get(g) as any).c,
    });
  });

  return router;
}
