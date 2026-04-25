import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  // Bot token — supports both DISCORD_BOT_TOKEN and DISCORD_TOKEN
  discordToken:   process.env.DISCORD_BOT_TOKEN ?? requireEnv('DISCORD_TOKEN'),

  // OAuth2 — supports both DISCORD_CLIENT_ID and CLIENT_ID
  clientId:       process.env.DISCORD_CLIENT_ID ?? requireEnv('CLIENT_ID'),
  clientSecret:   process.env.DISCORD_CLIENT_SECRET ?? process.env.CLIENT_SECRET ?? '',

  // Server
  port:           parseInt(process.env.PORT ?? '3001', 10),
  sessionSecret:  process.env.SESSION_SECRET ?? 'changeme',

  // Dashboard URL — supports both DASHBOARD_URL and PANEL_URL
  panelUrl:       process.env.DASHBOARD_URL ?? process.env.PANEL_URL ?? 'http://localhost:3001',

  // Explicit callback URL if set, otherwise build from panelUrl
  callbackUrl:    process.env.DISCORD_CALLBACK_URL ?? null,

  // SQLite database path (we use node:sqlite, not PostgreSQL)
  databasePath:   process.env.DATABASE_PATH ?? './data/mayhem.db',

  allowedGuilds:  process.env.ALLOWED_GUILDS
    ? process.env.ALLOWED_GUILDS.split(',').map(s => s.trim())
    : [],
};
