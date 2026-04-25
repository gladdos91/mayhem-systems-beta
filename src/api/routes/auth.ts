import { Router } from 'express';
import axios from 'axios';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../../config';

const DISCORD_API   = 'https://discord.com/api/v10';
const SCOPES        = 'identify guilds';
const REDIRECT_URI  = `${config.panelUrl}/auth/callback`;

export function authRouter(client: Client, _db: DatabaseSync) {
  const router = Router();

  // ── Step 1: Redirect to Discord ─────────────────────────────────
  router.get('/login', (_req, res) => {
    const params = new URLSearchParams({
      client_id:     config.clientId,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      scope:         SCOPES,
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  // ── Step 2: Handle callback ──────────────────────────────────────
  router.get('/callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) return res.redirect('/?error=no_code');

    try {
      // Exchange code for token
      const tokenRes = await axios.post(
        `${DISCORD_API}/oauth2/token`,
        new URLSearchParams({
          client_id:     config.clientId,
          client_secret: config.clientSecret,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token } = tokenRes.data;

      // Fetch user info
      const [userRes, guildsRes] = await Promise.all([
        axios.get(`${DISCORD_API}/users/@me`,        { headers: { Authorization: `Bearer ${access_token}` } }),
        axios.get(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${access_token}` } }),
      ]);

      // Only show guilds where this bot is present AND user has Manage Guild
      const botGuildIds = new Set(client.guilds.cache.keys());
      const managedGuilds = (guildsRes.data as any[]).filter(g => {
        const hasManage = (BigInt(g.permissions) & 0x20n) === 0x20n || g.owner;
        return botGuildIds.has(g.id) && hasManage;
      });

      req.session.userId      = userRes.data.id;
      req.session.accessToken = access_token;
      req.session.user        = userRes.data;
      req.session.guilds      = managedGuilds;

      res.redirect('/dashboard');
    } catch (err) {
      console.error('[Auth] OAuth2 callback error:', err);
      res.redirect('/?error=auth_failed');
    }
  });

  // ── Logout ───────────────────────────────────────────────────────
  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // ── Session info (for frontend) ──────────────────────────────────
  router.get('/me', (req, res) => {
    if (!req.session.userId) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      user:   req.session.user,
      guilds: req.session.guilds,
    });
  });

  return router;
}
