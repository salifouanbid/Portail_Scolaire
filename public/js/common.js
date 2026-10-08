// Outils communs : API, traduction FR/EN, gabarits HTML sûrs, modales, graphiques, file d'attente hors-ligne.

/* ================= Langue ================= */
export const getLang = () => (localStorage.getItem('lang') === 'en' ? 'en' : 'fr');
export const T = (fr, en) => (getLang() === 'en' ? en : fr);
export function setLang(l) {
  localStorage.setItem('lang', l === 'en' ? 'en' : 'fr');
  document.documentElement.lang = getLang();
  applyI18n();
  document.dispatchEvent(new Event('langchange'));
}
// Textes statiques : <h1 data-fr="Bonjour" data-en="Hello"></h1>  /  placeholder : data-fr-ph / data-en-ph
export function applyI18n(root = document) {
  root.querySelectorAll('[data-fr]').forEach((el) => { el.textContent = T(el.dataset.fr, el.dataset.en ?? el.dataset.fr); });
  root.querySelectorAll('[data-fr-ph]').forEach((el) => { el.placeholder = T(el.dataset.frPh, el.dataset.enPh ?? el.dataset.frPh); });
  root.querySelectorAll('[data-lang-switch]').forEach((el) => langSwitcher(el));
}
export function langSwitcher(el) {
  el.className = 'lang';
  el.innerHTML = `<button data-l="fr" class="${getLang() === 'fr' ? 'active' : ''}">FR</button><button data-l="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button>`;
  el.onclick = (e) => { const b = e.target.closest('button[data-l]'); if (b) setLang(b.dataset.l); };
}
document.documentElement.lang = getLang();

/* ================= HTML sûr (échappement automatique) ================= */
class Raw { constructor(v) { this.v = v; } }
export const raw = (v) => new Raw(v);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function part(v) {
  if (v instanceof Raw) return v.v;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
export const h = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const setHtml = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.v : esc(tpl); };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Délégation d'événements : <button data-act="save" data-id="3"> -> handlers.save(el, event)
export function bind(root, handlers) {
  root.onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (el && root.contains(el) && handlers[el.dataset.act]) { handlers[el.dataset.act](el, e); }
  };
  root.onchange = (e) => {
    const el = e.target.closest('[data-change]');
    if (el && handlers[el.dataset.change]) handlers[el.dataset.change](el, e);
  };
  root.oninput = (e) => {
    const el = e.target.closest('[data-input]');
    if (el && handlers[el.dataset.input]) handlers[el.dataset.input](el, e);
  };
}

/* ================= Formats ================= */
export function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const s = (Math.round(n * 10 ** digits) / 10 ** digits).toString();
  return getLang() === 'fr' ? s.replace('.', ',') : s;
}
export function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length <= 10 ? d + 'T12:00:00' : String(d).replace(' ', 'T') + 'Z');
  return dt.toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const colorOf = (v) => (v === null || v === undefined ? 'none' : v >= 14 ? 'green' : v >= 10 ? 'blue' : 'red');
export const fileSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');

/* ================= API ================= */
let currentUserId = null;
export const setCurrentUser = (id) => { currentUserId = id; };

export async function api(path, { method = 'GET', body, form, noRedirect } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'portail' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch (e) { const err = new Error(T('Connexion impossible. Vérifiez votre réseau.', 'Unable to connect. Check your network.')); err.network = true; throw err; }
  let data = {};
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok) {
    if (res.status === 401 && !noRedirect) { location.href = '/'; }
    const err = new Error(data.error || T('Une erreur est survenue', 'Something went wrong'));
    err.status = res.status; err.code = data.code;
    throw err;
  }
  return data;
}
export const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---- File d'attente hors-ligne (notes et appel) : rien ne se perd si le réseau coupe ---- */
const QKEY = 'portail_queue';
const readQ = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; } };
const writeQ = (q) => localStorage.setItem(QKEY, JSON.stringify(q));
export async function saveWithQueue(key, path, body) {
  try {
    await api(path, { method: 'PUT', body });
    return { queued: false };
  } catch (e) {
    if (!e.network) throw e;
    const q = readQ().filter((x) => x.key !== key);
    q.push({ key, path, body, uid: currentUserId });
    writeQ(q);
    return { queued: true };
  }
}
export async function flushQueue() {
  const q = readQ().filter((x) => x.uid === currentUserId);
  if (!q.length) return 0;
  let sent = 0;
  for (const item of q) {
    try {
      await api(item.path, { method: 'PUT', body: item.body });
      writeQ(readQ().filter((x) => x.key !== item.key));
      sent++;
    } catch (e) {
      if (e.network) break; // toujours hors-ligne, on réessaiera
      writeQ(readQ().filter((x) => x.key !== item.key)); // refus définitif du serveur : on abandonne cet envoi
      toast(e.message, 'error');
    }
  }
  if (sent) toast(T(`${sent} sauvegarde(s) en attente envoyée(s).`, `${sent} pending save(s) sent.`), 'ok');
  return sent;
}
window.addEventListener('online', () => flushQueue());
export const pendingCount = () => readQ().filter((x) => x.uid === currentUserId).length;

/* ================= Toasts & modales ================= */
export function toast(msg, type = 'info') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}
export const errToast = (e) => toast(e.message || String(e), 'error');

// openModal({ title, body: h`...`, wide, actions: [{ label, cls, run(handle) }], closable })
export function openModal({ title, body, wide = false, actions = [], closable = true, onOpen }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const m = document.createElement('div');
  m.className = 'modal' + (wide ? ' wide' : '');
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  setHtml(m, h`<h2>${title}</h2><div class="modal-body">${body}</div><div class="modal-actions"></div>`);
  const bar = $('.modal-actions', m);
  const handle = { el: m, close: () => back.remove(), err: (msg) => { const e = $('.error-msg', m); if (e) e.textContent = msg; } };
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || '');
    b.type = 'button';
    b.textContent = a.label;
    b.onclick = async () => {
      if (a.run) {
        b.disabled = true;
        try { const keep = await a.run(handle); if (keep === false) b.disabled = false; }
        catch (e) { handle.err(e.message); b.disabled = false; }
      } else handle.close();
    };
    bar.appendChild(b);
  });
  if (closable) back.onclick = (e) => { if (e.target === back) handle.close(); };
  back.appendChild(m);
  document.body.appendChild(back);
  const first = $('input, select, textarea', m);
  if (first) first.focus();
  if (onOpen) onOpen(m, handle);
  return handle;
}
export function confirmDialog(message, { danger = false, okLabel } = {}) {
  return new Promise((resolve) => {
    openModal({
      title: T('Confirmation', 'Confirmation'),
      body: h`<p>${message}</p>`,
      actions: [
        { label: T('Annuler', 'Cancel'), run: (m) => { m.close(); resolve(false); } },
        { label: okLabel || T('Confirmer', 'Confirm'), cls: danger ? 'btn-danger' : 'btn-primary', run: (m) => { m.close(); resolve(true); } },
      ],
    });
  });
}
export const formValues = (root) => {
  const out = {};
  $$('[name]', root).forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  });
  return out;
};
export function showSecret({ title, username, password }) {
  openModal({
    title,
    body: h`<div class="notice">${T('Notez ce mot de passe provisoire : il ne sera plus affiché. La personne devra le changer à sa première connexion.', 'Write down this temporary password: it will not be shown again. The user must change it at first login.')}</div>
      <div class="field"><label>${T('Identifiant', 'Username')}</label><input readonly value="${username}"></div>
      <div class="field"><label>${T('Mot de passe provisoire', 'Temporary password')}</label><input readonly value="${password}"></div>`,
    actions: [{ label: 'OK', cls: 'btn-primary', run: (m) => m.close() }],
  });
}

/* ================= Graphiques SVG (aucune bibliothèque externe) ================= */
export function barChart(items, { max = 20 } = {}) {
  if (!items.length) return h`<div class="empty">${T('Aucune donnée', 'No data')}</div>`;
  const rowH = 34, left = 168, right = 44, W = 560, top = 8;
  const H = items.length * rowH + top + 24;
  const plot = W - left - right;
  const x = (v) => left + (Math.min(v, max) / max) * plot;
  const lines = [10, 14].map((t) => h`<line class="grid-l" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 22}" stroke-dasharray="4 4"></line><text x="${x(t)}" y="${H - 8}" text-anchor="middle">${t}</text>`);
  const rows = items.map((it, i) => {
    const y = top + i * rowH;
    const name = it.label.length > 20 ? it.label.slice(0, 19) + '…' : it.label;
    return h`<text x="${left - 10}" y="${y + 19}" text-anchor="end">${name}</text>
      <rect class="bar-${it.color || colorOf(it.value)}" x="${left}" y="${y + 6}" width="${Math.max(2, x(it.value) - left)}" height="18" rx="6"></rect>
      <text class="val" x="${x(it.value) + 6}" y="${y + 19}">${fmt(it.value)}</text>`;
  });
  return h`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"><line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${H - 22}"></line>${lines}${rows}</svg>`;
}

export function lineChart(points, { max = 20 } = {}) {
  const pts = points.filter((p) => p.value !== null && p.value !== undefined);
  if (!pts.length) return h`<div class="empty">${T('Pas encore de moyenne', 'No average yet')}</div>`;
  const W = 560, H = 260, l = 40, r = 30, t = 20, b = 40;
  const px = (i) => (points.length === 1 ? (W + l - r) / 2 : l + (i * (W - l - r)) / (points.length - 1));
  const py = (v) => t + (1 - v / max) * (H - t - b);
  const grid = [0, 5, 10, 15, 20].map((v) => h`<line class="grid-l" x1="${l}" x2="${W - r}" y1="${py(v)}" y2="${py(v)}"></line><text x="${l - 8}" y="${py(v) + 4}" text-anchor="end">${v}</text>`);
  const coords = points.map((p, i) => (p.value === null || p.value === undefined ? null : [px(i), py(p.value), p]));
  const path = coords.filter(Boolean).map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  return h`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${grid}
    <path class="line-path" d="${path}"></path>
    ${coords.map((c, i) => (c ? h`<circle class="dot" cx="${c[0]}" cy="${c[1]}" r="6"></circle><text class="val" x="${c[0]}" y="${c[1] - 12}" text-anchor="middle">${fmt(c[2].value)}</text>` : ''))}
    ${points.map((p, i) => h`<text x="${px(i)}" y="${H - 14}" text-anchor="middle">${p.label}</text>`)}</svg>`;
}

export const badge = (color, text) => h`<span class="badge ${color}">${text}</span>`;
export const gradeBadge = (v) => h`<span class="badge ${colorOf(v)}">${fmt(v)}</span>`;

/* ================= Actualités (utilisé par le site vitrine, les espaces et l'admin) ================= */
export const CATEGORIES = () => ({
  news: ['blue', T('Actualité', 'News')],
  event: ['gold', T('Événement', 'Event')],
  info: ['green', T('Info pratique', 'Notice')],
});
// Réduit une photo (téléphone : 5 Mo+) avant l'envoi : 1600 px max, JPEG. Le serveur revérifie tout.
export async function shrinkImage(file, maxDim = 1600, quality = 0.82) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(T('Format non pris en charge (JPG, PNG ou WebP).', 'Unsupported format (JPG, PNG or WebP).'));
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return { blob: file, name: file.name }; }
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return blob ? { blob, name: 'photo.jpg' } : { blob: file, name: file.name };
}

// Visionneuse plein écran : flèches ← → / Échap au clavier, boutons à l'écran.
export function openLightbox(urls, start = 0) {
  let i = start;
  const back = document.createElement('div');
  back.className = 'lightbox';
  back.innerHTML = '<button class="lb-close" aria-label="Fermer">✕</button><button class="lb-nav lb-prev" aria-label="Précédente">‹</button><img alt=""><button class="lb-nav lb-next" aria-label="Suivante">›</button><div class="lb-count"></div>';
  const im = back.querySelector('img');
  const show = () => {
    im.src = urls[i];
    back.querySelector('.lb-count').textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : '';
    back.querySelectorAll('.lb-nav').forEach((b) => { b.style.display = urls.length > 1 ? '' : 'none'; });
  };
  const step = (d) => { i = (i + d + urls.length) % urls.length; show(); };
  const close = () => { document.removeEventListener('keydown', onKey); back.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); };
  back.onclick = (e) => {
    if (e.target.closest('.lb-prev')) step(-1);
    else if (e.target.closest('.lb-next')) step(1);
    else if (e.target !== im) close();
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  show();
}
// Un clic sur une photo d'une galerie l'ouvre en grand (fonctionne partout : vitrine, espaces, admin).
document.addEventListener('click', (e) => {
  const im = e.target.closest && e.target.closest('img[data-gal]');
  if (!im) return;
  const list = [...im.closest('.gallery').querySelectorAll('img[data-gal]')];
  openLightbox(list.map((x) => x.src), list.indexOf(im));
});

// img : fonction (annonce, idImage) => URL de l'image, selon le contexte (site public, espace connecté)
export function newsCard(a, { adminActions = false, img } = {}) {
  const [color, label] = CATEGORIES()[a.category] || CATEGORIES().news;
  return h`<article class="card news ${a.pinned ? 'pinned' : ''}">
    <div class="news-meta">${badge(color, label)}${a.pinned ? badge('gold', '📌 ' + T('Épinglé', 'Pinned')) : ''}${adminActions ? badge(a.audience === 'public' ? 'green' : 'gray', a.audience === 'public' ? T('Public', 'Public') : T('Membres', 'Members only')) : ''}
      <span class="muted small">${fmtDate(a.created_at)}</span></div>
    <h3>${a.title}</h3>
    ${(a.images || []).length && img ? h`<div class="gallery n${Math.min(a.images.length, 6)}">${a.images.map((id) => h`<img data-gal="1" loading="lazy" alt="" src="${img(a, id)}">`)}</div>` : ''}
    ${a.event_date ? h`<div class="gold small mb">📅 ${T("Date de l'événement :", 'Event date:')} <b>${fmtDate(a.event_date)}</b></div>` : ''}
    <p class="prewrap">${a.body}</p>
    ${adminActions ? h`<div class="actions"><button class="btn btn-sm" data-act="edit" data-id="${a.id}">✎ ${T('Modifier', 'Edit')}</button><button class="btn btn-sm btn-danger" data-act="del" data-id="${a.id}">🗑</button></div>` : ''}
  </article>`;
}
export const eventsList = (events) => events.length
  ? events.map((e) => h`<div class="list-item"><div class="gold small"><b>📅 ${fmtDate(e.event_date)}</b></div><div>${e.title}</div></div>`)
  : h`<div class="empty">${T('Aucun événement à venir.', 'No upcoming events.')}</div>`;

/* ================= Sélecteur de langue partout ================= */
document.addEventListener('DOMContentLoaded', () => applyI18n());
