import { initDatabase } from './database';
import { createBot }    from './bot';
import { createServer } from './api/server';
import { config }       from './config';

async function main() {
  console.log('🚀 Starting Mayhem Systems Discord Control...');

  // 1. Initialize database
  const db = initDatabase();

  // 2. Start Discord bot
  const client = await createBot(db);

  // 3. Start web panel
  createServer(client, db, config.port);
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
