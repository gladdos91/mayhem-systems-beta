import { Client, Interaction } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { MayhemCommand } from '../bot';

export abstract class BaseModule {
  protected client: Client;
  protected db: DatabaseSync;
  abstract commands: MayhemCommand[];

  constructor(client: Client, db: DatabaseSync) {
    this.client = client;
    this.db = db;
  }

  async onReady?(): Promise<void>;
  async onInteraction?(interaction: Interaction): Promise<void>;
}
