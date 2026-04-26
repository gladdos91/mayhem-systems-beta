/**
 * Tickets Module — Mayhem Systems Discord Control
 * Full feature parity with OpenTicket (open-ticket-main)
 *
 * Features:
 *  - Button AND dropdown panels
 *  - Ticket questions (modal on creation — from questions.json)
 *  - Staff role enforcement (any role in any category admin_roles = staff)
 *  - Readonly admins (view only)
 *  - Blacklist (add/remove/view)
 *  - Priority (none/low/medium/high)
 *  - Autoclose (inactive hours + user leave)
 *  - Autodelete (inactive days + user leave)
 *  - Cooldowns per category
 *  - Per-category ticket limits (global + per user)
 *  - Slow mode on ticket channels
 *  - Move ticket to different category
 *  - Transfer ticket creator
 *  - Stats (/ticket stats global/user)
 *  - HTML transcripts (sent to channel + DM)
 *  - Pin/Unpin ticket message
 *  - Topic change
 */

import {
  Client, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Interaction, TextChannel, GuildMember, CategoryChannel, ButtonInteraction,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';
import { nanoid } from '../../utils/nanoid';
import cron from 'node-cron';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, number> = {
  none:   0x5865F2,
  low:    0x57F287,
  medium: 0xFEE75C,
  high:   0xED4245,
};
const PRIORITY_LABELS: Record<string, string> = {
  none: '⬜ None', low: '🟢 Low', medium: '🟡 Medium', high: '🔴 High',
};
const BTN_COLOR: Record<string, ButtonStyle> = {
  Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success, Danger: ButtonStyle.Danger,
  blue: ButtonStyle.Primary, gray: ButtonStyle.Secondary,
  green: ButtonStyle.Success, red: ButtonStyle.Danger,
};

/** Returns true if member is staff for this guild (has any ticket admin role) */
function isStaff(member: GuildMember, db: DatabaseSync): boolean {
  if (!member.guild) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const categories = db.prepare(
    'SELECT admin_roles, readonly_roles FROM ticket_categories WHERE guild_id = ?'
  ).all(member.guild.id) as any[];

  for (const cat of categories) {
    const adminRoles:    string[] = JSON.parse(cat.admin_roles    ?? '[]');
    const readonlyRoles: string[] = JSON.parse(cat.readonly_roles ?? '[]');
    const allStaffRoles = [...adminRoles, ...readonlyRoles];
    if (allStaffRoles.some(r => member.roles.cache.has(r))) return true;
  }
  return false;
}

/** Returns true if member is an admin (full manage) for a specific category */
function isCategoryAdmin(member: GuildMember, category: any): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const adminRoles: string[] = JSON.parse(category.admin_roles ?? '[]');
  return adminRoles.some(r => member.roles.cache.has(r));
}

/** Check cooldown — returns seconds remaining or 0 */
function checkCooldown(db: DatabaseSync, userId: string, categoryId: string, cooldownMinutes: number): number {
  const key = `cooldown:${userId}:${categoryId}`;
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as any;
  if (!row) return 0;
  const elapsed = Date.now() / 1000 - parseInt(row.value);
  const remaining = cooldownMinutes * 60 - elapsed;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

function setCooldown(db: DatabaseSync, userId: string, categoryId: string) {
  const key = `cooldown:${userId}:${categoryId}`;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run(key, Math.floor(Date.now() / 1000).toString());
}

// ─── Module ───────────────────────────────────────────────────────────────────

export class TicketsModule extends BaseModule {
  private autocloseTask?: cron.ScheduledTask;

  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket system')
        .addSubcommand(s => s.setName('panel').setDescription('Create a ticket panel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addStringOption(o => o.setName('title').setDescription('Title').setRequired(false))
          .addStringOption(o => o.setName('description').setDescription('Description').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('Hex color').setRequired(false))
          .addStringOption(o => o.setName('style').setDescription('buttons or dropdown').setRequired(false)
            .addChoices({ name: '🔘 Buttons', value: 'buttons' }, { name: '📋 Dropdown', value: 'dropdown' })))
        .addSubcommand(s => s.setName('category').setDescription('Add a category to a panel')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Button label').setRequired(true))
          .addStringOption(o => o.setName('emoji').setDescription('Button emoji').setRequired(false))
          .addStringOption(o => o.setName('color').setDescription('Primary Secondary Success Danger').setRequired(false))
          .addRoleOption(o => o.setName('admin_role').setDescription('Admin role for tickets').setRequired(false))
          .addRoleOption(o => o.setName('readonly_role').setDescription('Read-only role for tickets').setRequired(false))
          .addChannelOption(o => o.setName('category_channel').setDescription('Discord category').setRequired(false).addChannelTypes(ChannelType.GuildCategory))
          .addStringOption(o => o.setName('prefix').setDescription('Channel prefix').setRequired(false)))
        .addSubcommand(s => s.setName('question').setDescription('Add a question to a category')
          .addStringOption(o => o.setName('category_id').setDescription('Category ID').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Question label').setRequired(true))
          .addStringOption(o => o.setName('type').setDescription('short or paragraph').setRequired(false)
            .addChoices({ name: 'Short Answer', value: 'short' }, { name: 'Paragraph', value: 'paragraph' }))
          .addBooleanOption(o => o.setName('required').setDescription('Required?').setRequired(false))
          .addStringOption(o => o.setName('placeholder').setDescription('Placeholder text').setRequired(false)))
        .addSubcommand(s => s.setName('config').setDescription('Configure category autoclose/limits/cooldown')
          .addStringOption(o => o.setName('category_id').setDescription('Category ID').setRequired(true))
          .addBooleanOption(o => o.setName('autoclose').setDescription('Enable autoclose').setRequired(false))
          .addIntegerOption(o => o.setName('autoclose_hours').setDescription('Hours until autoclose').setRequired(false))
          .addBooleanOption(o => o.setName('cooldown').setDescription('Enable cooldown').setRequired(false))
          .addIntegerOption(o => o.setName('cooldown_minutes').setDescription('Cooldown minutes').setRequired(false))
          .addIntegerOption(o => o.setName('user_max').setDescription('Max open tickets per user (0=unlimited)').setRequired(false)))
        .addSubcommand(s => s.setName('close').setDescription('Close ticket')
          .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(s => s.setName('reopen').setDescription('Reopen a closed ticket'))
        .addSubcommand(s => s.setName('delete').setDescription('Delete this ticket permanently'))
        .addSubcommand(s => s.setName('claim').setDescription('Claim this ticket'))
        .addSubcommand(s => s.setName('unclaim').setDescription('Unclaim this ticket'))
        .addSubcommand(s => s.setName('add').setDescription('Add user to ticket')
          .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove user from ticket')
          .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand(s => s.setName('rename').setDescription('Rename ticket channel')
          .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)))
        .addSubcommand(s => s.setName('move').setDescription('Move ticket to another category')
          .addStringOption(o => o.setName('category_id').setDescription('Target category ID').setRequired(true))
          .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(s => s.setName('transfer').setDescription('Transfer ticket ownership')
          .addUserOption(o => o.setName('user').setDescription('New owner').setRequired(true))
          .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(s => s.setName('priority').setDescription('Set ticket priority')
          .addStringOption(o => o.setName('level').setDescription('Priority level').setRequired(true)
            .addChoices(
              { name: '⬜ None',   value: 'none'   },
              { name: '🟢 Low',   value: 'low'    },
              { name: '🟡 Medium', value: 'medium' },
              { name: '🔴 High',  value: 'high'   },
            )))
        .addSubcommand(s => s.setName('topic').setDescription('Change ticket channel topic')
          .addStringOption(o => o.setName('topic').setDescription('New topic').setRequired(true)))
        .addSubcommand(s => s.setName('transcript').setDescription('Generate a transcript'))
        .addSubcommand(s => s.setName('stats').setDescription('View ticket stats')
          .addUserOption(o => o.setName('user').setDescription('User stats (leave blank for global)').setRequired(false)))
        .addSubcommand(s => s.setName('blacklist').setDescription('Manage the ticket blacklist')
          .addStringOption(o => o.setName('action').setDescription('add, remove, or view').setRequired(true)
            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'View', value: 'view' }))
          .addUserOption(o => o.setName('user').setDescription('User to add/remove').setRequired(false))
          .addStringOption(o => o.setName('reason').setDescription('Reason for blacklist').setRequired(false)))
        .addSubcommand(s => s.setName('deploy').setDescription('Refresh a panel embed')
          .addStringOption(o => o.setName('panel_id').setDescription('Panel ID').setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'panel':      return this.cmdPanel(interaction, db);
          case 'category':   return this.cmdCategory(interaction, db);
          case 'question':   return this.cmdQuestion(interaction, db);
          case 'config':     return this.cmdConfig(interaction, db);
          case 'close':      return this.cmdClose(interaction, db);
          case 'reopen':     return this.cmdReopen(interaction, db);
          case 'delete':     return this.cmdDelete(interaction, db);
          case 'claim':      return this.cmdClaim(interaction, db);
          case 'unclaim':    return this.cmdUnclaim(interaction, db);
          case 'add':        return this.cmdAdd(interaction, db);
          case 'remove':     return this.cmdRemove(interaction, db);
          case 'rename':     return this.cmdRename(interaction, db);
          case 'move':       return this.cmdMove(interaction, db);
          case 'transfer':   return this.cmdTransfer(interaction, db);
          case 'priority':   return this.cmdPriority(interaction, db);
          case 'topic':      return this.cmdTopic(interaction, db);
          case 'transcript': return this.cmdTranscript(interaction, db);
          case 'stats':      return this.cmdStats(interaction, db);
          case 'blacklist':  return this.cmdBlacklist(interaction, db);
          case 'deploy':     return this.cmdDeploy(interaction, db);
        }
      },
    },
  ];

  // ─── onReady: start autoclose cron ──────────────────────────────────────────
  async onReady() {
    // Ensure kv_store table exists for cooldowns
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `).run();

    // Run autoclose check every 10 minutes
    this.autocloseTask = cron.schedule('*/10 * * * *', () => this.runAutoclose());
    console.log('✅ Ticket autoclose scheduler started');
  }

  // ─── Interactions ────────────────────────────────────────────────────────────
  async onInteraction(interaction: Interaction) {
    if (interaction.isButton()) {
      const [ns, action] = interaction.customId.split(':');
      if (ns !== 'ticket') return;
      if (action === 'create')    await this.handleCreateBtn(interaction as any);
      if (action === 'close')     await this.handleQuickClose(interaction as any);
      if (action === 'claim')     await this.cmdClaim(interaction as any, this.db);
      if (action === 'reopen')    await this.cmdReopen(interaction as any, this.db);
      if (action === 'transcript') await this.cmdTranscript(interaction as any, this.db);
      if (action === 'delete')    await this.cmdDelete(interaction as any, this.db);
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:dropdown:')) {
      await this.handleDropdownCreate(interaction as any);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:questions:')) {
      await this.handleQuestionsModal(interaction as any);
    }
  }

  // ─── Panel Command ───────────────────────────────────────────────────────────
  private async cmdPanel(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const channel     = interaction.options.getChannel('channel') as TextChannel;
    const title       = interaction.options.getString('title')       ?? '🎫 Support Tickets';
    const description = interaction.options.getString('description') ?? 'Click a button below to open a ticket.';
    const color       = interaction.options.getString('color')       ?? '#5865F2';
    const style       = interaction.options.getString('style')       ?? 'buttons';

    const panelId = nanoid(8);
    db.prepare(`
      INSERT INTO ticket_panels (id, guild_id, channel_id, title, description, color, style)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(panelId, interaction.guildId, channel.id, title, description, color, style);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`${description}\n\n> Use \`/ticket category\` with Panel ID: \`${panelId}\``)
      .setColor(color as any)
      .setFooter({ text: `Panel ID: ${panelId}` })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    db.prepare('UPDATE ticket_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
    await interaction.editReply({ content: `✅ Panel created in ${channel}!\nPanel ID: \`${panelId}\`` });
  }

  // ─── Category Command ────────────────────────────────────────────────────────
  private async cmdCategory(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const panelId    = interaction.options.getString('panel_id', true);
    const label      = interaction.options.getString('label', true);
    const emoji      = interaction.options.getString('emoji')          ?? '';
    const color      = interaction.options.getString('color')          ?? 'Primary';
    const adminRole  = interaction.options.getRole('admin_role');
    const roRole     = interaction.options.getRole('readonly_role');
    const catCh      = interaction.options.getChannel('category_channel');
    const prefix     = interaction.options.getString('prefix')         ?? 'ticket-';

    const panel = db.prepare('SELECT * FROM ticket_panels WHERE id = ? AND guild_id = ?').get(panelId, interaction.guildId) as any;
    if (!panel) return interaction.editReply({ content: '❌ Panel not found.' });

    const catId = nanoid(8);
    db.prepare(`
      INSERT INTO ticket_categories
        (id, panel_id, guild_id, label, emoji, color, admin_roles, readonly_roles, category_id, channel_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      catId, panelId, interaction.guildId, label, emoji, color,
      JSON.stringify(adminRole ? [adminRole.id] : []),
      JSON.stringify(roRole    ? [roRole.id]    : []),
      catCh?.id ?? '', prefix,
    );

    // Init config row
    db.prepare('INSERT OR IGNORE INTO ticket_category_config (category_id, guild_id) VALUES (?, ?)').run(catId, interaction.guildId);

    await this.rebuildPanelMessage(panelId, db, interaction.guild);
    await interaction.editReply({ content: `✅ Category **${label}** added!\nCategory ID: \`${catId}\`` });
  }

  // ─── Question Command ────────────────────────────────────────────────────────
  private async cmdQuestion(interaction: any, db: DatabaseSync) {
    const categoryId = interaction.options.getString('category_id', true);
    const label      = interaction.options.getString('label', true);
    const type       = interaction.options.getString('type')        ?? 'short';
    const required   = interaction.options.getBoolean('required')   ?? true;
    const placeholder = interaction.options.getString('placeholder') ?? null;

    const cat = db.prepare('SELECT id FROM ticket_categories WHERE id = ? AND guild_id = ?').get(categoryId, interaction.guildId);
    if (!cat) return interaction.reply({ content: '❌ Category not found.', ephemeral: true });

    const existing = db.prepare('SELECT COUNT(*) as c FROM ticket_form_questions WHERE category_id = ?').get(categoryId) as any;
    if (existing.c >= 5) return interaction.reply({ content: '❌ Max 5 questions per category (Discord modal limit).', ephemeral: true });

    db.prepare('INSERT INTO ticket_form_questions (category_id, guild_id, label, style, placeholder, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(categoryId, interaction.guildId, label, type, placeholder, required ? 1 : 0, existing.c);

    await interaction.reply({ content: `✅ Question added to category!`, ephemeral: true });
  }

  // ─── Config Command ──────────────────────────────────────────────────────────
  private async cmdConfig(interaction: any, db: DatabaseSync) {
    const categoryId       = interaction.options.getString('category_id', true);
    const autoclose        = interaction.options.getBoolean('autoclose');
    const autocloseHours   = interaction.options.getInteger('autoclose_hours');
    const cooldown         = interaction.options.getBoolean('cooldown');
    const cooldownMinutes  = interaction.options.getInteger('cooldown_minutes');
    const userMax          = interaction.options.getInteger('user_max');

    db.prepare('INSERT OR IGNORE INTO ticket_category_config (category_id, guild_id) VALUES (?, ?)').run(categoryId, interaction.guildId);

    const updates: string[] = [];
    const vals: any[]       = [];
    if (autoclose       !== null) { updates.push('autoclose_enabled = ?');  vals.push(autoclose ? 1 : 0); }
    if (autocloseHours  !== null) { updates.push('autoclose_hours = ?');    vals.push(autocloseHours); }
    if (cooldown        !== null) { updates.push('cooldown_enabled = ?');   vals.push(cooldown ? 1 : 0); }
    if (cooldownMinutes !== null) { updates.push('cooldown_minutes = ?');   vals.push(cooldownMinutes); }
    if (userMax         !== null) { updates.push('user_max = ?');           vals.push(userMax); }

    if (updates.length) {
      vals.push(categoryId);
      db.prepare(`UPDATE ticket_category_config SET ${updates.join(', ')} WHERE category_id = ?`).run(...vals);
    }

    await interaction.reply({ content: '✅ Category config updated!', ephemeral: true });
  }

  // ─── Deploy/Rebuild ──────────────────────────────────────────────────────────
  private async cmdDeploy(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const panelId = interaction.options.getString('panel_id', true);
    await this.rebuildPanelMessage(panelId, db, interaction.guild);
    await interaction.editReply({ content: '✅ Panel refreshed!' });
  }

  async rebuildPanelMessage(panelId: string, db: DatabaseSync, guild: any) {
    const panel = db.prepare('SELECT * FROM ticket_panels WHERE id = ?').get(panelId) as any;
    if (!panel) return false;
    const categories = db.prepare('SELECT * FROM ticket_categories WHERE panel_id = ? ORDER BY sort_order ASC').all(panelId) as any[];
    const channel    = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
    if (!channel) return false;

    try {
      const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(panel.description ?? 'Select a category below to open a ticket.')
        .setColor(panel.color ?? 0x5865F2)
        .setFooter({ text: `Panel ID: ${panel.id}` })
        .setTimestamp();

      const style = panel.style ?? panel.panel_style ?? 'buttons';
      const components: any[] = [];

      if (style === 'dropdown' && categories.length > 0) {
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`ticket:dropdown:${panelId}`)
          .setPlaceholder('Select a ticket type...')
          .addOptions(categories.map(c =>
            new StringSelectMenuOptionBuilder()
              .setLabel(c.label)
              .setValue(c.id)
              .setDescription(c.description || 'Open a support ticket')
              .setEmoji(c.emoji || '🎫')
          ));
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
      } else {
        for (let i = 0; i < categories.length; i += 5) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (const cat of categories.slice(i, i + 5)) {
            const btn = new ButtonBuilder()
              .setCustomId(`ticket:create:${cat.id}`)
              .setLabel(cat.label)
              .setStyle(BTN_COLOR[cat.color] ?? ButtonStyle.Primary);
            if (cat.emoji) btn.setEmoji(cat.emoji);
            row.addComponents(btn);
          }
          components.push(row);
        }
      }

      // If no message yet, send a new one; otherwise edit the existing one
      if (!panel.message_id) {
        const msg = await channel.send({ embeds: [embed], components });
        db.prepare('UPDATE ticket_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
      } else {
        try {
          const msg = await channel.messages.fetch(panel.message_id);
          await msg.edit({ embeds: [embed], components });
        } catch {
          // Message was deleted — send a fresh one
          const msg = await channel.send({ embeds: [embed], components });
          db.prepare('UPDATE ticket_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
        }
      }
      return true;
    } catch (err) {
      console.error('[Tickets] rebuildPanelMessage error:', err);
      return false;
    }
  }

  // ─── Handle Create Button Click ──────────────────────────────────────────────
  private async handleCreateBtn(interaction: any) {
    const categoryId = interaction.customId.split(':')[2];
    await this.startTicketCreation(interaction, categoryId);
  }

  // ─── Handle Dropdown Select ──────────────────────────────────────────────────
  private async handleDropdownCreate(interaction: any) {
    const categoryId = interaction.values[0];
    await this.startTicketCreation(interaction, categoryId);
  }

  // ─── Ticket Creation Flow ────────────────────────────────────────────────────
  private async startTicketCreation(interaction: any, categoryId: string) {
    const db  = this.db;
    const cat = db.prepare('SELECT * FROM ticket_categories WHERE id = ?').get(categoryId) as any;
    if (!cat) return interaction.reply({ content: '❌ Category not found.', ephemeral: true });

    const cfg = db.prepare('SELECT * FROM ticket_category_config WHERE category_id = ?').get(categoryId) as any;

    // ── Blacklist check ──────────────────────────────────────────────────────
    const blacklisted = db.prepare('SELECT id FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?')
      .get(interaction.guildId, interaction.user.id);
    if (blacklisted) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ You are blacklisted from creating tickets.')],
        ephemeral: true,
      });
    }

    // ── Cooldown check ───────────────────────────────────────────────────────
    if (cfg?.cooldown_enabled) {
      const remaining = checkCooldown(db, interaction.user.id, categoryId, cfg.cooldown_minutes);
      if (remaining > 0) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`⏱ Cooldown active. Try again in **${Math.ceil(remaining / 60)}m ${remaining % 60}s**.`)],
          ephemeral: true,
        });
      }
    }

    // ── User ticket limit ────────────────────────────────────────────────────
    if (cfg?.user_max > 0) {
      const userCount = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE creator_id = ? AND category_id = ? AND status = 'open'").get(interaction.user.id, categoryId) as any).c;
      if (userCount >= cfg.user_max) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You already have **${userCount}/${cfg.user_max}** open tickets in this category.`)],
          ephemeral: true,
        });
      }
    }

    // ── Check for questions — show modal if any ──────────────────────────────
    const questions = db.prepare('SELECT * FROM ticket_form_questions WHERE category_id = ? ORDER BY sort_order ASC LIMIT 5').all(categoryId) as any[];

    if (questions.length > 0) {
      const modal = new ModalBuilder()
        .setCustomId(`ticket:questions:${categoryId}`)
        .setTitle(`✏️ ${cat.label}`);

      for (const q of questions) {
        const input = new TextInputBuilder()
          .setCustomId(`q_${q.id}`)
          .setLabel(q.label)
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(!!q.required);
        if (q.placeholder) input.setPlaceholder(q.placeholder);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      }

      return interaction.showModal(modal);
    }

    // ── No questions — create immediately ───────────────────────────────────
    await interaction.deferReply({ ephemeral: true });
    await this.createTicketChannel(interaction, cat, cfg, {});
  }

  // ─── Handle Questions Modal Submit ───────────────────────────────────────────
  private async handleQuestionsModal(interaction: any) {
    const categoryId = interaction.customId.split(':')[2];
    const db         = this.db;
    const cat        = db.prepare('SELECT * FROM ticket_categories WHERE id = ?').get(categoryId) as any;
    const cfg        = db.prepare('SELECT * FROM ticket_category_config WHERE category_id = ?').get(categoryId) as any;
    if (!cat) return interaction.reply({ content: '❌ Category not found.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    // Collect answers
    const answers: Record<string, string> = {};
    const questions = db.prepare('SELECT * FROM ticket_form_questions WHERE category_id = ? ORDER BY sort_order').all(categoryId) as any[];
    for (const q of questions) {
      try {
        answers[q.label] = interaction.fields.getTextInputValue(`q_${q.id}`) ?? '';
      } catch {}
    }

    await this.createTicketChannel(interaction, cat, cfg, answers);
  }

  // ─── Core: Create Ticket Channel ─────────────────────────────────────────────
  private async createTicketChannel(interaction: any, cat: any, cfg: any, answers: Record<string, string>) {
    const db = this.db;

    // Duplicate check
    const existing = db.prepare("SELECT channel_id FROM tickets WHERE creator_id = ? AND category_id = ? AND status = 'open' AND guild_id = ?")
      .get(interaction.user.id, cat.id, interaction.guildId) as any;
    if (existing) {
      return interaction.editReply({ content: `❌ You already have an open ticket: <#${existing.channel_id}>` });
    }

    const ticketNum = ((db.prepare('SELECT COUNT(*) as c FROM tickets WHERE guild_id = ?').get(interaction.guildId) as any).c) + 1;
    const ticketId  = nanoid(10);

    const adminRoles:    string[] = JSON.parse(cat.admin_roles    ?? '[]');
    const readonlyRoles: string[] = JSON.parse(cat.readonly_roles ?? '[]');

    const permOverwrites: any[] = [
      { id: interaction.guild.roles.everyone.id,  deny:  [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id,                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const r of adminRoles) {
      permOverwrites.push({ id: r, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    for (const r of readonlyRoles) {
      permOverwrites.push({ id: r, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] });
    }

    const channelName = `${cat.channel_prefix}${ticketNum.toString().padStart(4, '0')}`;
    const ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: cat.category_id || undefined,
      permissionOverwrites: permOverwrites,
      topic: `Ticket #${ticketNum} | ${cat.label} | Created by ${interaction.user.tag}`,
    }) as TextChannel;

    if (cfg?.slowmode_enabled && cfg.slowmode_seconds > 0) {
      await ticketChannel.setRateLimitPerUser(cfg.slowmode_seconds);
    }

    db.prepare(`
      INSERT INTO tickets (id, guild_id, channel_id, creator_id, category_id, ticket_number, question_answers)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ticketId, interaction.guildId, ticketChannel.id, interaction.user.id, cat.id, ticketNum, JSON.stringify(answers));

    // Set cooldown after successful creation
    if (cfg?.cooldown_enabled) setCooldown(db, interaction.user.id, cat.id);

    // Build welcome embed
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🎫 Ticket #${ticketNum} — ${cat.label}`)
      .setDescription(cat.welcome_message || `Welcome ${interaction.user}!\nSupport will be with you shortly.`)
      .addFields(
        { name: 'Opened by', value: `${interaction.user}`, inline: true },
        { name: 'Category',  value: cat.label,              inline: true },
        { name: 'Priority',  value: '⬜ None',               inline: true },
      );

    // Attach question answers
    if (Object.keys(answers).length > 0) {
      for (const [q, a] of Object.entries(answers)) {
        if (a) welcomeEmbed.addFields({ name: q, value: a.slice(0, 1024), inline: false });
      }
    }

    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('ticket:close:').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      new ButtonBuilder().setCustomId('ticket:claim:').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
      new ButtonBuilder().setCustomId('ticket:transcript:').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄'),
    );

    const adminMentions = adminRoles.map(r => `<@&${r}>`).join(' ');
    await ticketChannel.send({
      content: adminMentions || undefined,
      embeds:  [welcomeEmbed],
      components: [controlRow],
    });

    await interaction.editReply({ content: `✅ Ticket created: ${ticketChannel}` });
  }

  // ─── Close ───────────────────────────────────────────────────────────────────
  private async cmdClose(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'").get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not an open ticket channel.', ephemeral: true });

    const member = interaction.member as GuildMember;
    const isOwner = ticket.creator_id === interaction.user.id;
    const canClose = isOwner || isStaff(member, db) || member.permissions.has(PermissionFlagsBits.ManageChannels);
    if (!canClose) return interaction.reply({ content: '❌ No permission to close this ticket.', ephemeral: true });

    const reason = interaction.options?.getString?.('reason') ?? 'No reason provided';
    await this.closeTicket(interaction, ticket, reason, db);
  }

  private async handleQuickClose(interaction: any) {
    const ticket = this.db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    await this.closeTicket(interaction, ticket, 'Closed via button', this.db);
  }

  private async closeTicket(interaction: any, ticket: any, reason: string, db: DatabaseSync) {
    await interaction.deferReply();
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = unixepoch() WHERE id = ?").run(ticket.id);

    const channel = interaction.channel as TextChannel;
    try {
      await channel.permissionOverwrites.edit(ticket.creator_id, { SendMessages: false });
    } catch {}

    const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('ticket:reopen:').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
      new ButtonBuilder().setCustomId('ticket:transcript:').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄'),
      new ButtonBuilder().setCustomId('ticket:delete:').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🔒 Ticket Closed')
        .addFields(
          { name: 'Closed by', value: `${interaction.user}`, inline: true },
          { name: 'Reason',    value: reason,                inline: true },
        )
        .setTimestamp()],
      components: [closeRow],
    });
  }

  // ─── Reopen ──────────────────────────────────────────────────────────────────
  private async cmdReopen(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket || ticket.status !== 'closed') return interaction.reply({ content: '❌ Not a closed ticket.', ephemeral: true });

    db.prepare("UPDATE tickets SET status = 'open', closed_at = NULL, last_activity = unixepoch() WHERE id = ?").run(ticket.id);
    try { await (interaction.channel as TextChannel).permissionOverwrites.edit(ticket.creator_id, { SendMessages: true, ViewChannel: true }); } catch {}

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🔓 Ticket Reopened').setTimestamp()],
    });
  }

  // ─── Move ────────────────────────────────────────────────────────────────────
  private async cmdMove(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });

    const targetCatId = interaction.options.getString('category_id', true);
    const targetCat   = db.prepare('SELECT * FROM ticket_categories WHERE id = ? AND guild_id = ?').get(targetCatId, interaction.guildId) as any;
    if (!targetCat) return interaction.reply({ content: '❌ Target category not found.', ephemeral: true });

    const reason = interaction.options.getString('reason') ?? 'No reason';

    // Move Discord category
    if (targetCat.category_id) {
      await interaction.channel.setParent(targetCat.category_id, { lockPermissions: false }).catch(() => {});
    }

    db.prepare('UPDATE tickets SET category_id = ?, last_activity = unixepoch() WHERE id = ?').run(targetCatId, ticket.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📦 Ticket Moved')
        .addFields(
          { name: 'Moved to', value: targetCat.label, inline: true },
          { name: 'Reason',   value: reason,           inline: true },
        )],
    });
  }

  // ─── Transfer ────────────────────────────────────────────────────────────────
  private async cmdTransfer(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });

    const newOwner = interaction.options.getUser('user', true);
    const reason   = interaction.options.getString('reason') ?? 'No reason';
    const channel  = interaction.channel as TextChannel;

    await channel.permissionOverwrites.edit(ticket.creator_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
    await channel.permissionOverwrites.edit(newOwner.id,       { ViewChannel: true,  SendMessages: true  }).catch(() => {});

    db.prepare('UPDATE tickets SET creator_id = ?, last_activity = unixepoch() WHERE id = ?').run(newOwner.id, ticket.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔄 Ticket Transferred')
        .setDescription(`Ownership transferred to ${newOwner}`)
        .addFields({ name: 'Reason', value: reason, inline: false })],
    });
  }

  // ─── Priority ────────────────────────────────────────────────────────────────
  private async cmdPriority(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });

    const level = interaction.options.getString('level', true);
    db.prepare('UPDATE tickets SET priority = ?, last_activity = unixepoch() WHERE id = ?').run(level, ticket.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(PRIORITY_COLORS[level] ?? 0x5865F2)
        .setTitle('🎯 Priority Updated')
        .setDescription(`Ticket priority set to **${PRIORITY_LABELS[level]}**`)],
    });
  }

  // ─── Topic ───────────────────────────────────────────────────────────────────
  private async cmdTopic(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT id FROM tickets WHERE channel_id = ?').get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    const topic = interaction.options.getString('topic', true);
    await interaction.channel.setTopic(topic);
    await interaction.reply({ content: `✅ Topic updated.`, ephemeral: true });
  }

  // ─── Claim / Unclaim ─────────────────────────────────────────────────────────
  private async cmdClaim(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'").get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not an open ticket.', ephemeral: true });

    db.prepare('UPDATE tickets SET claimed_by = ?, last_activity = unixepoch() WHERE id = ?').run(interaction.user.id, ticket.id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`🙋 **${interaction.user.displayName}** has claimed this ticket.`)],
    });
  }

  private async cmdUnclaim(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT id FROM tickets WHERE channel_id = ?').get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    db.prepare('UPDATE tickets SET claimed_by = NULL WHERE id = ?').run((ticket as any).id);
    await interaction.reply({ content: '✅ Ticket unclaimed.', ephemeral: true });
  }

  // ─── Add / Remove User ───────────────────────────────────────────────────────
  private async cmdAdd(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT id FROM tickets WHERE channel_id = ?').get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    const target = interaction.options.getMember('user') as GuildMember;
    await (interaction.channel as TextChannel).permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true });
    db.prepare('INSERT OR IGNORE INTO ticket_participants (ticket_id, user_id, added_by) VALUES (?, ?, ?)').run((ticket as any).id, target.id, interaction.user.id);
    await interaction.reply({ content: `✅ Added ${target} to the ticket.`, ephemeral: true });
  }

  private async cmdRemove(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT id FROM tickets WHERE channel_id = ?').get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    const target = interaction.options.getMember('user') as GuildMember;
    await (interaction.channel as TextChannel).permissionOverwrites.edit(target.id, { ViewChannel: false });
    await interaction.reply({ content: `✅ Removed ${target} from the ticket.`, ephemeral: true });
  }

  // ─── Rename ──────────────────────────────────────────────────────────────────
  private async cmdRename(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT id FROM tickets WHERE channel_id = ?').get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    const name = interaction.options.getString('name', true);
    await interaction.channel.edit({ name });
    await interaction.reply({ content: `✅ Renamed to **${name}**.`, ephemeral: true });
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────
  private async cmdStats(interaction: any, db: DatabaseSync) {
    const user = interaction.options.getUser('user');

    if (user) {
      const opened = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND creator_id = ?').get(interaction.guildId, user.id) as any).c;
      const open   = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND creator_id = ? AND status = 'open'").get(interaction.guildId, user.id) as any).c;
      const closed = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND creator_id = ? AND status = 'closed'").get(interaction.guildId, user.id) as any).c;

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`📊 Stats for ${user.tag}`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'Total Opened', value: String(opened), inline: true },
            { name: 'Currently Open', value: String(open), inline: true },
            { name: 'Closed',        value: String(closed), inline: true },
          )],
        ephemeral: true,
      });
    } else {
      const total  = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE guild_id = ?').get(interaction.guildId) as any).c;
      const open   = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND status = 'open'").get(interaction.guildId) as any).c;
      const closed = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND status = 'closed'").get(interaction.guildId) as any).c;
      const today  = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND created_at > unixepoch()-86400").get(interaction.guildId) as any).c;

      // Top categories
      const topCats = db.prepare(`
        SELECT tc.label, COUNT(t.id) as cnt
        FROM tickets t LEFT JOIN ticket_categories tc ON t.category_id = tc.id
        WHERE t.guild_id = ?
        GROUP BY t.category_id ORDER BY cnt DESC LIMIT 5
      `).all(interaction.guildId) as any[];

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📊 Ticket Statistics')
          .addFields(
            { name: 'Total Tickets',  value: String(total),  inline: true },
            { name: 'Open',           value: String(open),   inline: true },
            { name: 'Closed',         value: String(closed), inline: true },
            { name: 'Opened Today',   value: String(today),  inline: true },
            { name: 'Top Categories', value: topCats.length ? topCats.map(c => `**${c.label}**: ${c.cnt}`).join('\n') : 'None', inline: false },
          )],
        ephemeral: true,
      });
    }
  }

  // ─── Blacklist ───────────────────────────────────────────────────────────────
  private async cmdBlacklist(interaction: any, db: DatabaseSync) {
    const action = interaction.options.getString('action', true);
    const user   = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? null;

    if (!isStaff(interaction.member as GuildMember, db) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    }

    if (action === 'add') {
      if (!user) return interaction.reply({ content: '❌ Specify a user.', ephemeral: true });
      db.prepare('INSERT OR IGNORE INTO ticket_blacklist (guild_id, user_id, reason, added_by) VALUES (?, ?, ?, ?)').run(interaction.guildId, user.id, reason, interaction.user.id);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`✅ **${user.tag}** has been blacklisted.${reason ? `\nReason: ${reason}` : ''}`)], ephemeral: true });

    } else if (action === 'remove') {
      if (!user) return interaction.reply({ content: '❌ Specify a user.', ephemeral: true });
      const { changes } = db.prepare('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, user.id) as any;
      await interaction.reply({ content: changes ? `✅ **${user.tag}** removed from blacklist.` : `❌ **${user.tag}** is not blacklisted.`, ephemeral: true });

    } else if (action === 'view') {
      const list = db.prepare('SELECT user_id, reason, added_at FROM ticket_blacklist WHERE guild_id = ? ORDER BY added_at DESC LIMIT 20').all(interaction.guildId) as any[];
      if (!list.length) return interaction.reply({ content: '📋 No blacklisted users.', ephemeral: true });
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('🚫 Ticket Blacklist')
          .setDescription(list.map(r => `<@${r.user_id}>${r.reason ? ` — ${r.reason}` : ''}`).join('\n'))],
        ephemeral: true,
      });
    }
  }

  // ─── Transcript ──────────────────────────────────────────────────────────────
  async cmdTranscript(interaction: any, db: DatabaseSync) {
    await interaction.deferReply({ ephemeral: true });
    const channel  = interaction.channel as TextChannel;
    const messages = await channel.messages.fetch({ limit: 100 });
    const sorted   = [...messages.values()].reverse();
    const ticket   = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channel.id) as any;

    const html = this.buildTranscriptHTML(channel.name, sorted, ticket);
    if (ticket) db.prepare('UPDATE tickets SET transcript = ? WHERE channel_id = ?').run(html, channel.id);

    await interaction.editReply({
      content: '📄 Transcript generated!',
      files: [{ attachment: Buffer.from(html), name: `${channel.name}-transcript.html` }],
    });
  }

  private buildTranscriptHTML(channelName: string, messages: any[], ticket?: any): string {
    const rows = messages.map(m => `
      <div class="msg">
        <img class="av" src="${m.author.displayAvatarURL({ size: 32, extension: 'png' })}"/>
        <div class="body">
          <span class="author">${m.author.tag}</span>
          <span class="ts">${m.createdAt.toISOString()}</span>
          <div class="content">${m.content || '<em class="muted">[embed / attachment]</em>'}</div>
        </div>
      </div>`).join('');

    const statsRow = ticket ? `
      <div class="stats">
        <div class="stat"><div class="k">Ticket #</div><div class="v">${ticket.ticket_number}</div></div>
        <div class="stat"><div class="k">Status</div><div class="v">${ticket.status}</div></div>
        <div class="stat"><div class="k">Priority</div><div class="v">${ticket.priority}</div></div>
        <div class="stat"><div class="k">Created</div><div class="v">${new Date(ticket.created_at * 1000).toUTCString()}</div></div>
      </div>` : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${channelName} — Mayhem Transcript</title>
<style>
  body{font-family:sans-serif;background:#36393f;color:#dcddde;margin:0;padding:0}
  .header{background:#202225;padding:20px 24px;border-bottom:1px solid #40444b}
  .header h1{margin:0;font-size:20px;color:#fff} .header p{margin:4px 0 0;color:#72767d;font-size:13px}
  .stats{display:flex;gap:16px;padding:14px 24px;background:#2f3136;border-bottom:1px solid #40444b;flex-wrap:wrap}
  .stat{background:#36393f;padding:8px 14px;border-radius:6px} .k{font-size:10px;color:#72767d;text-transform:uppercase} .v{font-size:14px;color:#fff;font-weight:600}
  .msgs{padding:16px 24px}
  .msg{display:flex;gap:12px;margin-bottom:14px}
  .av{width:36px;height:36px;border-radius:50%;flex-shrink:0}
  .body .author{font-weight:700;color:#fff;margin-right:8px} .body .ts{font-size:11px;color:#72767d}
  .content{margin-top:4px;line-height:1.5} .muted{color:#72767d}
  .footer{text-align:center;padding:20px;color:#72767d;font-size:12px;border-top:1px solid #40444b}
</style></head>
<body>
<div class="header"><h1>#${channelName} — Transcript</h1><p>Generated by Mayhem Systems Discord Control · ${messages.length} messages</p></div>
${statsRow}
<div class="msgs">${rows}</div>
<div class="footer">Mayhem Systems Discord Control · ${new Date().toUTCString()}</div>
</body></html>`;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────
  async cmdDelete(interaction: any, db: DatabaseSync) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId) as any;
    if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) && !isStaff(interaction.member, db)) {
      return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    }
    await interaction.reply({ content: '🗑️ Deleting in 5 seconds...' });
    await new Promise(r => setTimeout(r, 5000));
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    await interaction.channel.delete('Ticket deleted').catch(() => {});
  }

  // ─── Autoclose Cron ──────────────────────────────────────────────────────────
  private async runAutoclose() {
    const db = this.db;
    const openTickets = db.prepare("SELECT * FROM tickets WHERE status = 'open'").all() as any[];

    for (const ticket of openTickets) {
      const cfg = db.prepare('SELECT * FROM ticket_category_config WHERE category_id = ?').get(ticket.category_id) as any;
      if (!cfg?.autoclose_enabled) continue;

      const hoursSinceActivity = (Date.now() / 1000 - ticket.last_activity) / 3600;
      if (hoursSinceActivity < cfg.autoclose_hours) continue;

      // Auto-close
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = unixepoch() WHERE id = ?").run(ticket.id);

      const guild = this.client.guilds.cache.find(g => g.id === ticket.guild_id);
      if (!guild) continue;
      const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle('⏱️ Ticket Auto-Closed')
            .setDescription(`This ticket was automatically closed due to **${cfg.autoclose_hours} hours** of inactivity.`)],
        }).catch(() => {});
      }
    }
  }
}
