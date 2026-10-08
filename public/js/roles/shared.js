// Vues communes ÉLÈVE et PARENT (mêmes données, base d'API différente).
import { api, T, h, setHtml, bind, qs, fmt, fmtDate, getLang, barChart, lineChart, colorOf, gradeBadge, badge, fileSize, openModal, formValues, toast, errToast, newsCard, eventsList, $ } from '../common.js';

const termOptions = (terms, cur) => terms.map((t) => h`<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>${t.name}${t.status === 'open' ? ' ●' : ''}</option>`);
const pageHead = (title, extra = '') => h`<div class="page-head"><h1>${title}</h1><div>${extra}</div></div>`;

async function loadDashboard(base, termId) {
  return api(`${base}/dashboard${qs({ term_id: termId, lang: getLang() })}`);
}

// PostgreSQL renvoie les notes à plat pour éviter de recalculer un bulletin
// côté serveur. On les regroupe ici dans le même format que l'ancien rapport
// SQLite afin que l'élève et le parent voient exactement les mêmes notes.
function reportFromGrades(d) {
  if (d.report) return d.report;
  const grouped = new Map();
  (d.grades || []).forEach((g) => {
    const key = String(g.subject_id);
    if (!grouped.has(key)) grouped.set(key, { name: g.subject_name, coef: Number(g.coef) || 1, interros: Array(6).fill(null), devoirs: Array(2).fill(null) });
    const subject = grouped.get(key);
    const index = Number(g.idx) - 1;
    if (g.type === 'interro' && index >= 0 && index < 6) subject.interros[index] = Number(g.value);
    if (g.type === 'devoir' && index >= 0 && index < 2) subject.devoirs[index] = Number(g.value);
  });
  const subjects = [...grouped.values()].map((s) => {
    const interros = s.interros.filter((v) => v !== null && Number.isFinite(v));
    const devoirs = s.devoirs.filter((v) => v !== null && Number.isFinite(v));
    const parts = [];
    if (interros.length) parts.push(interros.reduce((a, v) => a + v, 0) / interros.length);
    parts.push(...devoirs);
    return { ...s, avg: parts.length ? parts.reduce((a, v) => a + v, 0) / parts.length : null, class_avg: null };
  });
  const available = subjects.filter((s) => s.avg !== null);
  const totalCoef = available.reduce((sum, s) => sum + s.coef, 0);
  const general = totalCoef ? available.reduce((sum, s) => sum + s.avg * s.coef, 0) / totalCoef : null;
  return { subjects, general, rank: null, class_size: null, class_avg: null, class_max: null, class_min: null, appreciation: null };
}

export async function dashboardView(root, base) {
  let termId = null;
  const draw = async () => {
    const d = await loadDashboard(base, termId);
    if (!d.term) {
      setHtml(root, h`${pageHead(T('Tableau de bord', 'Dashboard'))}<div class="card empty">${T("Aucune période n'est encore ouverte.", 'No term is open yet.')}</div>`);
      return;
    }
    termId = d.term.id;
    const r = reportFromGrades(d);
    const canBulletin = d.bulletin_min_avg === null || (r.general !== null && r.general >= d.bulletin_min_avg);
    setHtml(root, h`
      ${pageHead(h`${d.student.first_name} ${d.student.last_name} <span class="muted small">— ${d.student.class_name}</span>`,
        h`<select data-change="term" aria-label="term">${termOptions(d.terms, termId)}</select>`)}
      <div class="grid">
        <div class="card stat"><div class="lbl">${T('Moyenne générale', 'Overall average')}</div><div class="big-avg txt-${colorOf(r.general)}">${r.general === null ? '–' : fmt(r.general)}<span class="muted small"> /20</span></div><div class="mt">${r.appreciation ? badge('gold', r.appreciation) : ''}</div></div>
        <div class="card stat"><div class="lbl">${T('Rang', 'Rank')}</div><div class="num">${r.rank ? h`${r.rank}<span class="muted small"> / ${r.class_size}</span>` : '–'}</div></div>
        <div class="card stat"><div class="lbl">${T('Moyenne de la classe', 'Class average')}</div><div class="num">${fmt(r.class_avg)}</div><div class="muted small">${T('Meilleure', 'Best')} ${fmt(r.class_max)} · ${T('Plus faible', 'Lowest')} ${fmt(r.class_min)}</div></div>
        <div class="card stat gold"><div class="lbl">${T('Bulletin', 'Report card')}</div>
          ${canBulletin
            ? h`<a class="btn btn-gold mt" target="_blank" rel="noopener" href="/api${base}/bulletin.pdf${qs({ term_id: termId, lang: getLang() })}">⬇ ${T('Télécharger le PDF', 'Download PDF')}</a>`
            : h`<div class="muted small mt">${T(`Disponible pour les élèves ayant au moins ${d.bulletin_min_avg}/20 de moyenne.`, `Available for students with an average of at least ${d.bulletin_min_avg}/20.`)}</div>`}
        </div>
      </div>
      <div class="grid-2 mt">
        <div class="card"><h2>${T('Moyennes par matière', 'Averages by subject')}</h2>${barChart(r.subjects.map((s) => ({ label: s.name, value: s.avg })))}
          <div class="small muted mt"><span class="badge green">≥ 14</span> <span class="badge blue">≥ 10</span> <span class="badge red">&lt; 10</span></div></div>
        <div class="card"><h2>${T('Évolution de la moyenne générale', 'Overall average trend')}</h2>${lineChart(d.evolution.map((e) => ({ label: e.name, value: e.general })))}</div>
      </div>`);
    root.onchange = async (e) => { if (e.target.matches('[data-change="term"]')) { termId = parseInt(e.target.value, 10); await draw().catch(errToast); } };
  };
  await draw();
}

export async function gradesView(root, base) {
  let termId = null;
  const draw = async () => {
    const d = await loadDashboard(base, termId);
    if (!d.term) { setHtml(root, h`${pageHead(T('Détail des notes', 'Grade details'))}<div class="card empty">${T('Aucune période disponible.', 'No term available yet.')}</div>`); return; }
    termId = d.term.id;
    const r = reportFromGrades(d);
    const cell = (v) => (v === null || v === undefined ? h`<td class="num muted">·</td>` : h`<td class="num"><span class="txt-${colorOf(v)}">${fmt(v)}</span></td>`);
    setHtml(root, h`
      ${pageHead(T('Détail des notes', 'Grade details'), h`<select aria-label="term">${termOptions(d.terms, termId)}</select>`)}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>${T('Matière', 'Subject')}</th><th class="num">Coef</th>${[1, 2, 3, 4, 5, 6].map((i) => h`<th class="num">I${i}</th>`)}<th class="num">D1</th><th class="num">D2</th><th class="num">${T('Moy.', 'Avg')}</th><th class="num">${T('Classe', 'Class')}</th></tr></thead>
        <tbody>${r.subjects.map((s) => h`<tr><td><b>${s.name}</b></td><td class="num">${s.coef}</td>${[0, 1, 2, 3, 4, 5].map((i) => cell(s.interros[i]))}${cell(s.devoirs[0])}${cell(s.devoirs[1])}<td class="num">${gradeBadge(s.avg)}</td><td class="num muted">${fmt(s.class_avg)}</td></tr>`)}</tbody>
      </table></div>
      ${r.subjects.length ? '' : h`<div class="empty">${T('Aucune note enregistrée.', 'No grades recorded.')}</div>`}
      <p class="muted small mt">${T('I = interrogations, D = devoirs. Moyenne de la matière = (moyenne des interrogations + devoir 1 + devoir 2) / 3.', 'I = quizzes, D = tests. Subject average = (quiz average + test 1 + test 2) / 3.')}</p></div>`);
    root.onchange = async (e) => { if (e.target.tagName === 'SELECT') { termId = parseInt(e.target.value, 10); await draw().catch(errToast); } };
  };
  await draw();
}

export async function archivesView(root, base) {
  let subject = '';
  const draw = async () => {
    const d = await api(`${base}/archives${qs({ subject_id: subject })}`);
    setHtml(root, h`
      ${pageHead(T('Bibliothèque d\'archives', 'Archive library'), h`<select aria-label="subject"><option value="">${T('Toutes les matières', 'All subjects')}</option>${d.subjects.map((s) => h`<option value="${s.id}" ${String(s.id) === String(subject) ? 'selected' : ''}>${s.name}</option>`)}</select>`)}
      <div class="card">${d.items.length ? d.items.map((a) => h`<div class="list-item row" style="align-items:center;justify-content:space-between">
        <div><b>${a.title}</b><div class="muted small">${a.subject_name} · ${fmtDate(a.created_at)} · ${fileSize(a.size)}</div></div>
        <a class="btn btn-sm btn-primary" href="/api/files/archives/${a.id}">⬇ ${T('Télécharger', 'Download')}</a></div>`) : h`<div class="empty">${T('Aucune épreuve disponible.', 'No papers available.')}</div>`}</div>`);
    root.onchange = async (e) => { if (e.target.tagName === 'SELECT') { subject = e.target.value; await draw().catch(errToast); } };
  };
  await draw();
}

const STATUS = { todo: ['gray', () => T('À faire', 'To do')], in_progress: ['gold', () => T('En cours', 'In progress')], done: ['green', () => T('Terminé', 'Done')] };
export async function programmeView(root, base) {
  const d = await api(`${base}/programme`);
  const bySubject = {};
  d.chapters.forEach((c) => { (bySubject[c.subject_name] = bySubject[c.subject_name] || []).push(c); });
  setHtml(root, h`${pageHead(T('Programme & cahier de texte', 'Curriculum & class log'))}
    <div class="grid-2">
      <div>${Object.keys(bySubject).length ? Object.entries(bySubject).map(([name, list]) => {
        const done = list.filter((c) => c.status === 'done').length;
        return h`<div class="card"><h3>${name} <span class="muted small">${done}/${list.length}</span></h3><div class="progress mb"><i style="width:${Math.round((done / list.length) * 100)}%"></i></div>
          ${list.map((c) => h`<div class="chap"><span class="t">${c.title}</span>${badge(STATUS[c.status][0], STATUS[c.status][1]())}</div>`)}</div>`;
      }) : h`<div class="card empty">${T('Aucun chapitre renseigné.', 'No chapters yet.')}</div>`}</div>
      <div class="card"><h3>${T('Dernières séances', 'Recent lessons')}</h3>${d.lessons.length ? d.lessons.map((l) => h`<div class="list-item"><b>${l.subject_name}</b> <span class="muted small">· ${fmtDate(l.date)}</span><div>${l.content}</div>${l.homework ? h`<div class="small gold">📝 ${l.homework}</div>` : ''}</div>`) : h`<div class="empty">${T('Aucune séance.', 'No lessons.')}</div>`}</div>
    </div>`);
}

export async function attendanceView(root, base, { canJustify }) {
  const draw = async () => {
    const d = await api(`${base}/attendance`);
    const st = { absent: ['red', T('Absent', 'Absent')], late: ['gold', T('Retard', 'Late')] };
    const jst = { pending: ['gold', T('En attente', 'Pending')], approved: ['green', T('Validé', 'Approved')], rejected: ['red', T('Refusé', 'Rejected')] };
    setHtml(root, h`${pageHead(T('Assiduité', 'Attendance'))}
      <div class="card">${d.items.length ? h`<div class="table-wrap"><table><thead><tr><th>${T('Date', 'Date')}</th><th>${T('Matière', 'Subject')}</th><th>${T('Statut', 'Status')}</th><th>${T('Justification', 'Justification')}</th><th></th></tr></thead><tbody>
        ${d.items.map((a) => {
          const can = canJustify && a.status === 'absent' && !a.justified && (!a.justification_status || a.justification_status === 'rejected');
          return h`<tr><td>${fmtDate(a.date)}</td><td>${a.subject_name}</td><td>${badge(st[a.status][0], st[a.status][1])}</td>
            <td>${a.justified ? badge('green', T('Justifiée', 'Justified')) : a.justification_status ? badge(jst[a.justification_status][0], jst[a.justification_status][1]) : ''}</td>
            <td>${can ? h`<button class="btn btn-sm" data-act="just" data-id="${a.id}">${T('Justifier', 'Justify')}</button>` : ''}</td></tr>`;
        })}</tbody></table></div>` : h`<div class="empty">${T('Aucune absence ni retard enregistré. 👍', 'No absences or lateness recorded. 👍')}</div>`}</div>`);
    bind(root, {
      just: (el) => openModal({
        title: T("Justifier l'absence", 'Justify the absence'),
        body: h`<div class="field"><label>${T('Motif', 'Reason')}</label><textarea name="reason" maxlength="500"></textarea></div>
          <div class="field"><label>${T('Pièce jointe (PDF, JPG ou PNG, 5 Mo max — facultatif)', 'Attachment (PDF, JPG or PNG, max 5 MB — optional)')}</label><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png"></div><div class="error-msg"></div>`,
        actions: [
          { label: T('Annuler', 'Cancel'), run: (m) => m.close() },
          { label: T('Envoyer', 'Send'), cls: 'btn-primary', run: async (m) => {
            const fd = new FormData();
            fd.append('attendance_id', el.dataset.id);
            fd.append('reason', $('[name=reason]', m.el).value);
            const f = $('[name=file]', m.el).files[0];
            if (f) fd.append('file', f);
            await api(`${base}/justifications`, { method: 'POST', form: fd });
            m.close(); toast(T('Justificatif envoyé à la direction', 'Justification sent to the administration'), 'ok');
            draw().catch(errToast);
          } },
        ],
      }),
    });
  };
  await draw();
}

export async function newsView(root) {
  const d = await api('/news');
  setHtml(root, h`${pageHead(T('Actualités de l\'établissement', 'School news'))}
    <div class="site-layout"><section>${d.news.length ? d.news.map((a) => newsCard(a, { img: (x, id) => `/api/news/${x.id}/image/${id}` })) : h`<div class="card empty">${T("Aucune actualité pour le moment.", 'No news yet.')}</div>`}</section>
    <aside><div class="card"><h2>📅 ${T('Prochains événements', 'Upcoming events')}</h2>${eventsList(d.events)}</div></aside></div>`);
}
