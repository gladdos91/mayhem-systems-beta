import { Router } from 'express';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { requireAuth, requireGuild } from '../middleware';

export function serverLogsRouter(client: Client, db: DatabaseSync) {
  const router = Router();
  router.use(requireAuth);

  // Get config
  router.get('/:guildId', requireGuild, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO server_log_config (guild_id) VALUES (?)').run(req.params.guildId);
    const cfg = db.prepare('SELECT * FROM server_log_config WHERE guild_id = ?').get(req.params.guildId);
    res.json(cfg);
  });

  // Update config (partial)
  router.patch('/:guildId', requireGuild, (req, res) => {
    const allowed = [
      'enabled', 'default_channel',
      'member_join_channel', 'member_leave_channel', 'member_ban_channel',
      'message_delete_channel', 'message_edit_channel',
      'role_change_channel', 'voice_channel_channel', 'channel_change_channel',
      'log_member_join', 'log_member_leave', 'log_member_ban',
      'log_message_delete', 'log_message_edit',
      'log_role_change', 'log_voice_channel', 'log_channel_change',
    ];
    const updates: string[] = [];
    const vals:    any[]    = [];
    for (const key of allowed) {
      if (key in req.body) { updates.push(`${key} = ?`); vals.push(req.body[key]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.guildId);
    db.prepare(`UPDATE server_log_config SET ${updates.join(', ')} WHERE guild_id = ?`).run(...vals);
    res.json({ success: true });
  });

  return router;
}
