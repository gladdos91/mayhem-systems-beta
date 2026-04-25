import {
  Client, GatewayIntentBits, Partials, Collection,
  REST, Routes, SlashCommandBuilder,
  GuildMember, GuildBan, Message, PartialMessage,
  VoiceState, GuildChannel, MessageReaction, PartialMessageReaction,
  User, PartialUser,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';

import { TempVoiceModule }     from './modules/tempvoice';
import { TicketsModule }       from './modules/tickets';
import { AutoModModule }       from './modules/automod';
import { AnnouncementsModule } from './modules/announcements';
import { WelcomeModule }       from './modules/welcome';
import { ReactionRolesModule } from './modules/reactionroles';
import { RulesModule }         from './modules/rules';
import { ServerLogsModule }    from './modules/serverlogs';

export interface MayhemCommand {
  data: SlashCommandBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
  execute: (interaction: any, db: DatabaseSync) => Promise<void>;
}

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, MayhemCommand>;
    db:       DatabaseSync;
  }
}

export async function createBot(db: DatabaseSync): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.GuildMember,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
  });

  client.commands = new Collection();
  client.db = db;

  const tempVoice     = new TempVoiceModule(client, db);
  const tickets       = new TicketsModule(client, db);
  const autoMod       = new AutoModModule(client, db);
  const announcements = new AnnouncementsModule(client, db);
  const welcome       = new WelcomeModule(client, db);
  const reactionRoles = new ReactionRolesModule(client, db);
  const rules         = new RulesModule(client, db);
  const serverLogs    = new ServerLogsModule(client, db);

  const allModules = [tempVoice, tickets, autoMod, announcements, welcome, reactionRoles, rules, serverLogs];

  for (const mod of allModules) {
    for (const cmd of mod.commands) {
      client.commands.set(cmd.data.name, cmd);
    }
  }

  client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user!.tag}`);
    await registerCommands(client);
    for (const mod of allModules) await mod.onReady?.();
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      try {
        await cmd.execute(interaction, db);
      } catch (err) {
        console.error(`Error in command ${interaction.commandName}:`, err);
        const msg = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
    } else if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
      for (const mod of allModules) await mod.onInteraction?.(interaction);
    }
  });

  client.on('voiceStateUpdate', (before: VoiceState, after: VoiceState) => {
    tempVoice.onVoiceStateUpdate(before, after);
    serverLogs.onVoiceStateUpdate(before, after);
  });

  client.on('messageCreate',  (msg) => { if (!msg.author.bot) autoMod.onMessageCreate(msg); });
  client.on('messageDelete',  (msg: Message | PartialMessage) => serverLogs.onMessageDelete(msg));
  client.on('messageUpdate',  (o: Message | PartialMessage, n: Message | PartialMessage) => serverLogs.onMessageEdit(o, n));

  client.on('guildMemberAdd', async (member: GuildMember) => {
    await welcome.onGuildMemberAdd(member);
    await serverLogs.onMemberJoin(member);
  });

  client.on('guildMemberRemove', async (member) => {
    try {
      const m = member.partial ? await member.fetch() : member;
      await serverLogs.onMemberLeave(m as GuildMember);
    } catch {}
  });

  client.on('guildMemberUpdate', (o, n) => serverLogs.onRoleChange(o as GuildMember, n));
  client.on('guildBanAdd',       (ban: GuildBan) => serverLogs.onMemberBan(ban));
  client.on('guildBanRemove',    (ban: GuildBan) => serverLogs.onMemberUnban(ban));

  client.on('messageReactionAdd',    (r: MessageReaction | PartialMessageReaction, u: User | PartialUser) => reactionRoles.onReactionAdd(r, u));
  client.on('messageReactionRemove', (r: MessageReaction | PartialMessageReaction, u: User | PartialUser) => reactionRoles.onReactionRemove(r, u));

  client.on('channelCreate', (ch) => { if ('guild' in ch) serverLogs.onChannelCreate(ch as GuildChannel); });
  client.on('channelDelete', (ch) => { if ('guild' in ch) serverLogs.onChannelDelete(ch as GuildChannel); });

  client.on('guildCreate', (guild) => {
    db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id, guild_name) VALUES (?, ?)').run(guild.id, guild.name);
    console.log(`Joined: ${guild.name} (${guild.id})`);
  });

  await client.login(config.discordToken);
  return client;
}

async function registerCommands(client: Client) {
  const commands = [...client.commands.values()].map(c => c.data.toJSON());
  const rest = new REST().setToken(config.discordToken);
  try {
    console.log(`📝 Registering ${commands.length} slash commands...`);
    await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
    console.log('✅ Slash commands registered globally');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}
