import { Router } from 'express';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function automodRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // Get automod config
  router.get('/:guildId', requireGuild, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)').run(req.params.guildId);
    const cfg = db.prepare('SELECT * FROM automod_config WHERE guild_id = ?').get(req.params.guildId) as any;
    // Parse JSON fields
    cfg.bad_words_list  = JSON.parse(cfg.bad_words_list  ?? '[]');
    cfg.links_whitelist = JSON.parse(cfg.links_whitelist ?? '[]');
    cfg.exempt_roles    = JSON.parse(cfg.exempt_roles    ?? '[]');
    cfg.exempt_channels = JSON.parse(cfg.exempt_channels ?? '[]');
    res.json(cfg);
  });

  // Update automod config (full or partial)
  router.patch('/:guildId', requireGuild, (req, res) => {
    const guildId = req.params.guildId;
    db.prepare('INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)').run(guildId);

    const allowed = [
      'enabled', 'log_channel',
      'bad_words_enabled', 'bad_words_action', 'bad_words_list',
      'spam_enabled', 'spam_threshold', 'spam_interval', 'spam_action', 'spam_mute_duration',
      'links_enabled', 'links_action', 'links_whitelist',
      'invites_enabled', 'invites_action',
      'caps_enabled', 'caps_threshold', 'caps_min_length', 'caps_action',
      'mentions_enabled', 'mentions_threshold', 'mentions_action',
      'exempt_roles', 'exempt_channels',
    ];

    const updates: string[] = [];
    const values:  any[]    = [];

    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        const val = req.body[key];
        // Serialize arrays to JSON
        values.push(Array.isArray(val) ? JSON.stringify(val) : val);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(guildId);
    db.prepare(`UPDATE automod_config SET ${updates.join(', ')} WHERE guild_id = ?`).run(...values);
    res.json({ success: true });
  });

  // Get warnings for a guild
  router.get('/:guildId/warnings', requireGuild, (req, res) => {
    const { userId, limit = '50' } = req.query;
    const limitNum = parseInt(limit as string);
    const rows = userId
      ? db.prepare('SELECT * FROM automod_warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(req.params.guildId, String(userId), limitNum)
      : db.prepare('SELECT * FROM automod_warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(req.params.guildId, limitNum);
    res.json(rows);
  });

  // Clear warnings
  router.delete('/:guildId/warnings/:userId', requireGuild, (req, res) => {
    const { changes } = db.prepare('DELETE FROM automod_warnings WHERE guild_id = ? AND user_id = ?')
      .run(req.params.guildId, req.params.userId) as any;
    res.json({ success: true, deleted: changes });
  });

  // Warning stats
  router.get('/:guildId/warnings/stats', requireGuild, (req, res) => {
    const guildId = req.params.guildId;
    const today   = (db.prepare("SELECT COUNT(*) as c FROM automod_warnings WHERE guild_id=? AND created_at > unixepoch()-86400").get(guildId) as any).c;
    const week    = (db.prepare("SELECT COUNT(*) as c FROM automod_warnings WHERE guild_id=? AND created_at > unixepoch()-604800").get(guildId) as any).c;
    const total   = (db.prepare("SELECT COUNT(*) as c FROM automod_warnings WHERE guild_id=?").get(guildId) as any).c;
    res.json({ today, week, total });
  });

  return router;
}
