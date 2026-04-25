import {
  Client, VoiceState, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, EmbedBuilder,
  CategoryChannel, Interaction, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, GuildMember,
} from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { BaseModule } from '../base';
import { MayhemCommand } from '../../bot';

// Cooldown tracking (in-memory)
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 15_000;

export class TempVoiceModule extends BaseModule {
  commands: MayhemCommand[] = [
    {
      data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Manage your temporary voice channel')
        .addSubcommand(sub => sub
          .setName('setup')
          .setDescription('Set up the Join-to-Create system (Admin only)')
          .addChannelOption(opt => opt
            .setName('hub')
            .setDescription('The hub channel users join to create a VC')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice))
          .addChannelOption(opt => opt
            .setName('category')
            .setDescription('Category where temporary channels are created')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory))
          .addIntegerOption(opt => opt
            .setName('limit')
            .setDescription('Default user limit (0 = unlimited)')
            .setMinValue(0).setMaxValue(99)))
        .addSubcommand(sub => sub
          .setName('lock')
          .setDescription('Lock your voice channel'))
        .addSubcommand(sub => sub
          .setName('unlock')
          .setDescription('Unlock your voice channel'))
        .addSubcommand(sub => sub
          .setName('limit')
          .setDescription('Set the user limit of your channel')
          .addIntegerOption(opt => opt
            .setName('amount')
            .setDescription('0 = unlimited, 1–99 = limit')
            .setRequired(true).setMinValue(0).setMaxValue(99)))
        .addSubcommand(sub => sub
          .setName('name')
          .setDescription('Rename your channel')
          .addStringOption(opt => opt
            .setName('name')
            .setDescription('New channel name')
            .setRequired(true).setMaxLength(100)))
        .addSubcommand(sub => sub
          .setName('permit')
          .setDescription('Allow a user into your locked channel')
          .addUserOption(opt => opt
            .setName('user').setDescription('User to permit').setRequired(true)))
        .addSubcommand(sub => sub
          .setName('reject')
          .setDescription('Remove and block a user from your channel')
          .addUserOption(opt => opt
            .setName('user').setDescription('User to reject').setRequired(true)))
        .addSubcommand(sub => sub
          .setName('claim')
          .setDescription('Claim ownership of the channel (if owner left)'))
        .addSubcommand(sub => sub
          .setName('info')
          .setDescription('View info about your current voice channel')) as any,

      execute: async (interaction: any, db: DatabaseSync) => {
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'setup':  return this.cmdSetup(interaction, db);
          case 'lock':   return this.cmdLock(interaction, db);
          case 'unlock': return this.cmdUnlock(interaction, db);
          case 'limit':  return this.cmdLimit(interaction, db);
          case 'name':   return this.cmdName(interaction, db);
          case 'permit': return this.cmdPermit(interaction, db);
          case 'reject': return this.cmdReject(interaction, db);
          case 'claim':  return this.cmdClaim(interaction, db);
          case 'info':   return this.cmdInfo(interaction, db);
        }
      },
    },
  ];

  // ─── Voice State Update (core JTC logic) ──────────────────────────
  async onVoiceStateUpdate(before: VoiceState, after: VoiceState) {
    const member = after.member ?? before.member;
    if (!member) return;
    const guild = member.guild;

    const cfg = this.db.prepare(
      'SELECT hub_channel_id, category_id, default_limit FROM temp_voice_config WHERE guild_id = ?'
    ).get(guild.id) as any;
    if (!cfg) return;

    // ── User joined the hub channel ──────────────────────────────────
    if (after.channelId === cfg.hub_channel_id) {
      // Cooldown check
      const lastCreated = cooldowns.get(member.id);
      if (lastCreated && Date.now() - lastCreated < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastCreated)) / 1000);
        await member.send({
          embeds: [this.errEmbed(`You're on cooldown! Please wait **${remaining}s** before creating another channel.`)],
        }).catch(() => {});
        return;
      }

      // Get user's saved settings
      const userSettings = this.db.prepare(
        'SELECT channel_name, channel_limit FROM temp_voice_user_settings WHERE user_id = ?'
      ).get(member.id) as any;

      const name  = userSettings?.channel_name  ?? `${member.displayName}'s Channel`;
      const limit = userSettings?.channel_limit > 0 ? userSettings.channel_limit : cfg.default_limit;

      try {
        const category = guild.channels.cache.get(cfg.category_id) as CategoryChannel | undefined;
        const channel = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category ?? undefined,
          userLimit: limit,
          permissionOverwrites: [
            {
              id:   member.id,
              allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
            },
          ],
        });

        await member.voice.setChannel(channel);
        cooldowns.set(member.id, Date.now());

        this.db.prepare(
          'INSERT OR REPLACE INTO temp_voice_channels (channel_id, owner_id, guild_id) VALUES (?, ?, ?)'
        ).run(channel.id, member.id, guild.id);
      } catch (err) {
        console.error('[TempVoice] Failed to create channel:', err);
      }
    }

    // ── User left a temp channel — delete if empty ───────────────────
    if (before.channel) {
      const row = this.db.prepare(
        'SELECT owner_id FROM temp_voice_channels WHERE channel_id = ?'
      ).get(before.channel.id);

      if (row && before.channel.members.size === 0) {
        await before.channel.delete('Temporary voice channel empty').catch(() => {});
        this.db.prepare('DELETE FROM temp_voice_channels WHERE channel_id = ?').run(before.channel.id);
        cooldowns.delete((row as any).owner_id);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  private getOwnedChannel(db: DatabaseSync, userId: string) {
    return db.prepare(
      'SELECT channel_id FROM temp_voice_channels WHERE owner_id = ?'
    ).get(userId) as { channel_id: string } | undefined;
  }

  private errEmbed(msg: string) {
    return new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${msg}`);
  }

  private okEmbed(msg: string) {
    return new EmbedBuilder().setColor(0x57F287).setDescription(`✅ ${msg}`);
  }

  // ─── Commands ─────────────────────────────────────────────────────
  private async cmdSetup(interaction: any, db: DatabaseSync) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [this.errEmbed('You need Administrator permission.')], ephemeral: true });
    }
    const hub      = interaction.options.getChannel('hub');
    const category = interaction.options.getChannel('category');
    const limit    = interaction.options.getInteger('limit') ?? 0;

    db.prepare(`
      INSERT INTO temp_voice_config (guild_id, hub_channel_id, category_id, default_limit)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        hub_channel_id = excluded.hub_channel_id,
        category_id    = excluded.category_id,
        default_limit  = excluded.default_limit
    `).run(interaction.guildId, hub.id, category.id, limit);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🎙️ Temp Voice Setup Complete')
        .addFields(
          { name: 'Hub Channel', value: `<#${hub.id}>`, inline: true },
          { name: 'Category',    value: category.name,  inline: true },
          { name: 'Default Limit', value: limit === 0 ? 'Unlimited' : `${limit}`, inline: true },
        )
        .setDescription('Users who join the hub channel will get their own temporary voice channel!')],
      ephemeral: true,
    });
  }

  private async cmdLock(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: false });
    await interaction.reply({ embeds: [this.okEmbed('🔒 Voice channel **locked**.').setColor(0xFEE75C)] });
  }

  private async cmdUnlock(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: true });
    await interaction.reply({ embeds: [this.okEmbed('🔓 Voice channel **unlocked**.').setColor(0x57F287)] });
  }

  private async cmdLimit(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const amount  = interaction.options.getInteger('amount', true);
    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    await channel.edit({ userLimit: amount });

    db.prepare(`
      INSERT INTO temp_voice_user_settings (user_id, channel_limit)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET channel_limit = excluded.channel_limit
    `).run(interaction.user.id, amount);

    await interaction.reply({
      embeds: [this.okEmbed(`User limit set to **${amount === 0 ? 'Unlimited' : amount}**.`)],
    });
  }

  private async cmdName(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const name    = interaction.options.getString('name', true);
    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    await channel.edit({ name });

    db.prepare(`
      INSERT INTO temp_voice_user_settings (user_id, channel_name)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET channel_name = excluded.channel_name
    `).run(interaction.user.id, name);

    await interaction.reply({ embeds: [this.okEmbed(`Channel renamed to **${name}**.`)] });
  }

  private async cmdPermit(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const target  = interaction.options.getMember('user') as GuildMember;
    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    await channel.permissionOverwrites.edit(target, { Connect: true });
    await interaction.reply({ embeds: [this.okEmbed(`✅ Permitted ${target} to join your channel.`)] });
  }

  private async cmdReject(interaction: any, db: DatabaseSync) {
    const row = this.getOwnedChannel(db, interaction.user.id);
    if (!row) return interaction.reply({ embeds: [this.errEmbed("You don't own a temp voice channel.")], ephemeral: true });

    const target  = interaction.options.getMember('user') as GuildMember;
    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (!channel) return interaction.reply({ embeds: [this.errEmbed('Channel not found.')], ephemeral: true });

    if (target.voice.channelId === row.channel_id) {
      await target.voice.disconnect('Rejected from temp voice channel');
    }
    await channel.permissionOverwrites.edit(target, { Connect: false });
    await interaction.reply({ embeds: [this.okEmbed(`❌ Rejected ${target} from your channel.`)] });
  }

  private async cmdClaim(interaction: any, db: DatabaseSync) {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ embeds: [this.errEmbed("You're not in a voice channel.")], ephemeral: true });

    const row = db.prepare('SELECT owner_id FROM temp_voice_channels WHERE channel_id = ?').get(vc.id) as any;
    if (!row) return interaction.reply({ embeds: [this.errEmbed("That's not a temporary channel.")], ephemeral: true });

    // Check if owner is still in the channel
    const ownerInChannel = vc.members.has(row.owner_id);
    if (ownerInChannel) {
      return interaction.reply({ embeds: [this.errEmbed('The owner is still in the channel.')], ephemeral: true });
    }

    db.prepare('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?').run(interaction.user.id, vc.id);
    await vc.permissionOverwrites.edit(interaction.user.id, { Connect: true, ManageChannels: true });
    await interaction.reply({ embeds: [this.okEmbed('You are now the owner of this channel! 👑')] });
  }

  private async cmdInfo(interaction: any, db: DatabaseSync) {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ embeds: [this.errEmbed("You're not in a voice channel.")], ephemeral: true });

    const row = db.prepare('SELECT owner_id, created_at FROM temp_voice_channels WHERE channel_id = ?').get(vc.id) as any;
    if (!row) return interaction.reply({ embeds: [this.errEmbed("That's not a temporary channel.")], ephemeral: true });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🎙️ ${vc.name}`)
        .addFields(
          { name: 'Owner',   value: `<@${row.owner_id}>`, inline: true },
          { name: 'Members', value: `${vc.members.size}${vc.userLimit ? `/${vc.userLimit}` : ''}`, inline: true },
          { name: 'Created', value: `<t:${row.created_at}:R>`, inline: true },
          { name: 'Status',  value: vc.userLimit === 0 ? '🔓 Unlimited' : `👥 ${vc.members.size}/${vc.userLimit}`, inline: true },
        )],
      ephemeral: true,
    });
  }
}
