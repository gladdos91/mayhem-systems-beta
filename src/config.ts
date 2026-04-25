import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  discordToken:  requireEnv('DISCORD_TOKEN'),
  clientId:      requireEnv('CLIENT_ID'),
  clientSecret:  process.env.CLIENT_SECRET ?? '',
  port:          parseInt(process.env.PORT ?? '3000', 10),
  sessionSecret: process.env.SESSION_SECRET ?? 'changeme',
  panelUrl:      process.env.PANEL_URL ?? 'http://localhost:3000',
  databasePath:  process.env.DATABASE_PATH ?? './data/nexus.db',
  allowedGuilds: process.env.ALLOWED_GUILDS
    ? process.env.ALLOWED_GUILDS.split(',').map(s => s.trim())
    : [],
};
