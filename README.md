# ⚡ Mayhem Systems Discord Control

A unified Discord bot with a full web panel — integrating **VoiceMaster** temp-voice, **OpenTicket** ticket system, announcements with image support, and auto-moderation.

---

## ✨ Features

| Module | Slash Commands | Web Panel |
|---|---|---|
| 📢 **Announcements** | `/announce send/edit/history` | ✅ Send, preview, delete |
| 🎫 **Tickets** | `/ticket panel/category/close/add...` | ✅ View, close, delete, transcripts |
| 🛡️ **AutoMod** | `/automod badwords/spam/links/caps...` | ✅ Full config, warnings log |
| 🎙️ **Temp Voice** | `/voice setup/lock/unlock/name/limit...` | ✅ Config + active channel monitor |

---

## 🚀 Setup

### Prerequisites
- Node.js 20+
- A Discord Application with bot token ([Discord Developer Portal](https://discord.com/developers/applications))

### 1. Clone & Install
```bash
git clone <your-repo>
cd mayhem-v2
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

Edit `.env`:
```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_app_client_id
CLIENT_SECRET=your_app_client_secret
PORT=3000
SESSION_SECRET=some_long_random_string
PANEL_URL=http://localhost:3000
DATABASE_PATH=./data/nexus.db
```

### 3. Discord Application Setup

In the [Developer Portal](https://discord.com/developers/applications):

1. **Bot tab** → Enable these Privileged Gateway Intents:
   - Server Members Intent
   - Message Content Intent

2. **OAuth2 tab** → Add Redirect URI:
   ```
   http://localhost:3000/auth/callback
   ```
   (Change to your public URL in production)

3. **Bot Permissions needed:**
   - Manage Channels
   - Manage Roles  
   - Moderate Members (Timeout)
   - Kick/Ban Members
   - Read/Send Messages
   - Manage Messages
   - Move Members (for voice)

### 4. Invite the Bot
Generate an invite URL with `bot` + `applications.commands` scopes and the permissions above.

### 5. Run
```bash
# Development (auto-restart on changes)
npm run watch

# Production
npm run build && npm start
```

The web panel will be available at `http://localhost:3000`

---

## 🎙️ Temp Voice Setup (Discord)

1. Invite the bot to your server
2. Run `/voice setup` with a hub voice channel and a category
3. Users who join the hub channel get their own private VC automatically

OR configure it from the **web panel → Temp Voice tab**.

---

## 🎫 Ticket Panel Setup (Discord)

1. Run `/ticket panel #channel` to create a panel
2. Copy the Panel ID from the reply
3. Run `/ticket category <panel_id> <label>` to add buttons
4. The panel embed updates automatically with buttons

---

## 🛡️ AutoMod Setup

Either use `/automod` slash commands in Discord, or configure everything visually from the **web panel → AutoMod tab**.

Available filters:
- **Bad Words** — custom word list with configurable actions
- **Spam** — message rate limiting with auto-mute
- **Links** — block all links or only Discord invites
- **Caps** — excessive capitalization detection
- **Mentions** — mention spam prevention

Actions available: `delete`, `warn`, `mute`, `kick`, `ban`

---

## 🌐 Web Panel

Access at `http://localhost:3000` (or your configured `PANEL_URL`).

**Login:** Click "Login with Discord" — only server admins (Manage Guild permission) can access the panel.

### Panel Pages
- **Overview** — Stats dashboard with member count, open tickets, active voice channels, automod actions today
- **Announcements** — Send rich embeds with image, thumbnail, color picker, role mentions
- **Tickets** — View/filter/close/delete tickets, download HTML transcripts
- **AutoMod** — Full tabbed config interface for all filters + warnings log
- **Temp Voice** — Configure JTC system + live view of active temp channels

---

## 📁 Project Structure

```
mayhem-v2/
├── src/
│   ├── index.ts              # Entry point
│   ├── bot.ts                # Discord client setup
│   ├── config.ts             # Env config
│   ├── database.ts           # SQLite schema + init
│   ├── modules/
│   │   ├── base.ts           # Abstract base module
│   │   ├── announcements/    # Announcements module
│   │   ├── tempvoice/        # Temp Voice (VoiceMaster port)
│   │   ├── tickets/          # Tickets (OpenTicket port)
│   │   └── automod/          # Auto-moderation module
│   ├── api/
│   │   ├── server.ts         # Express app
│   │   ├── middleware.ts     # Auth middleware
│   │   └── routes/           # REST API routes
│   └── utils/
│       └── nanoid.ts
├── public/                   # Web panel (SPA)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── data/                     # SQLite DB (auto-created)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🔒 Security Notes

- Only users with **Manage Guild** permission on a given server can control it via the panel
- Sessions are cookie-based — set `SESSION_SECRET` to a strong random value
- For production, put the panel behind HTTPS (nginx/Caddy reverse proxy)
- Change `PANEL_URL` to your public domain for OAuth2 callbacks to work
