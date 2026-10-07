import { api, T, h, setHtml, $, $$, bind, openModal, formValues, toast, errToast, langSwitcher, setCurrentUser, flushQueue, esc } from './common.js';

const ROLE_LABEL = {
  admin: () => T('Administrateur', 'Administrator'),
  teacher: () => T('Professeur', 'Teacher'),
  student: () => T('Élève', 'Student'),
  parent: () => T('Parent', 'Parent'),
};

let user, mod, currentKey;

async function boot() {
  let me;
  try { me = await api('/auth/me'); } catch (e) { return; }
  user = me.user;
  if (user.role === 'superadmin') { location.href = '/platform.html'; return; }
  setCurrentUser(user.id);
  document.title = user.school.name + ' — Portail';
  mod = (await import(`./roles/${user.role}.js`)).default;
  if (user.must_change_password) await forcePasswordChange();
  drawSidebar();
  const wanted = location.hash.slice(1);
  go(mod.nav.some((n) => n.key === wanted) ? wanted : mod.nav[0].key);
  flushQueue();
}
//Bandeau : abonnement
function subscriptionBanner() {
  const box = $('#sub-banner');
  if (!box) return;
  const s = user.school;
  let msg = '';
  if (s.expired) msg = T("⚠ L'abonnement de l'établissement a expiré : le site est en lecture seule (les notes restent consultables).", '⚠ The school subscription has expired: the site is read-only (grades remain viewable).');
  else if (user.role === 'admin' && s.valid_until) {
    const days = Math.ceil((new Date(s.valid_until + 'T23:59:59') - new Date()) / 86400000);
    if (days <= 14) msg = T(`Votre abonnement se termine dans ${days} jour(s) (${s.valid_until}). Pensez à le renouveler.`, `Your subscription ends in ${days} day(s) (${s.valid_until}). Please renew.`);
  }
  setHtml(box, msg ? h`<div class="notice">${msg}</div>` : '');
}
function drawSidebar() {
  const sb = $('#sidebar');
  setHtml(sb, h`
    <div class="brand"><div class="logo">${user.school.name.slice(0, 2).toUpperCase()}</div>
      <div><div class="name">${user.school.name}</div><div class="sub">${user.school.city || ''}</div></div></div>
    <div class="who"><b>${user.first_name} ${user.last_name}</b><span class="muted">${ROLE_LABEL[user.role]()}</span></div>
    <nav class="nav">${mod.nav.map((n) => h`<button data-act="nav" data-key="${n.key}" class="${n.key === currentKey ? 'active' : ''}"><span>${n.icon}</span>${T(n.fr, n.en)}</button>`)}</nav>
    <div data-lang-switch id="ls"></div>
    <button class="btn btn-sm" data-act="pwd">🔑 ${T('Mot de passe', 'Password')}</button>
    <button class="btn btn-sm" data-act="logout">⎋ ${T('Déconnexion', 'Sign out')}</button>`);
  langSwitcher($('#ls'));
  bind(sb, {
    nav: (el) => { go(el.dataset.key); closeMenu(); },
    pwd: () => changePasswordModal(false),
    logout: async () => { const schoolCode = user && user.school && user.school.code; await api('/auth/logout', { method: 'POST', noRedirect: true }).catch(() => {}); location.href = schoolCode ? `/e/${encodeURIComponent(schoolCode)}` : '/'; },
  });
  subscriptionBanner();
}

async function go(key) {
  currentKey = key;
  location.hash = key;
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  const item = mod.nav.find((n) => n.key === key);
  $('#topbar-title').textContent = T(item.fr, item.en);
  const root = $('#view');
  setHtml(root, h`<div class="empty">${T('Chargement…', 'Loading…')}</div>`);
  try {
    await mod.views[key](root, { user, go });
  } catch (e) {
    setHtml(root, h`<div class="notice">${e.message}</div>`);
  }
}

const closeMenu = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); };
$('#burger').onclick = () => { $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('show'); };
$('#scrim').onclick = closeMenu;
document.addEventListener('langchange', () => { if (user) { drawSidebar(); go(currentKey); } });

function passwordForm(forced) {
  return h`${forced ? h`<div class="notice">${T('Pour votre sécurité, choisissez un nouveau mot de passe avant de continuer.', 'For your security, choose a new password before continuing.')}</div>` : ''}
    <div class="field"><label>${T('Mot de passe actuel', 'Current password')}</label><input name="current_password" type="password" autocomplete="current-password"></div>
    <div class="field"><label>${T('Nouveau mot de passe (8 caractères minimum)', 'New password (min. 8 characters)')}</label><input name="new_password" type="password" autocomplete="new-password"></div>
    <div class="field"><label>${T('Confirmer le nouveau mot de passe', 'Confirm new password')}</label><input name="confirm" type="password" autocomplete="new-password"></div>
    <div class="error-msg"></div>`;
}
function changePasswordModal(forced) {
  return new Promise((resolve) => {
    openModal({
      title: T('Changer mon mot de passe', 'Change my password'),
      body: passwordForm(forced),
      closable: !forced,
      actions: [
        ...(forced ? [] : [{ label: T('Annuler', 'Cancel'), run: (m) => { m.close(); resolve(); } }]),
        {
          label: T('Enregistrer', 'Save'), cls: 'btn-primary',
          run: async (m) => {
            const v = formValues(m.el);
            if (v.new_password !== v.confirm) throw new Error(T('Les mots de passe ne correspondent pas', 'Passwords do not match'));
            await api('/auth/change-password', { method: 'POST', body: { current_password: v.current_password, new_password: v.new_password } });
            toast(T('Mot de passe modifié', 'Password updated'), 'ok');
            user.must_change_password = false;
            m.close();
            resolve();
          },
        },
      ],
    });
  });
}
const forcePasswordChange = () => changePasswordModal(true);

boot();
