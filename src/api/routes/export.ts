/**
 * Export / Import route — Mayhem Systems Discord Control
 * 
 * Exports all guild configuration to a single JSON file.
 * Imports from that file, restoring all settings.
 *
 * Exported data (mirrors OpenTicket's Portal export concept):
 *  - ticket panels, categories, questions, category configs
 *  - automod config
 *  - welcome config + auto roles
 *  - reaction role panels + items
 *  - rules panels + items
 *  - server log config
 *  - temp voice config
 *
 * Does NOT export: ticket messages/history, server logs events,
 *                  transcripts, warnings (runtime data)
 */

import { Router, Request, Response } from 'express';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function exportRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // ── GET /api/export/:guildId — download full config as JSON ────────────────
  router.get('/:guildId', requireGuild, (req: Request, res: Response) => {
    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);

    try {
      const data: Record<string, any> = {
        _meta: {
          version:    '2.0',
          system:     "Mayhem Systems Discord Control",
          exported_at: new Date().toISOString(),
          guild_id:   guildId,
          guild_name: guild?.name ?? 'Unknown',
        },

        // ── Tickets ──────────────────────────────────────────────────────
        ticket_panels: db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ?').all(guildId),
        ticket_categories: db.prepare('SELECT * FROM ticket_categories WHERE guild_id = ?').all(guildId),
        ticket_form_questions: db.prepare('SELECT * FROM ticket_form_questions WHERE guild_id = ?').all(guildId),
        ticket_category_configs: db.prepare('SELECT * FROM ticket_category_config WHERE guild_id = ?').all(guildId),
        ticket_blacklist: db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ?').all(guildId),

        // ── AutoMod ──────────────────────────────────────────────────────
        automod: (() => {
          const cfg = db.prepare('SELECT * FROM automod_config WHERE guild_id = ?').get(guildId) as any;
          if (!cfg) return null;
          // Parse JSON fields
          cfg.bad_words_list  = JSON.parse(cfg.bad_words_list  ?? '[]');
          cfg.links_whitelist = JSON.parse(cfg.links_whitelist ?? '[]');
          cfg.exempt_roles    = JSON.parse(cfg.exempt_roles    ?? '[]');
          cfg.exempt_channels = JSON.parse(cfg.exempt_channels ?? '[]');
          return cfg;
        })(),

        // ── Welcome ──────────────────────────────────────────────────────
        welcome: db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(guildId) ?? null,
        auto_roles: db.prepare('SELECT * FROM auto_roles WHERE guild_id = ? ORDER BY created_at').all(guildId),

        // ── Reaction Roles ───────────────────────────────────────────────
        reaction_role_panels: (() => {
          const panels = db.prepare('SELECT * FROM reaction_role_panels WHERE guild_id = ?').all(guildId) as any[];
          return panels.map(p => ({
            ...p,
            items: db.prepare('SELECT * FROM reaction_role_items WHERE panel_id = ?').all(p.id),
          }));
        })(),

        // ── Rules ────────────────────────────────────────────────────────
        rules_panels: (() => {
          const panels = db.prepare('SELECT * FROM rules_panels WHERE guild_id = ?').all(guildId) as any[];
          return panels.map(p => ({
            ...p,
            rules: db.prepare('SELECT * FROM rules_items WHERE panel_id = ? ORDER BY number').all(p.id),
          }));
        })(),

        // ── Server Logs ──────────────────────────────────────────────────
        server_logs: db.prepare('SELECT * FROM server_log_config WHERE guild_id = ?').get(guildId) ?? null,

        // ── Temp Voice ───────────────────────────────────────────────────
        temp_voice: db.prepare('SELECT * FROM temp_voice_config WHERE guild_id = ?').get(guildId) ?? null,
      };

      const filename = `mayhem-export-${guildId}-${Date.now()}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(data, null, 2));

    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/export/:guildId/import — restore from JSON ──────────────────
  router.post('/:guildId/import', requireGuild, (req: Request, res: Response) => {
    const { guildId } = req.params;
    const data = req.body;

    if (!data?._meta) return res.status(400).json({ error: 'Invalid export file — missing _meta' });
    if (data._meta.version !== '2.0') return res.status(400).json({ error: 'Incompatible export version' });

    const results: Record<string, string> = {};

    try {
      // Use a transaction so partial imports roll back on error
      db.exec('BEGIN');
      try {

        // ── Ticket panels ───────────────────────────────────────────────
        if (Array.isArray(data.ticket_panels)) {
          for (const p of data.ticket_panels) {
            db.prepare(`
              INSERT OR REPLACE INTO ticket_panels
                (id, guild_id, channel_id, message_id, title, description, color, style, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(p.id, guildId, p.channel_id, p.message_id ?? null, p.title, p.description, p.color, p.style ?? 'buttons', p.created_at);
          }
          results.ticket_panels = `${data.ticket_panels.length} imported`;
        }

        // ── Ticket categories ───────────────────────────────────────────
        if (Array.isArray(data.ticket_categories)) {
          for (const c of data.ticket_categories) {
            db.prepare(`
              INSERT OR REPLACE INTO ticket_categories
                (id, panel_id, guild_id, label, description, emoji, color, category_id, closed_category, admin_roles, readonly_roles, channel_prefix, welcome_message, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(c.id, c.panel_id, guildId, c.label, c.description ?? '', c.emoji ?? '🎫', c.color, c.category_id ?? null, c.closed_category ?? null, c.admin_roles ?? '[]', c.readonly_roles ?? '[]', c.channel_prefix ?? 'ticket-', c.welcome_message ?? null, c.sort_order ?? 0);
          }
          results.ticket_categories = `${data.ticket_categories.length} imported`;
        }

        // ── Form questions ──────────────────────────────────────────────
        if (Array.isArray(data.ticket_form_questions)) {
          for (const q of data.ticket_form_questions) {
            db.prepare(`
              INSERT OR REPLACE INTO ticket_form_questions
                (id, category_id, guild_id, sort_order, label, style, placeholder, required)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(q.id, q.category_id, guildId, q.sort_order ?? 0, q.label, q.style ?? 'short', q.placeholder ?? null, q.required ?? 1);
          }
          results.questions = `${data.ticket_form_questions.length} imported`;
        }

        // ── Category configs ────────────────────────────────────────────
        if (Array.isArray(data.ticket_category_configs)) {
          for (const cfg of data.ticket_category_configs) {
            db.prepare(`
              INSERT OR REPLACE INTO ticket_category_config
                (category_id, guild_id, autoclose_enabled, autoclose_hours, autoclose_on_leave,
                 autodelete_enabled, autodelete_days, cooldown_enabled, cooldown_minutes,
                 global_max, user_max, slowmode_enabled, slowmode_seconds)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(cfg.category_id, guildId,
              cfg.autoclose_enabled ?? 0, cfg.autoclose_hours ?? 24, cfg.autoclose_on_leave ?? 0,
              cfg.autodelete_enabled ?? 0, cfg.autodelete_days ?? 7,
              cfg.cooldown_enabled ?? 0, cfg.cooldown_minutes ?? 10,
              cfg.global_max ?? 0, cfg.user_max ?? 3,
              cfg.slowmode_enabled ?? 0, cfg.slowmode_seconds ?? 20);
          }
          results.category_configs = `${data.ticket_category_configs.length} imported`;
        }

        // ── AutoMod ─────────────────────────────────────────────────────
        if (data.automod) {
          const a = data.automod;
          db.prepare(`
            INSERT OR REPLACE INTO automod_config
              (guild_id, enabled, log_channel,
               bad_words_enabled, bad_words_action, bad_words_list,
               spam_enabled, spam_threshold, spam_interval, spam_action, spam_mute_duration,
               links_enabled, links_action, links_whitelist,
               invites_enabled, invites_action,
               caps_enabled, caps_threshold, caps_min_length, caps_action,
               mentions_enabled, mentions_threshold, mentions_action,
               exempt_roles, exempt_channels)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            guildId, a.enabled ?? 1, a.log_channel ?? null,
            a.bad_words_enabled ?? 0, a.bad_words_action ?? 'delete',
            JSON.stringify(Array.isArray(a.bad_words_list) ? a.bad_words_list : []),
            a.spam_enabled ?? 0, a.spam_threshold ?? 5, a.spam_interval ?? 5, a.spam_action ?? 'mute', a.spam_mute_duration ?? 5,
            a.links_enabled ?? 0, a.links_action ?? 'delete',
            JSON.stringify(Array.isArray(a.links_whitelist) ? a.links_whitelist : []),
            a.invites_enabled ?? 0, a.invites_action ?? 'delete',
            a.caps_enabled ?? 0, a.caps_threshold ?? 70, a.caps_min_length ?? 10, a.caps_action ?? 'delete',
            a.mentions_enabled ?? 0, a.mentions_threshold ?? 5, a.mentions_action ?? 'mute',
            JSON.stringify(Array.isArray(a.exempt_roles)    ? a.exempt_roles    : []),
            JSON.stringify(Array.isArray(a.exempt_channels) ? a.exempt_channels : []),
          );
          results.automod = 'imported';
        }

        // ── Welcome ─────────────────────────────────────────────────────
        if (data.welcome) {
          const w = data.welcome;
          db.prepare(`
            INSERT OR REPLACE INTO welcome_config
              (guild_id, enabled, channel_id, title, description, color, image_url, thumbnail_type,
               footer_text, dm_enabled, dm_message, ping_user)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(guildId, w.enabled ?? 1, w.channel_id ?? null, w.title, w.description, w.color ?? '#57F287',
            w.image_url ?? null, w.thumbnail_type ?? 'avatar', w.footer_text, w.dm_enabled ?? 0, w.dm_message, w.ping_user ?? 1);
          results.welcome = 'imported';
        }

        // ── Auto roles ──────────────────────────────────────────────────
        if (Array.isArray(data.auto_roles)) {
          db.prepare('DELETE FROM auto_roles WHERE guild_id = ?').run(guildId);
          for (const r of data.auto_roles) {
            db.prepare('INSERT OR IGNORE INTO auto_roles (guild_id, role_id, label) VALUES (?, ?, ?)').run(guildId, r.role_id, r.label ?? null);
          }
          results.auto_roles = `${data.auto_roles.length} imported`;
        }

        // ── Reaction role panels ────────────────────────────────────────
        if (Array.isArray(data.reaction_role_panels)) {
          for (const p of data.reaction_role_panels) {
            db.prepare(`
              INSERT OR REPLACE INTO reaction_role_panels
                (id, guild_id, channel_id, message_id, title, description, color, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(p.id, guildId, p.channel_id, p.message_id ?? null, p.title, p.description, p.color, p.created_at);
            if (Array.isArray(p.items)) {
              for (const item of p.items) {
                db.prepare('INSERT OR IGNORE INTO reaction_role_items (panel_id, guild_id, emoji, role_id, label) VALUES (?, ?, ?, ?, ?)')
                  .run(p.id, guildId, item.emoji, item.role_id, item.label ?? null);
              }
            }
          }
          results.reaction_role_panels = `${data.reaction_role_panels.length} imported`;
        }

        // ── Rules panels ────────────────────────────────────────────────
        if (Array.isArray(data.rules_panels)) {
          for (const p of data.rules_panels) {
            db.prepare(`
              INSERT OR REPLACE INTO rules_panels
                (id, guild_id, channel_id, message_id, title, description, color, footer, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(p.id, guildId, p.channel_id, p.message_id ?? null, p.title, p.description ?? null, p.color, p.footer, p.created_at);
            if (Array.isArray(p.rules)) {
              for (const r of p.rules) {
                db.prepare('INSERT OR IGNORE INTO rules_items (panel_id, guild_id, number, title, body) VALUES (?, ?, ?, ?, ?)')
                  .run(p.id, guildId, r.number, r.title, r.body);
              }
            }
          }
          results.rules_panels = `${data.rules_panels.length} imported`;
        }

        // ── Server logs ─────────────────────────────────────────────────
        if (data.server_logs) {
          const l = data.server_logs;
          db.prepare(`
            INSERT OR REPLACE INTO server_log_config
              (guild_id, enabled, default_channel,
               member_join_channel, member_leave_channel, member_ban_channel,
               message_delete_channel, message_edit_channel, role_change_channel,
               voice_channel_channel, channel_change_channel,
               log_member_join, log_member_leave, log_member_ban,
               log_message_delete, log_message_edit, log_role_change,
               log_voice_channel, log_channel_change)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(guildId, l.enabled ?? 1, l.default_channel ?? null,
            l.member_join_channel ?? null, l.member_leave_channel ?? null, l.member_ban_channel ?? null,
            l.message_delete_channel ?? null, l.message_edit_channel ?? null, l.role_change_channel ?? null,
            l.voice_channel_channel ?? null, l.channel_change_channel ?? null,
            l.log_member_join ?? 1, l.log_member_leave ?? 1, l.log_member_ban ?? 1,
            l.log_message_delete ?? 1, l.log_message_edit ?? 1, l.log_role_change ?? 1,
            l.log_voice_channel ?? 0, l.log_channel_change ?? 0);
          results.server_logs = 'imported';
        }

        // ── Temp voice ──────────────────────────────────────────────────
        if (data.temp_voice) {
          const v = data.temp_voice;
          db.prepare(`
            INSERT OR REPLACE INTO temp_voice_config (guild_id, hub_channel_id, category_id, default_limit)
            VALUES (?, ?, ?, ?)
          `).run(guildId, v.hub_channel_id, v.category_id, v.default_limit ?? 0);
          results.temp_voice = 'imported';
        }

        db.exec('COMMIT');
      } catch (txErr: any) {
        db.exec('ROLLBACK');
        throw txErr;
      }

      res.json({ success: true, results, imported_at: new Date().toISOString() });

    } catch (err: any) {
      console.error('[Export] Import error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
