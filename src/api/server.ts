import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import { Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config';

import { authRouter }          from './routes/auth';
import { guildsRouter }        from './routes/guilds';
import { announcementsRouter } from './routes/announcements';
import { ticketsRouter, setTicketsModule } from './routes/tickets';
import { automodRouter }       from './routes/automod';
import { tempvoiceRouter }     from './routes/tempvoice';
import { welcomeRouter }       from './routes/welcome';
import { reactionRolesRouter } from './routes/reactionroles';
import { rulesRouter }         from './routes/rules';
import { serverLogsRouter }    from './routes/serverlogs';
import { exportRouter }        from './routes/export';

declare module 'express-session' {
  interface SessionData {
    userId:      string;
    accessToken: string;
    guilds:      any[];
    user:        any;
  }
}

export function createServer(client: Client, db: DatabaseSync, port: number) {
  const app = express();

  app.use(cors({ origin: config.panelUrl, credentials: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret:            config.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
  }));

  // Static files (web panel)
  app.use(express.static(path.join(__dirname, '../../public')));

  // ─── API Routes ────────────────────────────────────────────────
  app.use('/auth',              authRouter(client, db));
  app.use('/api/guilds',        guildsRouter(client, db));
  app.use('/api/announce',      announcementsRouter(client, db));
  app.use('/api/tickets',       ticketsRouter(client, db));
  app.use('/api/automod',       automodRouter(client, db));
  app.use('/api/voice',         tempvoiceRouter(client, db));
  app.use('/api/welcome',       welcomeRouter(client, db));
  app.use('/api/reactionroles', reactionRolesRouter(client, db));
  app.use('/api/rules',         rulesRouter(client, db));
  app.use('/api/serverlogs',    serverLogsRouter(client, db));
  app.use('/api/export',        exportRouter(client, db));

  // ─── Route: landing page ─────────────────────────────────────
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  // ─── Route: auth callbacks ────────────────────────────────────
  // /auth/login and /auth/callback handled by authRouter above

  // ─── Route: dashboard SPA (all /dashboard routes) ────────────
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
  });
  app.get('/dashboard/*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
  });

  app.listen(port, () => {
    console.log(`🌐 Web panel running at http://localhost:${port}`);
  });

  return app;
}
