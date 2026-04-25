/* ============================================================
   Mayhem Systems Discord Control — Web Panel JS
   ============================================================ */

const S = {
  user: null, guilds: [], guildId: null,
  channels: [], roles: [],
  ticketFilter: 'all', amData: {},
};

const $ = id => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error ?? 'Request failed'); }
  return res.json();
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type==='success'?'✅':type==='error'?'❌':'ℹ️'}</span> ${msg}`;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.style.animation = 'fadeOut .3s ease forwards'; setTimeout(() => el.remove(), 300); }, 3500);
}
function relTime(unix) {
  const d = Date.now() - unix * 1000;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return new Date(unix*1000).toLocaleDateString();
}
function escHtml(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function openModal(id)  { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function setSelect(id, val) { const el=$(id); if(!el) return; const o=[...el.options].find(o=>o.value===String(val??'')); if(o) el.value=o.value; }

// ─── Routing ──────────────────────────────────────────────────────
function nav(page) {
  document.querySelectorAll('.content-page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const view = $(`view-${page}`);
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (view)  view.classList.remove('hidden');
  if (navEl) navEl.classList.add('active');
  if (S.guildId) {
    const loaders = {
      overview:      loadStats,
      announcements: loadAnnouncements,
      tickets:       loadTickets,
      automod:       loadAutomod,
      tempvoice:     loadTempVoice,
      serverlogs:    loadServerLogs,
      welcome:       loadWelcome,
      autoroles:     loadAutoRoles,
      reactionroles: loadReactionRoles,
      rules:         loadRules,
      exportimport:  () => {},  // static page, no load needed
    };
    loaders[page]?.();
  }
}

// ─── Init ─────────────────────────────────────────────────────────
async function init() {
  try {
    const data = await api('/auth/me');
    if (!data.authenticated) { showPage('login'); return; }
    S.user = data.user; S.guilds = data.guilds;
    showPage('dashboard');
    renderUser();
    renderGuildDropdown();
    setupNav();
    if (S.guilds.length > 0) selectGuild(S.guilds[0]);
  } catch { showPage('login'); }
}
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  $(`page-${name}`).classList.remove('hidden');
}
function renderUser() {
  const u = S.user;
  const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(u.discriminator||'0')%5}.png`;
  $('user-avatar').src = avatar;
  $('user-name').textContent = u.global_name ?? u.username;
  $('user-tag').textContent  = u.discriminator && u.discriminator!=='0' ? `#${u.discriminator}` : `@${u.username}`;
}

// ─── Guild Selector ───────────────────────────────────────────────
function renderGuildDropdown() {
  $('guild-dropdown').innerHTML = S.guilds.map(g => `
    <div class="guild-option" onclick="selectGuild(${JSON.stringify(g).replace(/"/g,'&quot;')})">
      <div class="guild-icon">${g.icon?`<img src="${g.icon}" alt=""/>`:(g.name||'?')[0]}</div>
      <div class="guild-name">${escHtml(g.name)}</div>
    </div>`).join('') || '<div class="empty-state" style="padding:14px">No servers found</div>';
}
function selectGuild(guild) {
  S.guildId = guild.id;
  $('guild-dropdown').classList.add('hidden');
  const icon = $('gs-icon');
  icon.innerHTML = guild.icon ? `<img src="${guild.icon}" alt=""/>` : (guild.name||'?')[0];
  $('gs-name').textContent = guild.name;
  $('guild-subtitle').textContent = `Managing: ${guild.name}`;
  loadGuildMeta();
  nav('overview');
}
$('guild-selected').addEventListener('click', () => $('guild-dropdown').classList.toggle('hidden'));
document.addEventListener('click', e => { if (!e.target.closest('.guild-selector')) $('guild-dropdown').classList.add('hidden'); });

async function loadGuildMeta() {
  try {
    [S.channels, S.roles] = await Promise.all([
      api(`/api/guilds/${S.guildId}/channels`),
      api(`/api/guilds/${S.guildId}/roles`),
    ]);
    populateSelects();
  } catch {}
}
function populateSelects() {
  const text  = S.channels.filter(c => c.type===0||c.type===5);
  const voice = S.channels.filter(c => c.type===2);
  const cats  = S.channels.filter(c => c.type===4);
  const textOpts = text.map(c=>`<option value="${c.id}">#${escHtml(c.name)}</option>`).join('');
  const allOpts  = '<option value="">None</option>' + textOpts;

  // Announcement modal
  const annCh = $('ann-channel'); if (annCh) annCh.innerHTML = textOpts;
  // Mention roles
  const annM  = $('ann-mention'); if (annM) {
    annM.innerHTML = `<option value="">No mention</option><option value="@everyone">@everyone</option><option value="@here">@here</option>`
      + S.roles.map(r=>`<option value="<@&${r.id}>">@${escHtml(r.name)}</option>`).join('');
  }
  // AutoMod log
  const amLog = $('am-log-channel'); if (amLog) amLog.innerHTML = allOpts;
  // TempVoice
  const tvHub = $('tv-hub-channel'); if (tvHub) tvHub.innerHTML = '<option value="">Select...</option>' + voice.map(c=>`<option value="${c.id}">🔊 ${escHtml(c.name)}</option>`).join('');
  const tvCat = $('tv-category');    if (tvCat) tvCat.innerHTML = '<option value="">Select...</option>' + cats.map(c=>`<option value="${c.id}">📁 ${escHtml(c.name)}</option>`).join('');
  // Server logs default channel
  const slDef = $('sl-default-channel'); if (slDef) slDef.innerHTML = allOpts;
  // Welcome channel
  const wcCh  = $('wc-channel');  if (wcCh) wcCh.innerHTML = allOpts;
  // Auto role select
  const arSel = $('ar-role-select'); if (arSel) arSel.innerHTML = S.roles.map(r=>`<option value="${r.id}">@${escHtml(r.name)}</option>`).join('');
  // RR panel channel
  const rrCh  = $('rr-channel');  if (rrCh) rrCh.innerHTML = textOpts;
  // RR item role
  const rrIr  = $('rr-item-role'); if (rrIr) rrIr.innerHTML = S.roles.map(r=>`<option value="${r.id}">@${escHtml(r.name)}</option>`).join('');
  // Rules panel channel
  const rpCh  = $('rp-channel');  if (rpCh) rpCh.innerHTML = textOpts;
}

// ─── Nav ──────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => nav(item.dataset.page));
  });
}

// ─── Overview ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await api(`/api/guilds/${S.guildId}/stats`);
    $('stat-members').textContent      = s.memberCount?.toLocaleString() ?? '—';
    $('stat-open-tickets').textContent = s.openTickets ?? '—';
    $('stat-voice').textContent        = s.activeVoice ?? '—';
    $('stat-warns').textContent        = s.warningsToday ?? '—';
  } catch {}
}

// ─── Announcements ────────────────────────────────────────────────
async function loadAnnouncements() {
  try {
    const items = await api(`/api/announce/${S.guildId}`);
    const list  = $('announcement-list');
    if (!items.length) { list.innerHTML = '<div class="empty-state">No announcements yet.</div>'; return; }
    list.innerHTML = items.map(a => `
      <div class="list-row">
        <div class="ann-bar" style="background:${a.color||'#5865F2'}"></div>
        <div class="row-info"><div class="row-title">${escHtml(a.title)}</div><div class="row-meta">${escHtml(a.content).slice(0,80)}…</div><div class="row-meta">#${a.channel_id} · ${relTime(a.sent_at)}</div></div>
        <div class="row-actions"><button class="btn btn-danger btn-sm" onclick="deleteAnnouncement(${a.id})">🗑️</button></div>
      </div>`).join('');
  } catch (e) { $('announcement-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
async function sendAnnouncement() {
  const channelId = $('ann-channel').value, title = $('ann-title').value.trim(), content = $('ann-content').value.trim();
  if (!channelId||!title||!content) return toast('Channel, title and content are required.','error');
  try {
    await api(`/api/announce/${S.guildId}`, { method:'POST', body: JSON.stringify({ channelId, title, content, color:$('ann-color').value, imageUrl:$('ann-image').value||null, thumbnail:$('ann-thumbnail').value||null, footer:$('ann-footer').value||null, mention:$('ann-mention').value||null }) });
    toast('Announcement sent!','success'); closeModal('modal-announce'); loadAnnouncements();
    ['ann-title','ann-content','ann-image','ann-thumbnail','ann-footer'].forEach(id => $(id).value='');
  } catch (e) { toast(`Error: ${e.message}`,'error'); }
}
async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  try { await api(`/api/announce/${S.guildId}/${id}`, { method:'DELETE' }); toast('Deleted.','success'); loadAnnouncements(); } catch (e) { toast(e.message,'error'); }
}

// ─── Tickets ──────────────────────────────────────────────────────
async function loadTickets() {
  try {
    const stats = await api(`/api/tickets/${S.guildId}/stats/summary`);
    $('ts-open').textContent   = stats.open;
    $('ts-closed').textContent = stats.closed;
    $('ts-today').textContent  = stats.today;
    const url = S.ticketFilter==='all' ? `/api/tickets/${S.guildId}` : `/api/tickets/${S.guildId}?status=${S.ticketFilter}`;
    const tickets = await api(url);
    const list = $('ticket-list');
    if (!tickets.length) { list.innerHTML = '<div class="empty-state">No tickets found.</div>'; return; }
    list.innerHTML = tickets.map(t => `
      <div class="list-row">
        <div class="t-num">#${t.ticket_number}</div>
        <span class="badge ${t.status==='open'?'badge-open':'badge-closed'}">${t.status}</span>
        <div class="row-info"><div class="row-title">${escHtml(t.categoryName)}</div><div class="row-meta"><@${t.creator_id}> · ${relTime(t.created_at)}</div></div>
        <div class="row-actions">
          ${t.status==='open'?`<button class="btn btn-secondary btn-sm" onclick="closeTicket('${t.id}')">🔒</button>`:''}
          ${t.transcript?`<a href="/api/tickets/${S.guildId}/${t.id}/transcript" target="_blank" class="btn btn-secondary btn-sm">📄</a>`:''}
          <button class="btn btn-danger btn-sm" onclick="deleteTicket('${t.id}')">🗑️</button>
        </div>
      </div>`).join('');
  } catch (e) { $('ticket-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
function filterTickets(status, btn) {
  S.ticketFilter = status;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadTickets();
}
async function closeTicket(id) { try { await api(`/api/tickets/${S.guildId}/${id}/close`,{method:'POST'}); toast('Ticket closed.','success'); loadTickets(); } catch (e) { toast(e.message,'error'); } }
async function deleteTicket(id) {
  if (!confirm('Delete this ticket channel?')) return;
  try { await api(`/api/tickets/${S.guildId}/${id}`,{method:'DELETE'}); toast('Deleted.','success'); loadTickets(); } catch (e) { toast(e.message,'error'); }
}

// ─── AutoMod ──────────────────────────────────────────────────────
async function loadAutomod() {
  try {
    const d = await api(`/api/automod/${S.guildId}`); S.amData = d;
    $('am-enabled').checked   = !!d.enabled;
    setSelect('am-log-channel', d.log_channel??'');
    $('am-bw-enabled').checked = !!d.bad_words_enabled;
    setSelect('am-bw-action', d.bad_words_action);
    $('am-bw-words').value = (d.bad_words_list??[]).join('\n');
    $('am-spam-enabled').checked = !!d.spam_enabled;
    $('am-spam-threshold').value = d.spam_threshold??5;
    $('am-spam-interval').value  = d.spam_interval??5;
    setSelect('am-spam-action', d.spam_action);
    $('am-spam-mute').value = d.spam_mute_duration??5;
    $('am-links-enabled').checked   = !!d.links_enabled;
    $('am-invites-enabled').checked = !!d.invites_enabled;
    setSelect('am-links-action', d.links_action);
    $('am-links-whitelist').value = (d.links_whitelist??[]).join('\n');
    $('am-caps-enabled').checked = !!d.caps_enabled;
    $('am-caps-threshold').value = d.caps_threshold??70;
    $('am-caps-minlen').value    = d.caps_min_length??10;
    setSelect('am-caps-action', d.caps_action);
    $('am-mentions-enabled').checked = !!d.mentions_enabled;
    $('am-mentions-threshold').value = d.mentions_threshold??5;
    setSelect('am-mentions-action', d.mentions_action);
  } catch (e) { toast(`AutoMod load error: ${e.message}`,'error'); }
}
async function saveAutomod() {
  try {
    await api(`/api/automod/${S.guildId}`, { method:'PATCH', body: JSON.stringify({
      enabled: $('am-enabled').checked?1:0,
      log_channel: $('am-log-channel').value||null,
      bad_words_enabled: $('am-bw-enabled').checked?1:0,
      bad_words_action: $('am-bw-action').value,
      bad_words_list: $('am-bw-words').value.split('\n').map(w=>w.trim()).filter(Boolean),
      spam_enabled: $('am-spam-enabled').checked?1:0,
      spam_threshold: parseInt($('am-spam-threshold').value),
      spam_interval: parseInt($('am-spam-interval').value),
      spam_action: $('am-spam-action').value,
      spam_mute_duration: parseInt($('am-spam-mute').value),
      links_enabled: $('am-links-enabled').checked?1:0,
      invites_enabled: $('am-invites-enabled').checked?1:0,
      links_action: $('am-links-action').value,
      links_whitelist: $('am-links-whitelist').value.split('\n').map(w=>w.trim()).filter(Boolean),
      caps_enabled: $('am-caps-enabled').checked?1:0,
      caps_threshold: parseInt($('am-caps-threshold').value),
      caps_min_length: parseInt($('am-caps-minlen').value),
      caps_action: $('am-caps-action').value,
      mentions_enabled: $('am-mentions-enabled').checked?1:0,
      mentions_threshold: parseInt($('am-mentions-threshold').value),
      mentions_action: $('am-mentions-action').value,
    })});
    toast('AutoMod saved!','success');
  } catch (e) { toast(e.message,'error'); }
}
async function loadWarnings() {
  const uid = $('am-warn-uid').value.trim();
  try {
    const url = uid ? `/api/automod/${S.guildId}/warnings?userId=${uid}&limit=20` : `/api/automod/${S.guildId}/warnings?limit=20`;
    const warns = await api(url);
    const list = $('warnings-list');
    if (!warns.length) { list.innerHTML = '<div class="empty-state">No warnings found.</div>'; return; }
    list.innerHTML = warns.map(w => `
      <div class="list-row">
        <span class="warn-badge">⚠️</span>
        <div class="row-info"><div class="row-title">${escHtml(w.reason)}</div><div class="row-meta">${w.user_id}</div></div>
        <div class="row-meta">${relTime(w.created_at)}</div>
      </div>`).join('');
  } catch (e) { toast(e.message,'error'); }
}

// ─── Temp Voice ───────────────────────────────────────────────────
async function loadTempVoice() {
  try {
    const [cfg, active] = await Promise.all([api(`/api/voice/${S.guildId}/config`).catch(()=>null), api(`/api/voice/${S.guildId}/active`)]);
    if (cfg) { setSelect('tv-hub-channel', cfg.hub_channel_id); setSelect('tv-category', cfg.category_id); $('tv-limit').value = cfg.default_limit??0; }
    const list = $('active-voice-list');
    if (!active.length) { list.innerHTML = '<div class="empty-state">No active channels.</div>'; return; }
    list.innerHTML = active.map(ch => `
      <div class="list-row">
        <div class="ar-icon">${ch.ownerAvatar?`<img src="${ch.ownerAvatar}" style="width:32px;height:32px;border-radius:50%"/>`:'🔊'}</div>
        <div class="row-info"><div class="row-title">🔊 ${escHtml(ch.channelName)}</div><div class="row-meta">Owner: ${escHtml(ch.ownerName)} · ${relTime(ch.created_at)}</div></div>
        <span style="font-size:12px;color:var(--text-muted);background:var(--bg-hover);padding:2px 8px;border-radius:10px">👥 ${ch.memberCount}${ch.userLimit?`/${ch.userLimit}`:''}</span>
        <button class="btn btn-danger btn-sm" onclick="deleteVC('${ch.channel_id}')">🗑️</button>
      </div>`).join('');
  } catch (e) { $('active-voice-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
async function saveTempVoice() {
  const hubChannelId=$('tv-hub-channel').value, categoryId=$('tv-category').value;
  if (!hubChannelId||!categoryId) return toast('Hub channel and category required.','error');
  try { await api(`/api/voice/${S.guildId}/config`,{method:'PUT',body:JSON.stringify({hubChannelId,categoryId,defaultLimit:parseInt($('tv-limit').value)||0})}); toast('Saved!','success'); } catch (e) { toast(e.message,'error'); }
}
async function deleteVC(channelId) {
  if (!confirm('Force-delete this channel?')) return;
  try { await api(`/api/voice/${S.guildId}/${channelId}`,{method:'DELETE'}); toast('Deleted.','success'); loadTempVoice(); } catch (e) { toast(e.message,'error'); }
}

// ─── Server Logs ──────────────────────────────────────────────────
const LOG_EVENTS = [
  { key:'member_join',    col:'member_join_channel',    toggle:'log_member_join',    name:'Member Join',      desc:'When a user joins the server' },
  { key:'member_leave',   col:'member_leave_channel',   toggle:'log_member_leave',   name:'Member Leave',     desc:'When a user leaves or is kicked' },
  { key:'member_ban',     col:'member_ban_channel',     toggle:'log_member_ban',     name:'Ban / Unban',      desc:'When a user is banned or unbanned' },
  { key:'message_delete', col:'message_delete_channel', toggle:'log_message_delete', name:'Message Deleted',  desc:'When a message is deleted' },
  { key:'message_edit',   col:'message_edit_channel',   toggle:'log_message_edit',   name:'Message Edited',   desc:'When a message is edited' },
  { key:'role_change',    col:'role_change_channel',    toggle:'log_role_change',    name:'Role Changes',     desc:'When a member gains/loses a role' },
  { key:'voice_channel',  col:'voice_channel_channel',  toggle:'log_voice_channel',  name:'Voice Activity',   desc:'Join, leave, and move events' },
  { key:'channel_change', col:'channel_change_channel', toggle:'log_channel_change', name:'Channel Changes',  desc:'Channels created or deleted' },
];
async function loadServerLogs() {
  try {
    const cfg = await api(`/api/serverlogs/${S.guildId}`);
    $('sl-enabled').checked = !!cfg.enabled;
    setSelect('sl-default-channel', cfg.default_channel??'');

    const grid = $('sl-events-grid');
    const chanOpts = '<option value="">Use default</option>' + S.channels.filter(c=>c.type===0||c.type===5).map(c=>`<option value="${c.id}">#${escHtml(c.name)}</option>`).join('');

    grid.innerHTML = LOG_EVENTS.map(ev => `
      <div class="log-event-row">
        <div class="log-event-info"><div class="log-event-name">${ev.name}</div><div class="log-event-desc">${ev.desc}</div></div>
        <div class="log-event-controls">
          <label class="toggle"><input type="checkbox" id="sl-${ev.key}" ${cfg[ev.toggle]?'checked':''}/><span></span></label>
          <select id="slch-${ev.key}">${chanOpts}</select>
        </div>
      </div>`).join('');

    LOG_EVENTS.forEach(ev => setSelect(`slch-${ev.key}`, cfg[ev.col]??''));
  } catch (e) { toast(`Logs load error: ${e.message}`,'error'); }
}
async function saveServerLogs() {
  const body = { enabled: $('sl-enabled').checked?1:0, default_channel: $('sl-default-channel').value||null };
  LOG_EVENTS.forEach(ev => {
    body[ev.toggle] = $(`sl-${ev.key}`).checked?1:0;
    body[ev.col]    = $(`slch-${ev.key}`)?.value||null;
  });
  try { await api(`/api/serverlogs/${S.guildId}`,{method:'PATCH',body:JSON.stringify(body)}); toast('Server logs saved!','success'); } catch (e) { toast(e.message,'error'); }
}

// ─── Welcome ──────────────────────────────────────────────────────
async function loadWelcome() {
  try {
    const { config } = await api(`/api/welcome/${S.guildId}`);
    if (!config) return;
    $('wc-enabled').checked = !!config.enabled;
    setSelect('wc-channel', config.channel_id??'');
    $('wc-ping').checked    = !!config.ping_user;
    $('wc-title').value     = config.title   ?? '';
    $('wc-desc').value      = config.description ?? '';
    $('wc-color').value     = config.color   ?? '#57F287';
    $('wc-image').value     = config.image_url ?? '';
    setSelect('wc-thumbnail', config.thumbnail_type??'avatar');
    $('wc-footer').value    = config.footer_text ?? '';
    $('wc-dm-enabled').checked = !!config.dm_enabled;
    $('wc-dm-msg').value    = config.dm_message ?? '';
  } catch (e) { toast(`Welcome load error: ${e.message}`,'error'); }
}
async function saveWelcome() {
  try {
    await api(`/api/welcome/${S.guildId}`, { method:'PATCH', body: JSON.stringify({
      enabled:        $('wc-enabled').checked?1:0,
      channel_id:     $('wc-channel').value||null,
      ping_user:      $('wc-ping').checked?1:0,
      title:          $('wc-title').value,
      description:    $('wc-desc').value,
      color:          $('wc-color').value,
      image_url:      $('wc-image').value||null,
      thumbnail_type: $('wc-thumbnail').value,
      footer_text:    $('wc-footer').value,
      dm_enabled:     $('wc-dm-enabled').checked?1:0,
      dm_message:     $('wc-dm-msg').value,
    })});
    toast('Welcome config saved!','success');
  } catch (e) { toast(e.message,'error'); }
}
async function testWelcome() {
  try { await api(`/api/welcome/${S.guildId}/test`,{method:'POST',body:JSON.stringify({userId:S.user.id})}); toast('Test welcome sent!','success'); } catch (e) { toast(e.message,'error'); }
}

// ─── Auto Roles ───────────────────────────────────────────────────
async function loadAutoRoles() {
  try {
    const roles = await api(`/api/welcome/${S.guildId}/autoroles`);
    const list  = $('autorole-list');
    if (!roles.length) { list.innerHTML = '<div class="empty-state">No auto roles configured.</div>'; return; }
    list.innerHTML = roles.map(r => {
      const gRole = S.roles.find(gr => gr.id === r.role_id);
      return `
        <div class="ar-row">
          <div class="ar-icon">🎭</div>
          <div style="flex:1;min-width:0"><div class="ar-name">@${escHtml(gRole?.name ?? r.role_id)}</div>${r.label?`<div class="ar-label">${escHtml(r.label)}</div>`:''}</div>
          <button class="btn btn-danger btn-sm" onclick="removeAutoRole('${r.role_id}')">Remove</button>
        </div>`;
    }).join('');
  } catch (e) { $('autorole-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
async function addAutoRole() {
  const roleId = $('ar-role-select').value, label = $('ar-label').value.trim();
  if (!roleId) return toast('Select a role.','error');
  try { await api(`/api/welcome/${S.guildId}/autoroles`,{method:'POST',body:JSON.stringify({roleId,label})}); toast('Auto role added!','success'); closeModal('modal-autorole'); loadAutoRoles(); } catch (e) { toast(e.message,'error'); }
}
async function removeAutoRole(roleId) {
  if (!confirm('Remove this auto role?')) return;
  try { await api(`/api/welcome/${S.guildId}/autoroles/${roleId}`,{method:'DELETE'}); toast('Removed.','success'); loadAutoRoles(); } catch (e) { toast(e.message,'error'); }
}

// ─── Reaction Roles ───────────────────────────────────────────────
async function loadReactionRoles() {
  try {
    const panels = await api(`/api/reactionroles/${S.guildId}`);
    const wrap = $('rr-panels-list');
    if (!panels.length) { wrap.innerHTML = '<div class="empty-state">No reaction role panels yet.</div>'; return; }
    wrap.innerHTML = panels.map(p => `
      <div class="rr-panel-card">
        <div class="rr-panel-header">
          <div>
            <div class="rr-panel-title" style="display:flex;align-items:center;gap:8px">
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color}"></span>
              ${escHtml(p.title)}
            </div>
            <div class="rr-panel-meta">ID: <code>${p.id}</code> · <#${p.channel_id}></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="openAddRrItem('${p.id}')">+ Add Role</button>
            <button class="btn btn-danger btn-sm"    onclick="deleteRrPanel('${p.id}')">🗑️</button>
          </div>
        </div>
        ${p.items.length ? p.items.map(i => `
          <div class="rr-item-row">
            <span class="rr-emoji">${i.emoji}</span>
            <div class="rr-role">@${escHtml(S.roles.find(r=>r.id===i.role_id)?.name ?? i.role_id)}${i.label?` <span class="rr-label">${escHtml(i.label)}</span>`:''}</div>
            <button class="btn btn-danger btn-sm" onclick="removeRrItem(${i.id},'${p.id}')">✕</button>
          </div>`).join('') : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No roles added yet.</div>'}
      </div>`).join('');
  } catch (e) { $('rr-panels-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
async function createRrPanel() {
  const channelId=$('rr-channel').value, title=$('rr-title').value||'🎭 Reaction Roles', description=$('rr-desc').value||'React below to assign yourself roles!', color=$('rr-color').value;
  if (!channelId) return toast('Select a channel.','error');
  try { await api(`/api/reactionroles/${S.guildId}`,{method:'POST',body:JSON.stringify({channelId,title,description,color})}); toast('Panel created!','success'); closeModal('modal-rr-panel'); loadReactionRoles(); } catch (e) { toast(e.message,'error'); }
}
function openAddRrItem(panelId) { $('rr-item-panel-id').value = panelId; openModal('modal-rr-item'); }
async function addRrItem() {
  const panelId=$('rr-item-panel-id').value, emoji=$('rr-item-emoji').value.trim(), roleId=$('rr-item-role').value, label=$('rr-item-label').value.trim();
  if (!emoji||!roleId) return toast('Emoji and role required.','error');
  try { await api(`/api/reactionroles/${S.guildId}/${panelId}/items`,{method:'POST',body:JSON.stringify({emoji,roleId,label})}); toast('Role added!','success'); closeModal('modal-rr-item'); loadReactionRoles(); } catch (e) { toast(e.message,'error'); }
}
async function removeRrItem(itemId, panelId) {
  try { await api(`/api/reactionroles/${S.guildId}/${panelId}/items/${itemId}`,{method:'DELETE'}); toast('Removed.','success'); loadReactionRoles(); } catch (e) { toast(e.message,'error'); }
}
async function deleteRrPanel(panelId) {
  if (!confirm('Delete this panel and its Discord message?')) return;
  try { await api(`/api/reactionroles/${S.guildId}/${panelId}`,{method:'DELETE'}); toast('Panel deleted.','success'); loadReactionRoles(); } catch (e) { toast(e.message,'error'); }
}

// ─── Rules ────────────────────────────────────────────────────────
async function loadRules() {
  try {
    const panels = await api(`/api/rules/${S.guildId}`);
    const wrap = $('rules-panels-list');
    if (!panels.length) { wrap.innerHTML = '<div class="empty-state">No rules panels yet.</div>'; return; }
    wrap.innerHTML = panels.map(p => `
      <div class="rules-panel-card">
        <div class="rules-panel-header">
          <div>
            <div class="rules-panel-title">${escHtml(p.title)}</div>
            <div style="font-size:12px;color:var(--text-muted)">ID: <code>${p.id}</code> · <#${p.channel_id}></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="openAddRule('${p.id}',${(p.rules?.length??0)+1})">+ Add Rule</button>
            <button class="btn btn-danger btn-sm"    onclick="deleteRulesPanel('${p.id}')">🗑️</button>
          </div>
        </div>
        ${p.rules?.length ? p.rules.map(r => `
          <div class="rule-row">
            <div class="rule-num">${r.number}</div>
            <div class="rule-body"><div class="rule-title">${escHtml(r.title)}</div><div class="rule-desc">${escHtml(r.body)}</div></div>
            <button class="btn btn-danger btn-sm" onclick="deleteRule('${p.id}',${r.number})">✕</button>
          </div>`).join('') : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No rules added yet.</div>'}
      </div>`).join('');
  } catch (e) { $('rules-panels-list').innerHTML = `<div class="empty-state">Error: ${e.message}</div>`; }
}
async function createRulesPanel() {
  const channelId=$('rp-channel').value, title=$('rp-title').value||'📜 Server Rules', color=$('rp-color').value, footer=$('rp-footer').value||'Breaking rules may result in a ban.', description=$('rp-desc').value||null;
  if (!channelId) return toast('Select a channel.','error');
  try { await api(`/api/rules/${S.guildId}`,{method:'POST',body:JSON.stringify({channelId,title,color,footer,description})}); toast('Rules panel created!','success'); closeModal('modal-rules-panel'); loadRules(); } catch (e) { toast(e.message,'error'); }
}
function openAddRule(panelId, nextNum) { $('ri-panel-id').value=panelId; $('ri-number').value=nextNum; $('ri-title').value=''; $('ri-body').value=''; openModal('modal-rule-item'); }
async function addRuleItem() {
  const panelId=$('ri-panel-id').value, number=parseInt($('ri-number').value), title=$('ri-title').value.trim(), body=$('ri-body').value.trim();
  if (!title||!body) return toast('Title and details required.','error');
  try { await api(`/api/rules/${S.guildId}/${panelId}/rules/${number}`,{method:'PUT',body:JSON.stringify({title,body})}); toast('Rule added!','success'); closeModal('modal-rule-item'); loadRules(); } catch (e) { toast(e.message,'error'); }
}
async function deleteRule(panelId, number) {
  if (!confirm(`Delete rule #${number}?`)) return;
  try { await api(`/api/rules/${S.guildId}/${panelId}/rules/${number}`,{method:'DELETE'}); toast('Rule deleted.','success'); loadRules(); } catch (e) { toast(e.message,'error'); }
}
async function deleteRulesPanel(panelId) {
  if (!confirm('Delete this rules panel?')) return;
  try { await api(`/api/rules/${S.guildId}/${panelId}`,{method:'DELETE'}); toast('Panel deleted.','success'); loadRules(); } catch (e) { toast(e.message,'error'); }
}

// ─── Tab switcher ─────────────────────────────────────────────────
function switchTab(prefix, btn) {
  const tabId = btn.dataset.tab;
  document.querySelectorAll(`[id^="${prefix}-"]`).forEach(el => { if (el.classList.contains('tab-content')) el.classList.add('hidden'); });
  btn.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const target = $(tabId); if (target) target.classList.remove('hidden');
  btn.classList.add('active');
  if (tabId==='am-warnings' && S.guildId) loadWarnings();
}

// ─── Export / Import ──────────────────────────────────────────────
async function exportConfig() {
  if (!S.guildId) return toast('Select a server first.', 'error');
  try {
    const res = await fetch(`/api/export/${S.guildId}`, { credentials: 'include' });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `mayhem-export-${S.guildId}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Export downloaded!', 'success');
  } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
}

let importData = null;

function previewImport(input) {
  const file = input.files[0];
  if (!file) return;
  $('import-filename').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      importData = JSON.parse(e.target.result);
      if (!importData._meta) throw new Error('Invalid export file — missing _meta');
      const meta = importData._meta;
      const modules = [];
      if (importData.ticket_panels?.length)      modules.push(`🎫 ${importData.ticket_panels.length} ticket panel(s)`);
      if (importData.ticket_categories?.length)  modules.push(`📂 ${importData.ticket_categories.length} ticket categor${importData.ticket_categories.length===1?'y':'ies'}`);
      if (importData.ticket_form_questions?.length) modules.push(`❓ ${importData.ticket_form_questions.length} ticket question(s)`);
      if (importData.automod)                    modules.push('🛡️ AutoMod config');
      if (importData.welcome)                    modules.push('👋 Welcome config');
      if (importData.auto_roles?.length)         modules.push(`🎭 ${importData.auto_roles.length} auto role(s)`);
      if (importData.reaction_role_panels?.length) modules.push(`⭐ ${importData.reaction_role_panels.length} reaction role panel(s)`);
      if (importData.rules_panels?.length)       modules.push(`📜 ${importData.rules_panels.length} rules panel(s)`);
      if (importData.server_logs)                modules.push('📋 Server logs config');
      if (importData.temp_voice)                 modules.push('🎙️ Temp voice config');
      $('import-preview-content').innerHTML = `
        <div style="margin-bottom:12px">
          <div style="font-size:12px;color:var(--text-muted)">Exported from: <strong style="color:var(--text-header)">${escHtml(meta.guild_name)}</strong></div>
          <div style="font-size:12px;color:var(--text-muted)">Exported on: ${new Date(meta.exported_at).toLocaleString()}</div>
          <div style="font-size:12px;color:var(--text-muted)">Version: ${meta.version}</div>
        </div>
        <div style="font-size:13px;font-weight:600;color:var(--text-header);margin-bottom:8px">Will import:</div>
        ${modules.map(m => `<div style="font-size:13px;color:var(--text-primary);padding:3px 0">• ${m}</div>`).join('') || '<div style="color:var(--text-muted)">Nothing found to import.</div>'}
      `;
      $('import-preview').style.display = 'block';
      $('import-result').style.display  = 'none';
    } catch (err) {
      toast(`Invalid file: ${err.message}`, 'error');
      importData = null;
      $('import-preview').style.display = 'none';
    }
  };
  reader.readAsText(file);
}

async function runImport() {
  if (!importData || !S.guildId) return;
  if (!confirm('⚠️ This will overwrite existing settings for included modules. Continue?')) return;
  try {
    const result = await api(`/api/export/${S.guildId}/import`, {
      method: 'POST',
      body: JSON.stringify(importData),
    });
    const lines = Object.entries(result.results).map(([k,v]) => `• ${k}: ${v}`).join('\n');
    $('import-result').style.display = 'block';
    $('import-result').innerHTML = `
      <div class="card" style="border-color:var(--green)">
        <div style="font-size:14px;font-weight:600;color:var(--green);margin-bottom:8px">✅ Import Successful</div>
        <pre style="font-size:12px;color:var(--text-muted);white-space:pre-wrap">${escHtml(lines)}</pre>
      </div>`;
    $('import-preview').style.display = 'none';
    importData = null;
    $('import-file').value = '';
    $('import-filename').textContent = 'No file selected';
    toast('Config imported successfully!', 'success');
  } catch (e) { toast(`Import failed: ${e.message}`, 'error'); }
}

function cancelImport() {
  importData = null;
  $('import-file').value = '';
  $('import-filename').textContent = 'No file selected';
  $('import-preview').style.display = 'none';
  $('import-result').style.display  = 'none';
}

init();
