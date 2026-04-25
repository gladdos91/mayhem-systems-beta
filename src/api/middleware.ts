import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** Checks that the user has Manage Guild permission in the target guild */
export function requireGuild(req: Request, res: Response, next: NextFunction) {
  const guildId = req.params.guildId ?? req.body.guildId ?? req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'Missing guildId' });

  const userGuilds: any[] = req.session.guilds ?? [];
  const guild = userGuilds.find(g => g.id === guildId);
  if (!guild) return res.status(403).json({ error: 'No access to this guild' });

  // Manage Guild = 0x20
  const hasManageGuild = (BigInt(guild.permissions) & 0x20n) === 0x20n || guild.owner;
  if (!hasManageGuild) return res.status(403).json({ error: 'Missing Manage Guild permission' });

  next();
}
