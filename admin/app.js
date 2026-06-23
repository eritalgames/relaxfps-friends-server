'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const loginView = $('#loginView');
const appView = $('#appView');
const pageContent = $('#pageContent');
const pageTitle = $('#pageTitle');
const pageEyebrow = $('#pageEyebrow');
const toastEl = $('#toast');
const connectionDot = $('#connectionDot');
const connectionText = $('#connectionText');
const sessionTimer = $('#sessionTimer');

let authToken = sessionStorage.getItem('relaxfps_admin_token') || '';
let authExpiresAt = Number(sessionStorage.getItem('relaxfps_admin_expires_at') || 0);
let ws = null;
let requestCounter = 0;
let snapshot = {};
let currentPage = 'overview';
let contentTab = 'announcements';
let selectedUserId = '';
let selectedWalletId = '';
let pending = new Map();
let reconnectTimer = null;
let toastTimer = null;
let serverAuthStatus = { configured: false, totpRequired: false };
let announcementImageBase64 = '';
let announcementVideoBase64 = '';
let panelImageBase64 = '';

const titles = {
  overview: ['YÖNETİM MERKEZİ', 'Genel Bakış'],
  content: ['YAYIN VE İÇERİK', 'İçerik Yönetimi'],
  users: ['KULLANICI MERKEZİ', 'Kullanıcılar'],
  wallet: ['RFX TOKEN MERKEZİ', 'RFX'],
  'app-control': ['UZAKTAN YÖNETİM', 'Uygulama Kontrolü'],
  feedback: ['DESTEK MERKEZİ', 'Geri Bildirim'],
  security: ['SİSTEM VE GÜVENLİK', 'Güvenlik'],
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('tr-TR');
}
function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast show${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 4200);
}
function setConnection(online, text) {
  connectionDot.classList.toggle('online', online);
  connectionText.textContent = text;
}
function setBusy(button, busy, text = 'İşleniyor…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}
function sessionValid() { return authToken && authExpiresAt > Date.now(); }
function clearSession() {
  authToken = '';
  authExpiresAt = 0;
  sessionStorage.removeItem('relaxfps_admin_token');
  sessionStorage.removeItem('relaxfps_admin_expires_at');
}

async function loadAuthStatus() {
  try {
    const response = await fetch('/admin/api/status', { cache: 'no-store' });
    const data = await response.json();
    serverAuthStatus = data;
    $('#otpField').classList.toggle('hidden', !data.totpRequired);
    $('#loginStatus').textContent = data.configured
      ? (data.totpRequired ? 'Parola ve Authenticator kodu gerekli.' : 'Güvenli yönetici girişi hazır.')
      : 'Sunucuda RELAXFPS_ADMIN_PASSWORD ayarlanmamış.';
    $('#loginButton').disabled = !data.configured;
  } catch (_) {
    $('#loginStatus').textContent = 'Sunucuya ulaşılamadı.';
    $('#loginButton').disabled = true;
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#loginButton');
  setBusy(button, true, 'Doğrulanıyor…');
  $('#loginStatus').textContent = 'Güvenli oturum oluşturuluyor…';
  try {
    const response = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: $('#passwordInput').value,
        otp: $('#otpInput').value.trim(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.message || 'Giriş reddedildi.');
    authToken = data.token;
    authExpiresAt = Number(data.expiresAt || 0);
    sessionStorage.setItem('relaxfps_admin_token', authToken);
    sessionStorage.setItem('relaxfps_admin_expires_at', String(authExpiresAt));
    $('#passwordInput').value = '';
    $('#otpInput').value = '';
    await enterApp();
  } catch (error) {
    $('#loginStatus').textContent = error.message;
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

async function enterApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  await connectWebSocket();
}

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    clearTimeout(reconnectTimer);
    if (!sessionValid()) {
      forceLogin('Oturum süresi doldu.');
      reject(new Error('Oturum süresi doldu.'));
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      resolve();
      return;
    }
    setConnection(false, 'Bağlanıyor…');
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', async () => {
      try {
        const result = await request('admin_auth', { token: authToken }, 10000);
        if (!result.ok) throw new Error(result.message || 'Oturum doğrulanamadı.');
        setConnection(true, 'Güvenli bağlantı');
        await refreshSnapshot();
        resolve();
      } catch (error) {
        reject(error);
        forceLogin(error.message);
      }
    });
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close', () => {
      setConnection(false, 'Bağlantı kesildi');
      failPending(new Error('Sunucu bağlantısı kesildi.'));
      if (sessionValid() && !appView.classList.contains('hidden')) {
        reconnectTimer = setTimeout(() => connectWebSocket().catch(() => {}), 2500);
      }
    });
    ws.addEventListener('error', () => setConnection(false, 'Bağlantı hatası'));
  });
}

function request(type, payload = {}, timeoutMs = 15000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Sunucu bağlantısı hazır değil.'));
  const requestId = `web-${Date.now()}-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${type} zaman aşımına uğradı.`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timeout });
    ws.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

function handleMessage(event) {
  let data;
  try { data = JSON.parse(event.data); } catch (_) { return; }
  const requestId = String(data.requestId || '');
  if (requestId && pending.has(requestId)) {
    const item = pending.get(requestId);
    clearTimeout(item.timeout);
    pending.delete(requestId);
    if (data.ok === false || data.type === 'admin_error') {
      const error = new Error(data.message || 'Sunucu işlemi reddetti.');
      if (data.code === 'session_expired') forceLogin('Oturum süresi doldu.');
      item.reject(error);
    } else item.resolve(data);
    return;
  }
  if (data.type === 'admin_session_expired') forceLogin('Oturum süresi doldu.');
}

function failPending(error) {
  for (const item of pending.values()) {
    clearTimeout(item.timeout);
    item.reject(error);
  }
  pending.clear();
}

async function refreshSnapshot() {
  const data = await request('admin_snapshot', {}, 20000);
  snapshot = data;
  if (!selectedUserId && (snapshot.users || []).length) selectedUserId = snapshot.users[0].id;
  renderPage();
}

function forceLogin(message = '') {
  clearSession();
  try { ws?.close(); } catch (_) {}
  ws = null;
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  $('#loginStatus').textContent = message || 'Yeniden giriş yapmalısın.';
  if (message) toast(message, true);
}

$('#logoutButton').addEventListener('click', async () => {
  try {
    await fetch('/admin/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } });
  } catch (_) {}
  forceLogin('Güvenli çıkış yapıldı.');
});
$('#refreshButton').addEventListener('click', async () => {
  setBusy($('#refreshButton'), true, 'Yenileniyor…');
  try { await refreshSnapshot(); toast('Veriler yenilendi.'); }
  catch (error) { toast(error.message, true); }
  finally { setBusy($('#refreshButton'), false); }
});

$('#navList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page]');
  if (!button) return;
  currentPage = button.dataset.page;
  $$('#navList button').forEach((item) => item.classList.toggle('active', item === button));
  renderPage();
});

function renderPage() {
  const [eyebrow, title] = titles[currentPage] || titles.overview;
  pageEyebrow.textContent = eyebrow;
  pageTitle.textContent = title;
  const renderers = {
    overview: renderOverview,
    content: renderContent,
    users: renderUsers,
    wallet: renderWallet,
    'app-control': renderAppControl,
    feedback: renderFeedback,
    security: renderSecurity,
  };
  (renderers[currentPage] || renderOverview)();
}

function statCard(label, value, note, accent = 'green') {
  return `<article class="card stat-card accent-${accent}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function renderOverview() {
  const health = snapshot.systemHealth || {};
  const analytics = snapshot.analytics || {};
  const persistence = health.persistence || {};
  const persistenceReady = persistence.configured && persistence.connected && !persistence.conflict;
  pageContent.innerHTML = `
    <div class="grid stats-grid">
      ${statCard('Kayıtlı kullanıcı', health.profiles || (snapshot.users || []).length, `${health.online || 0} çevrim içi`, 'green')}
      ${statCard('Toplam mesaj', health.messages || 0, `${health.groups || 0} grup`, 'blue')}
      ${statCard('Premium kullanıcı', analytics.premiumTotal || (snapshot.premiumUsers || []).length, `${analytics.bannedTotal || 0} banlı`, 'orange')}
      ${statCard('Kalıcı veri', persistenceReady ? 'SUPABASE AKTİF' : 'KONTROL ET', `Sürüm ${persistence.revision || 0}`, persistenceReady ? 'green' : 'red')}
    </div>
    <div class="section-head"><div><h3>Sistem durumu</h3><p>Sunucunun canlı özet bilgileri</p></div></div>
    <div class="grid two-col">
      <section class="card">
        <h3>Sunucu sağlığı</h3>
        <div class="list">
          ${infoRow('Çevrim içi', health.online || 0)}
          ${infoRow('Relay odaları', health.relayRooms || 0)}
          ${infoRow('Grup arama odaları', health.groupCallRooms || 0)}
          ${infoRow('Yerel veri dosyası', fmtBytes(health.dataFileBytes || 0))}
          ${infoRow('Supabase bağlantısı', persistence.connected ? 'Bağlı' : 'Bağlı değil')}
          ${infoRow('Bulut sürümü', persistence.revision || 0)}
          ${infoRow('Son bulut kaydı', fmtDate(persistence.lastSaveAt))}
          ${infoRow('Bekleyen değişiklik', persistence.dirty ? 'Var' : 'Yok')}
          ${infoRow('Sürüm çakışması', persistence.conflict ? 'VAR — TOKEN DURDURULDU' : 'Yok')}
          ${persistence.lastError ? infoRow('Son Supabase hatası', persistence.lastError) : ''}
          ${infoRow('Sunucu zamanı', fmtDate(snapshot.time))}
        </div>
      </section>
      <section class="card">
        <h3>Son yönetici işlemleri</h3>
        <div class="list">${(snapshot.adminAuditLog || []).slice(0, 8).map(logItem).join('') || '<div class="empty">Henüz işlem yok.</div>'}</div>
      </section>
    </div>`;
}
function infoRow(label, value) { return `<div class="list-item-head"><span class="muted">${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`; }
function logItem(item) { return `<div class="list-item"><div class="list-item-head"><b>${escapeHtml(item.action || 'işlem')}</b><span class="badge">${escapeHtml(fmtDate(item.time))}</span></div><p class="code">${escapeHtml(JSON.stringify(item.detail || {}))}</p></div>`; }

function renderContent() {
  pageContent.innerHTML = `
    <div class="tabs" id="contentTabs">
      ${tabButton('announcements', 'Duyurular')}${tabButton('panels', 'Özel Paneller')}${tabButton('promos', 'Promosyon Kodları')}
    </div>
    <div id="contentTabBody"></div>`;
  $('#contentTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    contentTab = button.dataset.tab;
    renderContent();
  });
  if (contentTab === 'announcements') renderAnnouncements();
  else if (contentTab === 'panels') renderPanels();
  else renderPromos();
}
function tabButton(id, label) { return `<button class="${contentTab === id ? 'active' : ''}" data-tab="${id}">${escapeHtml(label)}</button>`; }

function renderAnnouncements() {
  const items = snapshot.announcements || [];
  $('#contentTabBody').innerHTML = `
    <div class="grid two-col">
      <section class="card">
        <h3>Duyuru oluştur / düzenle</h3>
        <form id="announcementForm" class="form-grid">
          <input id="annId" type="hidden">
          ${field('annTitle','Başlık','text','',true,'full')}
          ${field('annCategory','Kategori','text','Duyuru')}
          ${field('annSource','Kaynak adı','text','',true)}
          ${area('annSummary','Kısa özet',true,'full')}
          ${area('annBody','Tam içerik',true,'full')}
          ${field('annLink','Kaynak bağlantısı','url','',true,'full')}
          ${field('annButton','Buton yazısı')}${field('annAction','Buton aksiyonu')}
          ${field('annPanel','Özel panel ID')}${field('annOrder','Sıra','number','0')}
          ${field('annPriority','Öncelik 0-100','number','0')}${field('annExpires','Bitiş tarihi','datetime-local')}
          <label class="check-row"><input id="annActive" type="checkbox" checked> Aktif</label>
          <label class="check-row"><input id="annPinned" type="checkbox"> Sabitlenmiş</label>
          <label class="full"><span>Görsel</span><input id="annImage" type="file" accept="image/*"><img id="annImagePreview" class="image-preview hidden" alt="Duyuru görseli"></label>
          <label class="full"><span>Kısa video (2.4 MB altı)</span><input id="annVideo" type="file" accept="video/*"></label>
          <div class="actions full"><button class="primary" type="submit">Duyuruyu kaydet</button><button id="annClear" class="ghost" type="button">Formu temizle</button></div>
        </form>
      </section>
      <section class="card"><h3>Yayınlanan duyurular (${items.length})</h3><div class="list" id="announcementList">${items.map(announcementItem).join('') || '<div class="empty">Duyuru yok.</div>'}</div></section>
    </div>`;
  $('#annImage').addEventListener('change', async (e) => {
    announcementImageBase64 = await fileToBase64(e.target.files[0], 2200000);
    const preview = $('#annImagePreview');
    if (announcementImageBase64) { preview.src = `data:image/*;base64,${announcementImageBase64}`; preview.classList.remove('hidden'); }
  });
  $('#annVideo').addEventListener('change', async (e) => { announcementVideoBase64 = await fileToBase64(e.target.files[0], 2400000); });
  $('#annClear').addEventListener('click', clearAnnouncementForm);
  $('#announcementForm').addEventListener('submit', saveAnnouncement);
  $('#announcementList').addEventListener('click', handleAnnouncementAction);
}
function announcementItem(item) {
  const sourceOk = item.sourceName && /^https?:\/\//i.test(item.link || '');
  return `<article class="list-item" data-id="${escapeHtml(item.id)}"><div class="list-item-head"><div><h4>${escapeHtml(item.title)}</h4><span class="badge ${item.active === false ? 'bad' : 'ok'}">${item.active === false ? 'PASİF' : 'AKTİF'}</span> ${item.pinned ? '<span class="badge warn">SABİT</span>' : ''} <span class="badge ${sourceOk ? 'ok' : 'bad'}">${sourceOk ? 'KAYNAKLI' : 'KAYNAK EKSİK'}</span></div><span class="muted">${escapeHtml(fmtDate(item.updatedAt || item.time))}</span></div><p><strong>${escapeHtml(item.summary || '')}</strong></p><p>${escapeHtml(item.body)}</p><p class="muted">${escapeHtml(item.sourceName || '—')} • ${escapeHtml(item.link || '—')}</p><div class="actions"><button data-action="edit">Düzenle</button><button data-action="delete" class="danger">Sil</button></div></article>`;
}
async function saveAnnouncement(event) {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    await request('admin_upsert_announcement', {
      id: $('#annId').value.trim(), title: $('#annTitle').value.trim(), summary: $('#annSummary').value.trim(), body: $('#annBody').value.trim(),
      category: $('#annCategory').value.trim(), sourceName: $('#annSource').value.trim(), link: $('#annLink').value.trim(),
      buttonLabel: $('#annButton').value.trim(), buttonAction: $('#annAction').value.trim(), panelId: $('#annPanel').value.trim(),
      order: Number($('#annOrder').value || 0), priority: Number($('#annPriority').value || 0),
      expiresAt: toIsoOrEmpty($('#annExpires').value), imageBase64: announcementImageBase64, videoBase64: announcementVideoBase64,
      active: $('#annActive').checked, pinned: $('#annPinned').checked,
    }, 25000);
    clearAnnouncementForm(); await refreshSnapshot(); toast('Duyuru kaydedildi.');
  } catch (error) { toast(error.message, true); } finally { setBusy(button, false); }
}
function handleAnnouncementAction(event) {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const id = button.closest('[data-id]').dataset.id; const item = (snapshot.announcements || []).find(x => x.id === id); if (!item) return;
  if (button.dataset.action === 'edit') fillAnnouncement(item);
  else confirmAction('Duyuruyu sil', `“${item.title}” kalıcı olarak silinsin mi?`, async () => { await request('admin_delete_announcement', { id }); await refreshSnapshot(); toast('Duyuru silindi.'); });
}
function fillAnnouncement(item) {
  $('#annId').value = item.id || ''; $('#annTitle').value = item.title || ''; $('#annSummary').value = item.summary || ''; $('#annBody').value = item.body || '';
  $('#annCategory').value = item.category || 'Duyuru'; $('#annSource').value = item.sourceName || ''; $('#annLink').value = item.link || '';
  $('#annButton').value = item.buttonLabel || ''; $('#annAction').value = item.buttonAction || ''; $('#annPanel').value = item.panelId || '';
  $('#annOrder').value = item.order || 0; $('#annPriority').value = item.priority || 0; $('#annExpires').value = toLocalInput(item.expiresAt);
  $('#annActive').checked = item.active !== false; $('#annPinned').checked = item.pinned === true;
  announcementImageBase64 = item.imageBase64 || ''; announcementVideoBase64 = item.videoBase64 || '';
  const preview = $('#annImagePreview'); if (announcementImageBase64) { preview.src = `data:image/*;base64,${announcementImageBase64}`; preview.classList.remove('hidden'); } else preview.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function clearAnnouncementForm() { $('#announcementForm')?.reset(); $('#annId').value=''; $('#annCategory').value='Duyuru'; $('#annSource').value=''; $('#annOrder').value='0'; $('#annPriority').value='0'; $('#annActive').checked=true; announcementImageBase64=''; announcementVideoBase64=''; $('#annImagePreview').classList.add('hidden'); }

function renderPanels() {
  const items = snapshot.customPanels || [];
  $('#contentTabBody').innerHTML = `<div class="grid two-col"><section class="card"><h3>Özel panel</h3><form id="panelForm" class="form-grid"><input id="panelId" type="hidden">${field('panelTitle','Başlık','text','',true,'full')}${area('panelBody','İçerik',true,'full')}${field('panelButton','Buton yazısı')}${field('panelUrl','Buton bağlantısı','url')}
  <label class="full"><span>Görsel</span><input id="panelImage" type="file" accept="image/*"><img id="panelImagePreview" class="image-preview hidden" alt="Panel görseli"></label><div class="actions full"><button class="primary" type="submit">Paneli kaydet</button><button id="panelClear" type="button" class="ghost">Temizle</button></div></form></section>
  <section class="card"><h3>Özel paneller (${items.length})</h3><div id="panelList" class="list">${items.map(panelItem).join('') || '<div class="empty">Panel yok.</div>'}</div></section></div>`;
  $('#panelImage').addEventListener('change', async e => { panelImageBase64 = await fileToBase64(e.target.files[0], 2200000); const p=$('#panelImagePreview'); if(panelImageBase64){p.src=`data:image/*;base64,${panelImageBase64}`;p.classList.remove('hidden');} });
  $('#panelClear').addEventListener('click', clearPanelForm); $('#panelForm').addEventListener('submit', savePanel); $('#panelList').addEventListener('click', handlePanelAction);
}
function panelItem(item) { return `<article class="list-item" data-id="${escapeHtml(item.id)}"><div class="list-item-head"><h4>${escapeHtml(item.title)}</h4><span class="badge code">${escapeHtml(item.id)}</span></div><p>${escapeHtml(item.body)}</p><div class="actions"><button data-action="edit">Düzenle</button><button data-action="delete" class="danger">Sil</button></div></article>`; }
async function savePanel(event){event.preventDefault();const b=event.submitter;setBusy(b,true);try{await request('admin_upsert_custom_panel',{id:$('#panelId').value.trim(),title:$('#panelTitle').value.trim(),body:$('#panelBody').value.trim(),buttonLabel:$('#panelButton').value.trim(),buttonUrl:$('#panelUrl').value.trim(),imageBase64:panelImageBase64},25000);clearPanelForm();await refreshSnapshot();toast('Özel panel kaydedildi.');}catch(e){toast(e.message,true);}finally{setBusy(b,false)}}
function handlePanelAction(event){const b=event.target.closest('button[data-action]');if(!b)return;const id=b.closest('[data-id]').dataset.id;const item=(snapshot.customPanels||[]).find(x=>x.id===id);if(!item)return;if(b.dataset.action==='edit'){ $('#panelId').value=item.id||'';$('#panelTitle').value=item.title||'';$('#panelBody').value=item.body||'';$('#panelButton').value=item.buttonLabel||'';$('#panelUrl').value=item.buttonUrl||'';panelImageBase64=item.imageBase64||'';const p=$('#panelImagePreview');if(panelImageBase64){p.src=`data:image/*;base64,${panelImageBase64}`;p.classList.remove('hidden');}window.scrollTo({top:0,behavior:'smooth'});}else confirmAction('Paneli sil',`“${item.title}” silinsin mi?`,async()=>{await request('admin_delete_custom_panel',{id});await refreshSnapshot();toast('Panel silindi.');});}
function clearPanelForm(){ $('#panelForm')?.reset();$('#panelId').value='';panelImageBase64='';$('#panelImagePreview').classList.add('hidden'); }

function renderPromos() {
  const items = snapshot.promoCodes || [];
  $('#contentTabBody').innerHTML = `<div class="grid two-col"><section class="card"><h3>Promosyon kodu</h3><form id="promoForm" class="form-grid">${field('promoCode','Kod','text','',true)}<label><span>Ödül tipi</span><select id="promoType"><option value="premium">Premium</option><option value="ad_free">Reklamsız</option><option value="winsim">WinSimPro</option><option value="friends_minutes">Arkadaş süresi</option><option value="premium_discount">Premium indirimi</option></select></label>${field('promoDuration','Süre (dakika)','number','60')}${field('promoTotal','Toplam arkadaş dakikası','number','30')}${field('promoDiscount','İndirim %','number','0')}${field('promoOfferTag','Google Play offer tag')}${field('promoOwner','Sahip RelaxFPS ID')}${field('promoMaxUses','Maksimum kullanım','number','1')}${field('promoExpires','Son kullanım','datetime-local')}${field('promoLabel','Kullanıcı etiketi','text','','false','full')}${area('promoNote','Yönetici notu',false,'full')}<label class="check-row full"><input id="promoActive" type="checkbox" checked> Kod aktif</label><div class="actions full"><button class="primary" type="submit">Kodu kaydet</button><button id="promoClear" class="ghost" type="button">Temizle</button></div></form></section>
  <section class="card"><h3>Kodlar (${items.length})</h3><div id="promoList" class="list">${items.map(promoItem).join('') || '<div class="empty">Kod yok.</div>'}</div></section></div>`;
  $('#promoForm').addEventListener('submit', savePromo); $('#promoClear').addEventListener('click', clearPromoForm); $('#promoList').addEventListener('click', handlePromoAction);
}
function promoItem(item){return `<article class="list-item" data-code="${escapeHtml(item.code)}"><div class="list-item-head"><h4 class="code">${escapeHtml(item.code)}</h4><span class="badge ${item.active===false?'bad':'ok'}">${item.active===false?'PASİF':'AKTİF'}</span></div><p>${escapeHtml(item.label||item.rewardType)} • ${escapeHtml(item.uses||0)}/${item.maxUses===0?'∞':escapeHtml(item.maxUses)}</p><div class="actions"><button data-action="copy">Kopyala</button><button data-action="edit">Düzenle</button><button data-action="delete" class="danger">Sil</button></div></article>`}
async function savePromo(event){event.preventDefault();const b=event.submitter;setBusy(b,true);try{await request('admin_upsert_promo_code',{code:$('#promoCode').value.trim(),rewardType:$('#promoType').value,durationMinutes:Number($('#promoDuration').value||60),totalMinutes:Number($('#promoTotal').value||30),discountPercent:Number($('#promoDiscount').value||0),offerTag:$('#promoOfferTag').value.trim(),ownerId:$('#promoOwner').value.trim().toUpperCase(),maxUses:Number($('#promoMaxUses').value||0),expiresAt:toIsoOrEmpty($('#promoExpires').value),label:$('#promoLabel').value.trim(),note:$('#promoNote').value.trim(),active:$('#promoActive').checked});clearPromoForm();await refreshSnapshot();toast('Promosyon kodu kaydedildi.');}catch(e){toast(e.message,true)}finally{setBusy(b,false)}}
function handlePromoAction(event){const b=event.target.closest('button[data-action]');if(!b)return;const code=b.closest('[data-code]').dataset.code;const item=(snapshot.promoCodes||[]).find(x=>x.code===code);if(!item)return;if(b.dataset.action==='copy'){navigator.clipboard.writeText(code);toast('Kod kopyalandı.');}else if(b.dataset.action==='edit'){fillPromo(item);}else confirmAction('Kodu sil',`${code} kalıcı olarak silinsin mi?`,async()=>{await request('admin_delete_promo_code',{code});await refreshSnapshot();toast('Kod silindi.');});}
function fillPromo(i){$('#promoCode').value=i.code||'';$('#promoType').value=i.rewardType||'premium';$('#promoDuration').value=i.durationMinutes||60;$('#promoTotal').value=i.totalMinutes||30;$('#promoDiscount').value=i.discountPercent||0;$('#promoOfferTag').value=i.offerTag||'';$('#promoOwner').value=i.ownerId||'';$('#promoMaxUses').value=i.maxUses||0;$('#promoExpires').value=toLocalInput(i.expiresAt);$('#promoLabel').value=i.label||'';$('#promoNote').value=i.note||'';$('#promoActive').checked=i.active!==false;window.scrollTo({top:0,behavior:'smooth'});}
function clearPromoForm(){ $('#promoForm')?.reset();$('#promoType').value='premium';$('#promoDuration').value='60';$('#promoTotal').value='30';$('#promoDiscount').value='0';$('#promoMaxUses').value='1';$('#promoActive').checked=true; }

function renderUsers() {
  const users = snapshot.users || [];
  if (!selectedUserId && users.length) selectedUserId = users[0].id;
  const selected = users.find(u => u.id === selectedUserId) || null;
  pageContent.innerHTML = `<div class="section-head"><div><h3>Kullanıcı yönetimi</h3><p>Premium, ban, test hesabı, not ve geliştirici mesajları</p></div><input id="userSearch" class="search" placeholder="ID, ad veya cihaz ara"></div><div class="grid user-layout"><section class="card user-list"><div id="userRows">${users.map(userRow).join('') || '<div class="empty">Kullanıcı yok.</div>'}</div></section><section id="userDetail" class="card">${selected ? userDetail(selected) : '<div class="empty">Bir kullanıcı seç.</div>'}</section></div>`;
  $('#userRows').addEventListener('click', e => { const b=e.target.closest('[data-user-id]');if(!b)return;selectedUserId=b.dataset.userId;renderUsers(); });
  $('#userSearch').addEventListener('input', e => { const q=e.target.value.toLowerCase();$$('#userRows [data-user-id]').forEach(row=>row.classList.toggle('hidden',!row.dataset.search.includes(q))); });
  if (selected) bindUserActions(selected);
}
function userRow(u){const search=`${u.id} ${u.name} ${u.deviceModel} ${u.appVersion}`.toLowerCase();return `<button class="user-row ${u.id===selectedUserId?'active':''}" data-user-id="${escapeHtml(u.id)}" data-search="${escapeHtml(search)}"><span><b>${escapeHtml(u.name||'RelaxFPS User')}</b><small class="code">${escapeHtml(u.id)}</small></span><span>${u.online?'<span class="badge ok">ONLINE</span>':''}${u.premium?'<span class="badge warn">PREMIUM</span>':''}${u.banned?'<span class="badge bad">BAN</span>':''}</span></button>`}
function userDetail(u){return `<div class="section-head"><div><h3>${escapeHtml(u.name||'RelaxFPS User')}</h3><p class="code">${escapeHtml(u.id)}</p></div><span class="badge ${u.online?'ok':''}">${u.online?'ÇEVRİM İÇİ':'ÇEVRİM DIŞI'}</span></div><div class="list">${infoRow('Son görülme',fmtDate(u.lastSeen))}${infoRow('Cihaz',u.deviceModel||'—')}${infoRow('Uygulama sürümü',u.appVersion||'—')}${infoRow('Dil',u.language||'—')}${infoRow('Arkadaş sayısı',u.friendsCount||0)}${infoRow('Premium bitiş',fmtDate(u.premiumUntil))}</div><hr style="border-color:var(--line);border-width:1px 0 0;margin:20px 0"><div class="form-grid">${field('userPremiumMonths','Premium ay','number','1')}<div class="actions" style="align-self:end"><button id="setPremium" class="primary">Uygula</button><button id="removePremium" class="ghost">Kaldır</button></div>${field('userBanMinutes','Ban süresi (dakika)','number','10080')}${field('userBanReason','Ban nedeni','text','Developer moderation')}<div class="actions full"><button id="banUser" class="danger">Banla</button><button id="unbanUser" class="ghost">Banı kaldır</button></div><label class="check-row full"><input id="testUser" type="checkbox" ${u.testUser?'checked':''}> Test kullanıcısı</label>${area('userNote','Yönetici özel notu',false,'full',u.note||'')}<button id="saveUserNote" class="ghost full">Notu kaydet</button>${field('devMessageTitle','Mesaj başlığı','text','Geliştiriciden mesajınız var','false','full')}${area('devMessageBody','Mesaj',true,'full')}<button id="sendDevMessage" class="primary full">Kullanıcıya gönder</button></div>`}
function bindUserActions(u){
  $('#setPremium').addEventListener('click',()=>runUserAction('admin_set_premium',{id:u.id,months:Number($('#userPremiumMonths').value||1)},'Premium verildi.'));
  $('#removePremium').addEventListener('click',()=>runUserAction('admin_set_premium',{id:u.id,months:0},'Premium kaldırıldı.'));
  $('#banUser').addEventListener('click',()=>confirmAction('Kullanıcıyı banla',`${u.id} banlansın mı?`,()=>runUserAction('admin_set_ban',{id:u.id,banned:true,minutes:Number($('#userBanMinutes').value||10080),reason:$('#userBanReason').value.trim()},'Kullanıcı banlandı.')));
  $('#unbanUser').addEventListener('click',()=>runUserAction('admin_set_ban',{id:u.id,banned:false},'Ban kaldırıldı.'));
  $('#testUser').addEventListener('change',e=>runUserAction('admin_set_test_user',{id:u.id,enabled:e.target.checked},'Test kullanıcı durumu değişti.'));
  $('#saveUserNote').addEventListener('click',()=>runUserAction('admin_set_user_note',{id:u.id,note:$('#userNote').value.trim()},'Not kaydedildi.'));
  $('#sendDevMessage').addEventListener('click',()=>runUserAction('admin_send_developer_message',{to:u.id,title:$('#devMessageTitle').value.trim(),body:$('#devMessageBody').value.trim()},'Mesaj gönderildi.'));
}
async function runUserAction(type,payload,message){try{await request(type,payload);await refreshSnapshot();toast(message);}catch(e){toast(e.message,true)}}


function fmtToken(value) {
  return new Intl.NumberFormat('tr-TR').format(Math.round(Number(value || 0)));
}

function renderWallet() {
  const wallets = snapshot.wallets || [];
  const transactions = snapshot.walletTransactions || [];
  const events = snapshot.walletSecurityEvents || [];
  const settings = snapshot.walletSettings || {};
  const integrity = snapshot.walletIntegrity || {};
  const securityReviews = snapshot.securityReviews || [];
  const pendingSecurityReviews = securityReviews.filter(item => item.status === 'pending');
  const playIntegrity = snapshot.playIntegrity || {};
  if (!selectedWalletId && wallets.length) selectedWalletId = wallets[0].id;
  const selected = wallets.find(item => item.id === selectedWalletId) || null;
  const totalBalance = wallets.reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const lockedCount = wallets.filter(item => item.locked).length;

  pageContent.innerHTML = `
    <div class="grid stats-grid">
      ${statCard('Kayıtlı cüzdan', wallets.length, `${lockedCount} kilitli`, 'green')}
      ${statCard('Dolaşımdaki RFX', fmtToken(totalBalance), settings.currencyName || 'RFX', 'blue')}
      ${statCard('İşlem defteri', transactions.length, `Son sıra: ${escapeHtml(integrity.sequence || 0)}`, 'orange')}
      ${statCard('Defter bütünlüğü', integrity.ok ? 'DOĞRULANDI' : 'DİKKAT', integrity.code || '—', integrity.ok ? 'green' : 'red')}
      ${statCard('Güvenlik incelemesi', pendingSecurityReviews.length, `${securityReviews.length} toplam kayıt`, pendingSecurityReviews.length ? 'red' : 'green')}
      ${statCard('Play Integrity', String(playIntegrity.mode || 'off').toUpperCase(), playIntegrity.configured ? 'Bağlı' : 'Yayın ayarı bekliyor', playIntegrity.configured ? 'green' : 'orange')}
    </div>

    <div class="section-head"><div><h3>Cüzdan yönetimi</h3><p>Bakiye, kilit ve kullanıcı işlem geçmişi</p></div><input id="walletSearch" class="search" placeholder="RelaxFPS ID ara"></div>
    <div class="grid user-layout">
      <section class="card user-list"><div id="walletRows">${wallets.map(walletRow).join('') || '<div class="empty">Henüz cüzdan yok.</div>'}</div></section>
      <section id="walletDetail" class="card">${selected ? walletDetail(selected) : '<div class="empty">Bir cüzdan seç.</div>'}</section>
    </div>

    <div class="section-head"><div><h3>RFX ekonomisi</h3><p>Hoş geldin ödülü, sınırsız reklam ödülü ve işlem fiyatları</p></div></div>
    <form id="walletSettingsForm" class="card">
      <div class="form-grid">
        <label class="check-row"><input id="walletEnabled" type="checkbox" ${settings.enabled !== false ? 'checked' : ''}> RFX sistemi aktif</label>
        <label class="check-row"><input id="walletPremiumUnlimited" type="checkbox" ${settings.premiumUnlimited !== false ? 'checked' : ''}> Premium sınırsız RFX</label>
        ${fieldValue('walletCurrencyName','Para birimi adı',settings.currencyName || 'RFX')}
        ${fieldValue('walletWelcomeBonus','Hoş geldin ödülü',settings.welcomeBonus ?? 250,'number')}
        ${fieldValue('walletAdReward','Reklam ödülü',settings.adReward ?? 20,'number')}
        ${fieldValue('walletDailyAdLimit','Günlük reklam sınırı (0 = sınırsız)',settings.dailyAdLimit ?? 0,'number')}
        <label class="full"><span>İşlem fiyatları (JSON)</span><textarea id="walletPrices" class="code" style="min-height:290px">${escapeHtml(JSON.stringify(settings.prices || {}, null, 2))}</textarea></label>
        <div class="actions full"><button class="primary" type="submit">RFX ayarlarını kaydet</button><button id="verifyWalletLedger" class="ghost" type="button">İşlem defterini doğrula</button></div>
      </div>
    </form>

    <div class="section-head"><div><h3>Son RFX işlemleri</h3><p>Sunucu tarafından imzalanmış işlem özeti</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Zaman</th><th>Kullanıcı</th><th>Tür</th><th>İşlem</th><th>Miktar</th><th>Son bakiye</th></tr></thead><tbody>${transactions.map(walletTransactionRow).join('') || '<tr><td colspan="6">Henüz işlem yok.</td></tr>'}</tbody></table></div>

    <div class="section-head"><div><h3>Play Integrity inceleme kuyruğu</h3><p>Riskli cihaz ve hesaplar yalnız yönetici kararıyla kalıcı olarak banlanır</p></div></div>
    <div id="securityReviewTable" class="table-wrap"><table><thead><tr><th>Zaman</th><th>Kullanıcı</th><th>Risk</th><th>Nedenler</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${securityReviews.map(securityReviewRow).join('') || '<tr><td colspan="6">Güvenlik inceleme kaydı yok.</td></tr>'}</tbody></table></div>

    <div class="section-head"><div><h3>Güvenlik olayları</h3><p>Hatalı anahtar, tekrar saldırısı, Play Integrity ve hız sınırı kayıtları</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Zaman</th><th>Seviye</th><th>Olay</th><th>Ayrıntı</th></tr></thead><tbody>${events.map(walletSecurityRow).join('') || '<tr><td colspan="4">Güvenlik olayı yok.</td></tr>'}</tbody></table></div>`;

  $('#walletRows')?.addEventListener('click', event => {
    const button = event.target.closest('[data-wallet-id]');
    if (!button) return;
    selectedWalletId = button.dataset.walletId;
    renderWallet();
  });
  $('#walletSearch')?.addEventListener('input', event => {
    const query = event.target.value.toLowerCase();
    $$('#walletRows [data-wallet-id]').forEach(row => row.classList.toggle('hidden', !row.dataset.search.includes(query)));
  });
  if (selected) bindWalletActions(selected);

  $('#walletSettingsForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      let prices;
      try { prices = JSON.parse($('#walletPrices').value); }
      catch (_) { throw new Error('İşlem fiyatları geçerli JSON olmalı.'); }
      await request('admin_update_wallet_settings', {
        settings: {
          enabled: $('#walletEnabled').checked,
          premiumUnlimited: $('#walletPremiumUnlimited').checked,
          currencyName: $('#walletCurrencyName').value.trim(),
          welcomeBonus: Number($('#walletWelcomeBonus').value || 0),
          adReward: Number($('#walletAdReward').value || 0),
          dailyAdLimit: Number($('#walletDailyAdLimit').value || 0),
          prices,
        },
      });
      await refreshSnapshot();
      toast('RFX ayarları kaydedildi.');
    } catch (error) { toast(error.message, true); }
    finally { setBusy(button, false); }
  });

  $('#verifyWalletLedger')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    setBusy(button, true, 'Doğrulanıyor…');
    try {
      const result = await request('admin_wallet_verify_ledger');
      await refreshSnapshot();
      toast(result.integrity?.ok ? 'RFX işlem defteri doğrulandı.' : 'İşlem defteri doğrulanamadı.', !result.integrity?.ok);
    } catch (error) { toast(error.message, true); }
    finally { setBusy(button, false); }
  });

  $('#securityReviewTable')?.addEventListener('click', async event => {
    const button = event.target.closest('button[data-review-action]');
    if (!button) return;
    const reviewId = button.dataset.reviewId;
    const action = button.dataset.reviewAction;
    const label = action === 'ban' ? 'kalıcı ban' : action === 'lock' ? 'geçici kilit' : action === 'approve' ? 'onay ve risk sıfırlama' : 'kapatma';
    const execute = async () => {
      setBusy(button, true);
      try {
        await request('admin_security_review_action', {
          reviewId,
          action,
          minutes: action === 'lock' ? 60 : undefined,
          reason: action === 'lock' ? 'Token E yönetici güvenlik incelemesi' : undefined,
        });
        await refreshSnapshot();
        toast(`Güvenlik incelemesi: ${label} tamamlandı.`);
      } catch (error) { toast(error.message, true); }
      finally { setBusy(button, false); }
    };
    if (action === 'ban') {
      confirmAction('Kalıcı ban uygula', 'Bu kullanıcı kalıcı olarak banlansın mı?', execute);
    } else {
      await execute();
    }
  });
}

function walletRow(wallet) {
  const search = `${wallet.id} ${wallet.balance}`.toLowerCase();
  return `<button class="user-row ${wallet.id === selectedWalletId ? 'active' : ''}" data-wallet-id="${escapeHtml(wallet.id)}" data-search="${escapeHtml(search)}"><span><b class="code">${escapeHtml(wallet.id)}</b><small>${escapeHtml(fmtDate(wallet.updatedAt))}</small></span><span><b class="wallet-balance">◆ ${escapeHtml(fmtToken(wallet.balance))}</b>${wallet.locked ? '<span class="badge bad">KİLİTLİ</span>' : ''}</span></button>`;
}

function walletDetail(wallet) {
  const userTransactions = (snapshot.walletTransactions || []).filter(item => item.userId === wallet.id).slice(0, 12);
  return `<div class="section-head"><div><h3 class="code">${escapeHtml(wallet.id)}</h3><p>Sunucu esaslı RFX cüzdanı</p></div><span class="badge ${wallet.locked ? 'bad' : 'ok'}">${wallet.locked ? 'KİLİTLİ' : 'AKTİF'}</span></div>
    <div class="wallet-hero"><small>GÜNCEL BAKİYE</small><strong>◆ ${escapeHtml(fmtToken(wallet.balance))}</strong></div>
    <div class="list">${infoRow('Hoş geldin ödülü',wallet.welcomeGranted ? 'Verildi' : 'Verilmedi')}${infoRow('Oluşturulma',fmtDate(wallet.createdAt))}${infoRow('Son güncelleme',fmtDate(wallet.updatedAt))}${infoRow('Risk puanı',wallet.riskScore || 0)}${infoRow('Kilit bitişi',fmtDate(wallet.lockedUntil))}${infoRow('Kilit nedeni',wallet.lockReason || '—')}</div>
    <hr style="border-color:var(--line);border-width:1px 0 0;margin:20px 0">
    <div class="form-grid">
      ${field('walletAdjustAmount','RFX miktarı','number','Örn. 500 veya -100')}
      ${field('walletAdjustReason','İşlem nedeni','text','Destek düzeltmesi')}
      <button id="walletAdjust" class="primary full">Bakiyeyi güncelle</button>
      ${field('walletLockMinutes','Kilit süresi (dakika)','number','0 = süresiz')}
      ${field('walletLockReason','Kilit nedeni','text','Güvenlik kontrolü')}
      <div class="actions full"><button id="walletLock" class="danger">Cüzdanı kilitle</button><button id="walletUnlock" class="ghost">Kilidi kaldır</button></div>
    </div>
    <div class="section-head"><div><h3>Son işlemleri</h3></div></div>
    <div class="list">${userTransactions.map(item => `<div class="list-item"><div class="list-item-head"><b>${escapeHtml(item.type)}</b><span class="badge ${Number(item.amount) >= 0 ? 'ok' : 'warn'}">${Number(item.amount) >= 0 ? '+' : ''}${escapeHtml(fmtToken(item.amount))}</span></div><p>${escapeHtml(item.action || '—')} • ${escapeHtml(fmtDate(item.createdAt))}</p></div>`).join('') || '<div class="empty">İşlem yok.</div>'}</div>`;
}

function bindWalletActions(wallet) {
  $('#walletAdjust')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const amount = Number($('#walletAdjustAmount').value || 0);
    if (!amount) return toast('Sıfırdan farklı bir miktar yaz.', true);
    setBusy(button, true);
    try {
      await request('admin_wallet_adjust', { id: wallet.id, amount, reason: $('#walletAdjustReason').value.trim() });
      await refreshSnapshot();
      toast('Cüzdan bakiyesi güncellendi.');
    } catch (error) { toast(error.message, true); }
    finally { setBusy(button, false); }
  });
  $('#walletLock')?.addEventListener('click', () => confirmAction('Cüzdanı kilitle', `${wallet.id} token işlemlerine kapatılsın mı?`, async () => {
    await request('admin_wallet_lock', { id: wallet.id, locked: true, minutes: Number($('#walletLockMinutes').value || 0), reason: $('#walletLockReason').value.trim() });
    await refreshSnapshot();
    toast('Cüzdan kilitlendi.');
  }));
  $('#walletUnlock')?.addEventListener('click', async () => {
    try {
      await request('admin_wallet_lock', { id: wallet.id, locked: false });
      await refreshSnapshot();
      toast('Cüzdan kilidi kaldırıldı.');
    } catch (error) { toast(error.message, true); }
  });
}

function walletTransactionRow(item) {
  const amount = Number(item.amount || 0);
  return `<tr><td>${escapeHtml(fmtDate(item.createdAt))}</td><td class="code">${escapeHtml(item.userId)}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.action || '—')}</td><td class="${amount >= 0 ? 'token-positive' : 'token-negative'}">${amount >= 0 ? '+' : ''}${escapeHtml(fmtToken(amount))}</td><td>${escapeHtml(fmtToken(item.balanceAfter))}</td></tr>`;
}
function walletSecurityRow(item) {
  const severity = item.severity === 'high' ? 'bad' : item.severity === 'info' ? 'ok' : 'warn';
  return `<tr><td>${escapeHtml(fmtDate(item.time))}</td><td><span class="badge ${severity}">${escapeHtml(item.severity || 'warning')}</span></td><td>${escapeHtml(item.event)}</td><td class="code">${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`;
}

function securityReviewRow(item) {
  const pendingReview = item.status === 'pending';
  const reasons = Array.isArray(item.reasons) ? item.reasons.join(', ') : (item.reason || '—');
  const actions = pendingReview
    ? `<div class="actions"><button class="primary" data-review-id="${escapeHtml(item.id)}" data-review-action="approve">Onayla</button><button class="ghost" data-review-id="${escapeHtml(item.id)}" data-review-action="lock">1 saat kilitle</button><button class="danger" data-review-id="${escapeHtml(item.id)}" data-review-action="ban">Kalıcı ban</button><button class="ghost" data-review-id="${escapeHtml(item.id)}" data-review-action="dismiss">Kapat</button></div>`
    : `<span class="muted">${escapeHtml(item.resolution || 'Çözüldü')}</span>`;
  return `<tr><td>${escapeHtml(fmtDate(item.updatedAt || item.createdAt))}</td><td class="code">${escapeHtml(item.userId || '—')}</td><td><span class="badge ${Number(item.score || 0) >= 75 ? 'bad' : 'warn'}">${escapeHtml(item.score || 0)}</span></td><td>${escapeHtml(reasons)}</td><td><span class="badge ${pendingReview ? 'warn' : 'ok'}">${pendingReview ? 'BEKLİYOR' : 'ÇÖZÜLDÜ'}</span></td><td>${actions}</td></tr>`;
}

function renderAppControl() {
  const s = snapshot.appSettings || {};
  const toggles = [
    ['maintenanceMode','Bakım modu'],['forceUpdate','Zorunlu güncelleme'],['friendsEnabled','Arkadaşlar'],['communityEnabled','Topluluk'],['relaxBenchEnabled','RelaxBench'],['winsimEnabled','WinSimPro'],['gameHubEnabled','Gaming Extreme'],['appLockEnabled','App Lock'],['soundBoosterEnabled','Sound Booster'],['virtualRamEnabled','Sanal RAM'],['overlayEnabled','Oyun paneli'],['messagingEnabled','Mesajlaşma'],['imageSharingEnabled','Görsel paylaşımı'],['voiceCallEnabled','Sesli arama'],['relayVoiceEnabled','Relay Voice'],['betaToolsEnabled','Beta araçlar'],['adsEnabled','Reklamlar'],['telemetryEnabled','Telemetri']
  ];
  pageContent.innerHTML = `<form id="appSettingsForm"><section class="card"><h3>Özellik anahtarları</h3><div class="grid switch-grid">${toggles.map(([k,l])=>`<label class="switch-card"><span>${escapeHtml(l)}</span><input id="setting_${k}" type="checkbox" ${s[k]!==false && (k!=='maintenanceMode'&&k!=='forceUpdate'&&k!=='communityEnabled'||s[k]===true)?'checked':''}></label>`).join('')}</div></section><div class="section-head"><div><h3>Bakım ve sürüm</h3><p>Kullanıcı uygulamasına anlık uygulanır</p></div></div><section class="card form-grid">${area('maintenanceMessage','Bakım mesajı',false,'full',s.maintenanceMessage||'')}${fieldValue('maintenanceUntil','Tahmini bitiş',s.maintenanceUntil||'')}${fieldValue('minimumVersion','Minimum sürüm',s.minimumVersion||'')}${fieldValue('latestVersion','Son sürüm',s.latestVersion||'')}${fieldValue('playStoreUrl','Play Store bağlantısı',s.playStoreUrl||'','url')}${area('updateMessage','Güncelleme mesajı',false,'full',s.updateMessage||'')}${fieldValue('freeFriendMinutes','Ücretsiz arkadaş süresi',s.freeFriendMinutes??15,'number')}${fieldValue('premiumFriendMinutes','Premium arkadaş süresi',s.premiumFriendMinutes??60,'number')}${fieldValue('appLockFailLimit','App Lock hata limiti',s.appLockFailLimit??3,'number')}${fieldValue('appLockLockMinutes','App Lock kilit dakikası',s.appLockLockMinutes??2,'number')}<div class="actions full"><button class="primary" type="submit">Ayarları sunucuya kaydet</button></div></section></form>`;
  $('#appSettingsForm').addEventListener('submit', async e=>{e.preventDefault();const b=e.submitter;setBusy(b,true);try{const payload={};for(const [k] of toggles)payload[k]=$(`#setting_${k}`).checked;Object.assign(payload,{maintenanceMessage:$('#maintenanceMessage').value.trim(),maintenanceUntil:$('#maintenanceUntil').value.trim(),minimumVersion:$('#minimumVersion').value.trim(),latestVersion:$('#latestVersion').value.trim(),playStoreUrl:$('#playStoreUrl').value.trim(),updateMessage:$('#updateMessage').value.trim(),freeFriendMinutes:Number($('#freeFriendMinutes').value||15),premiumFriendMinutes:Number($('#premiumFriendMinutes').value||60),appLockFailLimit:Number($('#appLockFailLimit').value||3),appLockLockMinutes:Number($('#appLockLockMinutes').value||2)});await request('admin_update_app_settings',payload);await refreshSnapshot();toast('Uygulama ayarları kaydedildi.');}catch(err){toast(err.message,true)}finally{setBusy(b,false)}});
}

function renderFeedback() {
  const items = snapshot.feedback || [];
  pageContent.innerHTML = `<div class="section-head"><div><h3>Kullanıcı geri bildirimleri</h3><p>${items.length} kayıt</p></div></div><div id="feedbackList" class="list">${items.map(feedbackItem).join('')||'<div class="card empty">Geri bildirim yok.</div>'}</div>`;
  $('#feedbackList').addEventListener('click', async e=>{const b=e.target.closest('button[data-feedback]');if(!b)return;const id=b.dataset.feedback;const card=b.closest('[data-feedback-card]');try{await request('admin_update_feedback',{id,status:card.querySelector('select').value,reply:card.querySelector('textarea').value.trim()});await refreshSnapshot();toast('Geri bildirim güncellendi.');}catch(err){toast(err.message,true)}});
}
function feedbackItem(i){
  const categoryLabels={technical:'Teknik sorun',payment:'Ödeme sorunu',server:'Sunucu / bağlantı',other:'Diğer'};
  const attachment=i.attachmentBase64?`<div style="margin:12px 0"><img class="image-preview" src="data:${escapeHtml(i.attachmentMime||'image/jpeg')};base64,${i.attachmentBase64}" alt="${escapeHtml(i.attachmentName||'Destek görseli')}"><p class="muted">${escapeHtml(i.attachmentName||'Görsel eki')}</p></div>`:'';
  return `<article class="card" data-feedback-card="${escapeHtml(i.id)}"><div class="list-item-head"><div><h3>${escapeHtml(i.title||'Destek talebi')}</h3><span class="badge code">${escapeHtml(i.from||'UNKNOWN')}</span> <span class="badge ${i.priority==='premium'?'warn':'ok'}">${i.priority==='premium'?'ÖNCELİKLİ':'NORMAL'}</span> <span class="badge">${escapeHtml(categoryLabels[i.category]||'Teknik sorun')}</span></div><span class="muted">${escapeHtml(fmtDate(i.updatedAt||i.time))}</span></div><p class="muted">${escapeHtml(i.email||'E-posta yok')}</p><p>${escapeHtml(i.body||'')}</p>${attachment}<div class="form-grid"><label><span>Durum</span><select><option value="new" ${i.status==='new'?'selected':''}>Yeni</option><option value="reviewing" ${i.status==='reviewing'?'selected':''}>İnceleniyor</option><option value="resolved" ${i.status==='resolved'?'selected':''}>Çözüldü</option><option value="closed" ${i.status==='closed'?'selected':''}>Kapalı</option></select></label><label class="full"><span>Yanıt</span><textarea>${escapeHtml(i.reply||'')}</textarea></label><button class="primary full" data-feedback="${escapeHtml(i.id)}">Kaydet ve kullanıcıya gönder</button></div></article>`;
}

function renderSecurity() {
  const security = snapshot.adminSecurity || {};
  const crashes = snapshot.crashReports || [];
  const logs = snapshot.adminAuditLog || [];
  pageContent.innerHTML = `<div class="grid two-col"><section class="card"><h3>Admin oturumu</h3><form id="securityForm" class="form-grid">${fieldValue('sessionMinutes','Oturum süresi (dakika)',security.sessionMinutes||60,'number')}<button class="primary" type="submit" style="align-self:end">Kaydet</button></form><div class="list" style="margin-top:18px">${infoRow('TOTP',snapshot.adminAuth?.totpEnabled?'Etkin':'Kapalı')}${infoRow('Son hatalı giriş',fmtDate(security.lastWrongPasswordAt))}${infoRow('Hatalı giriş sayacı',security.wrongPasswordCount||0)}</div></section><section class="card"><h3>Bakım işlemleri</h3><div class="actions"><button id="backupNow" class="primary">Şimdi yedekle</button><button id="clearCrashes" class="danger ghost">Hataları temizle</button><button id="clearLogs" class="danger ghost">Logları temizle</button></div><p class="muted">Yedekler sunucunun state dosyasında tutulur. Kritik verileri ayrıca Render diskinden yedeklemelisin.</p></section></div><div class="section-head"><div><h3>Hata raporları (${crashes.length})</h3></div></div><div class="table-wrap"><table><thead><tr><th>Zaman</th><th>Kullanıcı</th><th>Ekran</th><th>Hata</th></tr></thead><tbody>${crashes.slice(0,100).map(c=>`<tr><td>${escapeHtml(fmtDate(c.time))}</td><td class="code">${escapeHtml(c.from)}</td><td>${escapeHtml(c.screen)}</td><td>${escapeHtml(c.error)}</td></tr>`).join('')||'<tr><td colspan="4">Hata yok.</td></tr>'}</tbody></table></div><div class="section-head"><div><h3>Yönetici işlem günlüğü (${logs.length})</h3></div></div><div class="list">${logs.slice(0,100).map(logItem).join('')||'<div class="empty">Log yok.</div>'}</div>`;
  $('#securityForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;setBusy(b,true);try{await request('admin_update_security',{sessionMinutes:Number($('#sessionMinutes').value||60)});await refreshSnapshot();toast('Güvenlik ayarı kaydedildi.');}catch(err){toast(err.message,true)}finally{setBusy(b,false)}});
  $('#backupNow').addEventListener('click',async()=>{try{const r=await request('admin_backup_now');await refreshSnapshot();toast(`Yedek oluşturuldu: ${r.backup?.id||''}`);}catch(e){toast(e.message,true)}});
  $('#clearCrashes').addEventListener('click',()=>confirmAction('Hata raporlarını temizle','Bütün hata raporları silinsin mi?',async()=>{await request('admin_clear_crash_reports');await refreshSnapshot();toast('Hata raporları temizlendi.');}));
  $('#clearLogs').addEventListener('click',()=>confirmAction('Admin loglarını temizle','Yönetici işlem geçmişi silinsin mi?',async()=>{await request('admin_clear_admin_log');await refreshSnapshot();toast('Admin logları temizlendi.');}));
}

function field(id,label,type='text',placeholder='',required=false,extra=''){return `<label class="${extra}"><span>${escapeHtml(label)}</span><input id="${id}" type="${type}" placeholder="${escapeHtml(placeholder)}" ${required===true?'required':''}></label>`}
function fieldValue(id,label,value,type='text',extra=''){return `<label class="${extra}"><span>${escapeHtml(label)}</span><input id="${id}" type="${type}" value="${escapeHtml(value)}"></label>`}
function area(id,label,required=false,extra='',value=''){return `<label class="${extra}"><span>${escapeHtml(label)}</span><textarea id="${id}" ${required?'required':''}>${escapeHtml(value)}</textarea></label>`}
function toIsoOrEmpty(value){if(!value)return'';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toISOString()}
function toLocalInput(value){if(!value)return'';const d=new Date(value);if(Number.isNaN(d.getTime()))return'';const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,16)}
async function fileToBase64(file,maxBytes){if(!file)return'';if(file.size>maxBytes){toast(`Dosya çok büyük. Sınır: ${fmtBytes(maxBytes)}`,true);return'';}const buffer=await file.arrayBuffer();let binary='';const bytes=new Uint8Array(buffer);const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(binary)}
function confirmAction(title,text,action){const dialog=$('#confirmDialog');$('#confirmTitle').textContent=title;$('#confirmText').textContent=text;dialog.showModal();dialog.addEventListener('close',async function handler(){dialog.removeEventListener('close',handler);if(dialog.returnValue==='default'){try{await action();}catch(e){toast(e.message,true)}}});}

setInterval(() => {
  const remaining = authExpiresAt - Date.now();
  if (remaining <= 0) { sessionTimer.textContent = 'SÜRE DOLDU'; if (authToken) forceLogin('Oturum süresi doldu.'); return; }
  const mins = Math.floor(remaining / 60000); const secs = Math.floor((remaining % 60000) / 1000);
  sessionTimer.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}, 1000);

(async function boot(){
  await loadAuthStatus();
  if (sessionValid()) {
    try { await enterApp(); } catch (_) { forceLogin('Oturum yeniden doğrulanamadı.'); }
  }
})();
