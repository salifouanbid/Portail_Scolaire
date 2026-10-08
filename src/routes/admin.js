// Espace ADMINISTRATEUR d'un établissement. Toute requête est filtrée par req.user.school_id.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { makeUploader, verifyFile, removeFile } = require('../services/upload');
const { persistFile, removeStoredFile, storageEnabled } = require('../services/storage');
const { attachImages, MAX_IMAGES } = require('./news');
const { ah, bad, notFound, str, intOrNull, normUsername, normEmail, checkPassword, tempPassword, hashPassword, isDate } = require('../services/util');

const router = express.Router();
const S = (req) => req.user.school_id;
const isPostgres = () => config.databaseProvider === 'postgres';

function owned(table, id, schoolId) {
  const n = intOrNull(id);
  if (n === null) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND school_id = ?`).get(n, schoolId) || null;
}
function must(table, id, schoolId, label) {
  const row = owned(table, id, schoolId);
  if (!row) throw bad(`${label} introuvable`);
  return row;
}

async function mustAsync(table, id, schoolId, label) {
  const n = intOrNull(id);
  if (n === null) throw bad(`${label} introuvable`);
  const row = await db.maybeOne(`SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`, [n, schoolId]);
  if (!row) throw bad(`${label} introuvable`);
  return row;
}

/* ---------- Tableau de bord ---------- */
router.get('/dashboard', ah(async (req, res) => {
  const s = S(req);
  const count = (role) => db.maybeOne('SELECT COUNT(*) AS c FROM users WHERE school_id = $1 AND role = $2 AND active = true', [s, role]);
  const [students, teachers, parents, classes, pending, absences, openTerm] = await Promise.all([
    count('student'), count('teacher'), count('parent'),
    db.maybeOne('SELECT COUNT(*) AS c FROM classes WHERE school_id = $1', [s]),
    db.maybeOne("SELECT COUNT(*) AS c FROM justifications WHERE school_id = $1 AND status = 'pending'", [s]),
    db.maybeOne("SELECT COUNT(*) AS c FROM attendance WHERE school_id = $1 AND date = CURRENT_DATE AND status = 'absent'", [s]),
    db.maybeOne("SELECT id, name FROM terms WHERE school_id = $1 AND status = 'open'", [s]),
  ]);
  res.json({
    students: Number(students?.c || 0), teachers: Number(teachers?.c || 0), parents: Number(parents?.c || 0),
    classes: Number(classes?.c || 0), pending_justifications: Number(pending?.c || 0),
    absences_today: Number(absences?.c || 0), open_term: openTerm || null,
  });
}));

/* ---------- Référentiel : niveaux, séries, matières ---------- */
function simpleCrud(route, table, order) {
  router.get(`/${route}`, ah(async (req, res) => {
    res.json({ items: await db.many(`SELECT * FROM ${table} WHERE school_id = $1 ORDER BY ${order}`, [S(req)]) });
  }));
  router.post(`/${route}`, ah(async (req, res) => {
    const name = str(req.body && req.body.name, 80);
    if (!name) throw bad('Nom obligatoire');
    if (table === 'levels') {
      const pos = await db.maybeOne('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM levels WHERE school_id = $1', [S(req)]);
      const r = await db.maybeOne('INSERT INTO levels (school_id, name, position) VALUES ($1,$2,$3) RETURNING id', [S(req), name, Number(pos.p)]);
      return res.status(201).json({ id: Number(r.id) });
    }
    const r = await db.maybeOne(`INSERT INTO ${table} (school_id, name) VALUES ($1,$2) RETURNING id`, [S(req), name]);
    res.status(201).json({ id: Number(r.id) });
  }));
  router.put(`/${route}/:id`, ah(async (req, res) => {
    const row = await mustAsync(table, req.params.id, S(req), 'Élément');
    const name = str(req.body && req.body.name, 80);
    if (!name) throw bad('Nom obligatoire');
    await db.execute(`UPDATE ${table} SET name = $1 WHERE id = $2`, [name, row.id]);
    res.json({ ok: true });
  }));
  router.delete(`/${route}/:id`, ah(async (req, res) => {
    const row = await mustAsync(table, req.params.id, S(req), 'Élément');
    await db.execute(`DELETE FROM ${table} WHERE id = $1`, [row.id]); // refusé (409) si encore utilisé
    res.json({ ok: true });
  }));
}
simpleCrud('levels', 'levels', 'position, id');
simpleCrud('series', 'series', 'name');
simpleCrud('subjects', 'subjects', 'name');

// Référentiel de départ (à cliquer une fois à la création d'un établissement)
router.post('/structure/starter', (req, res) => {
  const s = S(req);
  db.transaction(() => {
    ['6ème', '5ème', '4ème', '3ème', '2nde', '1ère', 'Tle'].forEach((n, i) =>
      db.prepare('INSERT OR IGNORE INTO levels (school_id, name, position) VALUES (?,?,?)').run(s, n, i + 1));
    ['Français', 'Mathématiques', 'Anglais', 'Histoire-Géographie', 'SVT', 'Physique-Chimie', 'EPS', 'Éducation civique'].forEach((n) =>
      db.prepare('INSERT OR IGNORE INTO subjects (school_id, name) VALUES (?,?)').run(s, n));
  })();
  res.json({ ok: true });
});

/* ---------- Classes ---------- */
router.get('/classes', ah(async (req, res) => {
  if (isPostgres()) {
    const items = await db.many(`SELECT c.id, c.name, c.level_id, c.series_id, l.name AS level_name, se.name AS series_name,
      (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id) AS students
      FROM classes c JOIN levels l ON l.id = c.level_id LEFT JOIN series se ON se.id = c.series_id
      WHERE c.school_id = $1 ORDER BY l.position, c.name`, [S(req)]);
    return res.json({ items });
  }
  const items = db.prepare(`SELECT c.id, c.name, c.level_id, c.series_id, l.name AS level_name, se.name AS series_name,
    (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id) AS students
    FROM classes c JOIN levels l ON l.id = c.level_id LEFT JOIN series se ON se.id = c.series_id
    WHERE c.school_id = ? ORDER BY l.position, c.name`).all(S(req));
  res.json({ items });
}));
function classBody(req) {
  const name = str(req.body && req.body.name, 60);
  if (!name) throw bad('Nom obligatoire');
  const level = must('levels', req.body.level_id, S(req), 'Niveau');
  let seriesId = null;
  if (req.body.series_id !== null && req.body.series_id !== undefined && req.body.series_id !== '') seriesId = must('series', req.body.series_id, S(req), 'Série').id;
  return { name, level_id: level.id, series_id: seriesId };
}
async function classBodyAsync(req) {
  const name = str(req.body && req.body.name, 60);
  if (!name) throw bad('Nom obligatoire');
  const level = await mustAsync('levels', req.body.level_id, S(req), 'Niveau');
  let seriesId = null;
  if (req.body.series_id !== null && req.body.series_id !== undefined && req.body.series_id !== '') seriesId = (await mustAsync('series', req.body.series_id, S(req), 'Série')).id;
  return { name, level_id: level.id, series_id: seriesId };
}
router.post('/classes', ah(async (req, res) => {
  if (isPostgres()) { const c = await classBodyAsync(req); const r = await db.maybeOne('INSERT INTO classes (school_id, level_id, series_id, name) VALUES ($1,$2,$3,$4) RETURNING id', [S(req), c.level_id, c.series_id, c.name]); return res.status(201).json({ id: Number(r.id) }); }
  const c = classBody(req); const r = db.prepare('INSERT INTO classes (school_id, level_id, series_id, name) VALUES (?,?,?,?)').run(S(req), c.level_id, c.series_id, c.name); res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
router.put('/classes/:id', ah(async (req, res) => {
  if (isPostgres()) { const row = await mustAsync('classes', req.params.id, S(req), 'Classe'); const c = await classBodyAsync(req); await db.execute('UPDATE classes SET name = $1, level_id = $2, series_id = $3 WHERE id = $4', [c.name, c.level_id, c.series_id, row.id]); return res.json({ ok: true }); }
  const row = must('classes', req.params.id, S(req), 'Classe'); const c = classBody(req); db.prepare('UPDATE classes SET name = ?, level_id = ?, series_id = ? WHERE id = ?').run(c.name, c.level_id, c.series_id, row.id); res.json({ ok: true });
}));
router.delete('/classes/:id', ah(async (req, res) => {
  if (isPostgres()) { const row = await mustAsync('classes', req.params.id, S(req), 'Classe'); await db.execute('DELETE FROM classes WHERE id = $1', [row.id]); return res.json({ ok: true }); }
  const row = must('classes', req.params.id, S(req), 'Classe'); db.prepare('DELETE FROM classes WHERE id = ?').run(row.id); res.json({ ok: true });
}));

/* ---------- Coefficients (par niveau et, si besoin, par série) ---------- */
router.get('/coefficients', ah(async (req, res) => {
  if (isPostgres()) {
    const level = await mustAsync('levels', req.query.level_id, S(req), 'Niveau');
    let seriesId = null;
    if (req.query.series_id) seriesId = (await mustAsync('series', req.query.series_id, S(req), 'Série')).id;
    const rows = await db.many(`SELECT sub.id AS subject_id, sub.name, c.coef
      FROM subjects sub
      LEFT JOIN coefficients c ON c.subject_id = sub.id AND c.level_id = $1 AND c.series_id IS NOT DISTINCT FROM $2
      WHERE sub.school_id = $3 ORDER BY sub.name`, [level.id, seriesId, S(req)]);
    return res.json({ items: rows });
  }
  const level = must('levels', req.query.level_id, S(req), 'Niveau');
  let seriesId = null;
  if (req.query.series_id) seriesId = must('series', req.query.series_id, S(req), 'Série').id;
  const rows = db.prepare(`SELECT sub.id AS subject_id, sub.name, c.coef FROM subjects sub LEFT JOIN coefficients c ON c.subject_id=sub.id AND c.level_id=? AND IFNULL(c.series_id,0)=? WHERE sub.school_id=? ORDER BY sub.name`).all(level.id, seriesId || 0, S(req));
  res.json({ items: rows });
}));
router.put('/coefficients', ah(async (req, res) => {
  if (isPostgres()) {
    const level = await mustAsync('levels', req.body && req.body.level_id, S(req), 'Niveau');
    let seriesId = null;
    if (req.body && req.body.series_id) seriesId = (await mustAsync('series', req.body.series_id, S(req), 'Série')).id;
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (items.length > 500) throw bad('Trop de coefficients envoyés');
    await db.transaction(async (tx) => {
      for (const it of items) {
        const subjectId = intOrNull(it.subject_id);
        const subject = await tx.maybeOne('SELECT * FROM subjects WHERE id = $1 AND school_id = $2', [subjectId, S(req)]);
        if (!subject) throw bad('Matière introuvable');
        await tx.execute('DELETE FROM coefficients WHERE school_id = $1 AND level_id = $2 AND series_id IS NOT DISTINCT FROM $3 AND subject_id = $4', [S(req), level.id, seriesId, subject.id]);
        const empty = it.coef === null || it.coef === '' || it.coef === undefined;
        const coef = Number(it.coef);
        if (empty || coef === 0) continue;
        if (!Number.isFinite(coef) || !(coef > 0 && coef <= 20)) throw bad(`Coefficient invalide pour ${subject.name}`);
        await tx.execute('INSERT INTO coefficients (school_id, level_id, series_id, subject_id, coef) VALUES ($1,$2,$3,$4,$5)', [S(req), level.id, seriesId, subject.id, coef]);
      }
    });
    return res.json({ ok: true });
  }
  const level = must('levels', req.body.level_id, S(req), 'Niveau');
  let seriesId = null;
  if (req.body.series_id) seriesId = must('series', req.body.series_id, S(req), 'Série').id;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  db.transaction(() => { for (const it of items) { const subject = must('subjects', it.subject_id, S(req), 'Matière'); db.prepare('DELETE FROM coefficients WHERE school_id=? AND level_id=? AND IFNULL(series_id,0)=? AND subject_id=?').run(S(req), level.id, seriesId || 0, subject.id); const coef=Number(it.coef); if (it.coef===null||it.coef===''||it.coef===undefined||coef===0) continue; if (!(coef>0&&coef<=20)) throw bad(`Coefficient invalide pour ${subject.name}`); db.prepare('INSERT INTO coefficients(school_id,level_id,series_id,subject_id,coef) VALUES(?,?,?,?,?)').run(S(req),level.id,seriesId,subject.id,coef); }})();
  res.json({ ok: true });
}));

/* ---------- Trimestres ---------- */
router.get('/terms', ah(async (req, res) => {
  if (isPostgres()) return res.json({ items: await db.many('SELECT * FROM terms WHERE school_id = $1 ORDER BY position', [S(req)]) });
  res.json({ items: db.prepare('SELECT * FROM terms WHERE school_id = ? ORDER BY position').all(S(req)) });
}));
router.post('/terms', ah(async (req, res) => {
  const name = str(req.body && req.body.name, 40); if (!name) throw bad('Nom obligatoire');
  if (isPostgres()) { const pos = await db.maybeOne('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM terms WHERE school_id = $1', [S(req)]); const r = await db.maybeOne("INSERT INTO terms (school_id, name, position, status) VALUES ($1,$2,$3,'upcoming') RETURNING id", [S(req), name, Number(pos.p)]); return res.status(201).json({ id: Number(r.id) }); }
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM terms WHERE school_id = ?').get(S(req)).p; const r = db.prepare("INSERT INTO terms (school_id, name, position, status) VALUES (?,?,?, 'upcoming')").run(S(req), name, pos); res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
router.post('/terms/:id/open', ah(async (req, res) => {
  if (isPostgres()) { const t = await mustAsync('terms', req.params.id, S(req), 'Période'); if (t.status !== 'upcoming') throw bad("Seule une période à venir peut être ouverte"); if (await db.maybeOne("SELECT 1 FROM terms WHERE school_id = $1 AND status = 'open'", [S(req)])) throw bad('Une période est déjà ouverte : clôturez-la d\'abord'); await db.execute("UPDATE terms SET status = 'open' WHERE id = $1", [t.id]); return res.json({ ok: true }); }
  const t = must('terms', req.params.id, S(req), 'Période'); if (t.status !== 'upcoming') throw bad("Seule une période à venir peut être ouverte"); if (db.prepare("SELECT 1 FROM terms WHERE school_id = ? AND status = 'open'").get(S(req))) throw bad('Une période est déjà ouverte : clôturez-la d\'abord'); db.prepare("UPDATE terms SET status = 'open' WHERE id = ?").run(t.id); res.json({ ok: true });
}));
router.post('/terms/:id/close', ah(async (req, res) => {
  if (isPostgres()) { const t = await mustAsync('terms', req.params.id, S(req), 'Période'); if (t.status !== 'open') throw bad('Seule la période en cours peut être clôturée'); let next = null; await db.withTransaction(async (tx) => { await tx.execute("UPDATE terms SET status = 'closed', closed_at = NOW() WHERE id = $1", [t.id]); next = await tx.maybeOne("SELECT * FROM terms WHERE school_id = $1 AND position > $2 AND status = 'upcoming' ORDER BY position LIMIT 1", [S(req), t.position]); if (next) await tx.execute("UPDATE terms SET status = 'open' WHERE id = $1", [next.id]); }); return res.json({ ok: true, next: next ? next.name : null }); }
  const t = must('terms', req.params.id, S(req), 'Période'); if (t.status !== 'open') throw bad('Seule la période en cours peut être clôturée'); let next = null; db.transaction(() => { db.prepare("UPDATE terms SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(t.id); next = db.prepare("SELECT * FROM terms WHERE school_id = ? AND position > ? AND status = 'upcoming' ORDER BY position LIMIT 1").get(S(req), t.position); if (next) db.prepare("UPDATE terms SET status = 'open' WHERE id = ?").run(next.id); })(); res.json({ ok: true, next: next ? next.name : null });
}));

/* ---------- Utilisateurs ---------- */
const ROLES = ['admin', 'teacher', 'student', 'parent'];

router.get('/users', ah(async (req, res) => {
  const role = str(req.query.role, 10); if (!ROLES.includes(role)) throw bad('Rôle invalide');
  const q = `%${str(req.query.q, 60).toLowerCase()}%`;
  if (isPostgres()) {
    const params = [S(req), role, q]; let extra = '';
    if (role === 'student' && intOrNull(req.query.class_id) !== null) { params.push(intOrNull(req.query.class_id)); extra = ` AND st.class_id = $${params.length}`; }
    const join = role === 'student' ? 'JOIN students st ON st.user_id = u.id JOIN classes c ON c.id = st.class_id' : '';
    const cols = role === 'student' ? ', st.id AS student_id, st.class_id, st.matricule, c.name AS class_name' : '';
    const users = await db.many(`SELECT u.id, u.username, u.email, u.phone, u.first_name, u.last_name, u.active, u.must_change_password${cols} FROM users u ${join} WHERE u.school_id = $1 AND u.role = $2 AND (lower(u.first_name || ' ' || u.last_name) LIKE $3 OR u.username LIKE $3 OR lower(coalesce(u.email,'')) LIKE $3)${extra} ORDER BY u.last_name, u.first_name LIMIT 500`, params);
    if (role === 'parent') { const kids = await db.many('SELECT ps.parent_id, st.id AS student_id, u.first_name, u.last_name FROM parent_students ps JOIN students st ON st.id = ps.student_id JOIN users u ON u.id = st.user_id WHERE st.school_id = $1', [S(req)]); users.forEach((p) => { p.children = kids.filter((k) => Number(k.parent_id) === Number(p.id)).map((k) => ({ id: k.student_id, name: `${k.first_name} ${k.last_name}` })); }); }
    if (role === 'teacher') { const counts = await db.many('SELECT teacher_id, COUNT(*) AS n FROM teaching_assignments WHERE school_id = $1 GROUP BY teacher_id', [S(req)]); users.forEach((t) => { t.assignments = Number((counts.find((c) => Number(c.teacher_id) === Number(t.id)) || { n: 0 }).n); }); }
    return res.json({ items: users });
  }
  const params = [S(req), role, q, q, q]; let where = "u.school_id = ? AND u.role = ? AND (lower(u.first_name || ' ' || u.last_name) LIKE ? OR u.username LIKE ? OR lower(IFNULL(u.email,'')) LIKE ?)"; let join = ''; let cols = '';
  if (role === 'student') { join = 'JOIN students st ON st.user_id = u.id JOIN classes c ON c.id = st.class_id'; cols = ', st.id AS student_id, st.class_id, st.matricule, c.name AS class_name'; const cid = intOrNull(req.query.class_id); if (cid !== null) { where += ' AND st.class_id = ?'; params.push(cid); } }
  const users = db.prepare(`SELECT u.id, u.username, u.email, u.phone, u.first_name, u.last_name, u.active, u.must_change_password${cols} FROM users u ${join} WHERE ${where} ORDER BY u.last_name, u.first_name LIMIT 500`).all(...params);
  if (role === 'parent') { const kids = db.prepare(`SELECT ps.parent_id, st.id AS student_id, u.first_name, u.last_name FROM parent_students ps JOIN students st ON st.id = ps.student_id JOIN users u ON u.id = st.user_id WHERE st.school_id = ?`).all(S(req)); users.forEach((p) => { p.children = kids.filter((k) => k.parent_id === p.id).map((k) => ({ id: k.student_id, name: `${k.first_name} ${k.last_name}` })); }); }
  if (role === 'teacher') { const counts = db.prepare('SELECT teacher_id, COUNT(*) n FROM teaching_assignments WHERE school_id = ? GROUP BY teacher_id').all(S(req)); users.forEach((t) => { t.assignments = (counts.find((c) => c.teacher_id === t.id) || { n: 0 }).n; }); }
  res.json({ items: users });
}));

router.post('/users', ah(async (req, res) => {
  const b = req.body || {}; if (!ROLES.includes(b.role)) throw bad('Rôle invalide');
  const username = normUsername(b.username); const first = str(b.first_name, 60); const last = str(b.last_name, 60); if (!first || !last) throw bad('Nom et prénom obligatoires');
  const email = normEmail(b.email); let cls = null;
  if (b.role === 'student') cls = isPostgres() ? await mustAsync('classes', b.class_id, S(req), 'Classe') : must('classes', b.class_id, S(req), 'Classe');
  let password = b.password; let generated = null; if (password) checkPassword(password); else { password = tempPassword(); generated = password; }
  const hash = await hashPassword(password);
  if (isPostgres()) {
    const id = await db.withTransaction(async (tx) => {
      const r = await tx.maybeOne(`INSERT INTO users (school_id, username, email, phone, password_hash, role, first_name, last_name, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [S(req), username, email, str(b.phone, 30) || null, hash, b.role, first, last, !!generated]);
      if (cls) await tx.execute('INSERT INTO students (school_id, user_id, class_id, matricule) VALUES ($1,$2,$3,$4)', [S(req), r.id, cls.id, str(b.matricule, 30)]);
      return Number(r.id);
    });
    return res.status(201).json({ id, username, temp_password: generated });
  }
  const id = db.transaction(() => { const r = db.prepare(`INSERT INTO users (school_id, username, email, phone, password_hash, role, first_name, last_name, must_change_password) VALUES (?,?,?,?,?,?,?,?,?)`).run(S(req), username, email, str(b.phone, 30) || null, hash, b.role, first, last, generated ? 1 : 0); const uid = Number(r.lastInsertRowid); if (cls) db.prepare('INSERT INTO students (school_id, user_id, class_id, matricule) VALUES (?,?,?,?)').run(S(req), uid, cls.id, str(b.matricule, 30)); return uid; })();
  res.status(201).json({ id, username, temp_password: generated });
}));

function targetUser(req) {
  const u = owned('users', req.params.id, S(req));
  if (!u || u.role === 'superadmin') throw notFound('Utilisateur introuvable');
  return u;
}

async function targetUserAsync(req) {
  const u = await db.maybeOne('SELECT * FROM users WHERE id = $1 AND school_id = $2', [intOrNull(req.params.id), S(req)]);
  if (!u || u.role === 'superadmin') throw notFound('Utilisateur introuvable');
  return u;
}

router.put('/users/:id', (req, res) => {
  const u = targetUser(req);
  const b = req.body || {};
  const first = str(b.first_name, 60);
  const last = str(b.last_name, 60);
  if (!first || !last) throw bad('Nom et prénom obligatoires');
  const email = normEmail(b.email);
  db.transaction(() => {
    db.prepare('UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?').run(first, last, email, str(b.phone, 30) || null, u.id);
    if (u.role === 'student') {
      const cls = must('classes', b.class_id, S(req), 'Classe');
      db.prepare('UPDATE students SET class_id = ?, matricule = ? WHERE user_id = ?').run(cls.id, str(b.matricule, 30), u.id);
    }
  })();
  res.json({ ok: true });
});

router.post('/users/:id/toggle', (req, res) => {
  const u = targetUser(req);
  if (u.id === req.user.id) throw bad('Vous ne pouvez pas désactiver votre propre compte');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(u.active ? 0 : 1, u.id);
  res.json({ active: !u.active });
});

router.post('/users/:id/reset-password', ah(async (req, res) => {
  const u = targetUser(req);
  const pwd = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(pwd), u.id);
  res.json({ username: u.username, temp_password: pwd });
}));

router.delete('/users/:id', ah(async (req, res) => {
  if (isPostgres()) {
    const u = await targetUserAsync(req);
    if (u.id === req.user.id) throw bad('Vous ne pouvez pas supprimer votre propre compte');
    if (u.role === 'admin') {
      const count = await db.maybeOne("SELECT COUNT(*) AS c FROM users WHERE school_id = $1 AND role = 'admin'", [S(req)]);
      if (Number(count.c) < 2) throw bad("Impossible de supprimer le seul administrateur de l'établissement");
    }
    await db.execute('DELETE FROM users WHERE id = $1', [u.id]);
    return res.json({ ok: true });
  }
  const u = targetUser(req);
  if (u.id === req.user.id) throw bad('Vous ne pouvez pas supprimer votre propre compte');
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE school_id = ? AND role = 'admin'").get(S(req)).c < 2) {
    throw bad("Impossible de supprimer le seul administrateur de l'établissement");
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // refusé (409) si l'élève a des notes/présences
  res.json({ ok: true });
}));

/* ---------- Routes PostgreSQL restantes ---------- */
if (isPostgres()) {
  router.put('/parents/:id/children', ah(async (req,res)=>{const p=await targetUserAsync(req);if(p.role!=='parent')throw bad("Ce compte n'est pas un parent");const ids=[...new Set((Array.isArray(req.body&&req.body.student_ids)?req.body.student_ids:[]).map(intOrNull).filter(x=>x!==null))];await db.transaction(async tx=>{await tx.execute('DELETE FROM parent_students WHERE parent_id=$1',[p.id]);for(const sid of ids){const st=await tx.maybeOne('SELECT id FROM students WHERE id=$1 AND school_id=$2',[sid,S(req)]);if(!st)throw bad('Élève introuvable');await tx.execute('INSERT INTO parent_students(parent_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[p.id,st.id]);}});res.json({ok:true});}));
  router.get('/teachers/:id/assignments', ah(async(req,res)=>{const t=await targetUserAsync(req);const items=await db.many('SELECT ta.class_id,ta.subject_id,c.name AS class_name,s.name AS subject_name FROM teaching_assignments ta JOIN classes c ON c.id=ta.class_id JOIN subjects s ON s.id=ta.subject_id WHERE ta.school_id=$1 AND ta.teacher_id=$2 ORDER BY c.name,s.name',[S(req),t.id]);res.json({items});}));
  router.put('/teachers/:id/assignments', ah(async(req,res)=>{const t=await targetUserAsync(req);if(t.role!=='teacher')throw bad("Ce compte n'est pas un professeur");const list=Array.isArray(req.body&&req.body.assignments)?req.body.assignments:[];await db.transaction(async tx=>{await tx.execute('DELETE FROM teaching_assignments WHERE teacher_id=$1 AND school_id=$2',[t.id,S(req)]);for(const a of list){const c=await tx.maybeOne('SELECT id FROM classes WHERE id=$1 AND school_id=$2',[intOrNull(a.class_id),S(req)]);const sub=await tx.maybeOne('SELECT id FROM subjects WHERE id=$1 AND school_id=$2',[intOrNull(a.subject_id),S(req)]);if(!c||!sub)throw bad('Classe ou matière introuvable');await tx.execute('INSERT INTO teaching_assignments(school_id,teacher_id,class_id,subject_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[S(req),t.id,c.id,sub.id]);}});res.json({ok:true});}));
  router.get('/discipline', ah(async(req,res)=>{const params=[S(req)];let where='d.school_id=$1';const cid=intOrNull(req.query.class_id);if(cid!==null){params.push(cid);where+=` AND d.class_id=$${params.length}`;}if(['positive','negative'].includes(req.query.kind)){params.push(req.query.kind);where+=` AND d.kind=$${params.length}`;}res.json({items:await db.many(`SELECT d.id,d.kind,d.description,d.date,c.name AS class_name,su.first_name||' '||su.last_name AS student_name,COALESCE(tu.first_name||' '||tu.last_name,'') AS teacher_name FROM discipline d JOIN students st ON st.id=d.student_id JOIN users su ON su.id=st.user_id JOIN classes c ON c.id=d.class_id LEFT JOIN users tu ON tu.id=d.recorded_by WHERE ${where} ORDER BY d.date DESC,d.id DESC LIMIT 300`,params)});}));
  router.get('/absences', ah(async(req,res)=>{const params=[S(req)];let where="a.school_id=$1 AND a.status <> 'present'";const cid=intOrNull(req.query.class_id);if(cid!==null){params.push(cid);where+=` AND a.class_id=$${params.length}`;}if(isDate(req.query.date)){params.push(req.query.date);where+=` AND a.date=$${params.length}`;}res.json({items:await db.many(`SELECT a.id,a.date,a.status,a.justified,c.name AS class_name,sub.name AS subject_name,su.first_name||' '||su.last_name AS student_name FROM attendance a JOIN students st ON st.id=a.student_id JOIN users su ON su.id=st.user_id JOIN classes c ON c.id=a.class_id JOIN subjects sub ON sub.id=a.subject_id WHERE ${where} ORDER BY a.date DESC,su.last_name LIMIT 300`,params)});}));
  router.get('/justifications', ah(async(req,res)=>{const status=['pending','approved','rejected'].includes(req.query.status)?req.query.status:'pending';res.json({items:await db.many(`SELECT j.id,j.reason,j.status,j.created_at,j.original_name,(j.file_name IS NOT NULL) AS has_file,a.date,a.status AS absence_status,sub.name AS subject_name,c.name AS class_name,su.first_name||' '||su.last_name AS student_name FROM justifications j JOIN attendance a ON a.id=j.attendance_id JOIN students st ON st.id=j.student_id JOIN users su ON su.id=st.user_id JOIN classes c ON c.id=a.class_id JOIN subjects sub ON sub.id=a.subject_id WHERE j.school_id=$1 AND j.status=$2 ORDER BY j.created_at DESC LIMIT 200`,[S(req),status])});}));
  router.post('/justifications/:id/review', ah(async(req,res)=>{const j=await db.maybeOne('SELECT * FROM justifications WHERE id=$1 AND school_id=$2',[intOrNull(req.params.id),S(req)]);if(!j)throw notFound('Justificatif introuvable');const decision=req.body&&req.body.decision;if(!['approved','rejected'].includes(decision))throw bad('Décision invalide');await db.transaction(async tx=>{await tx.execute("UPDATE justifications SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3",[decision,req.user.id,j.id]);await tx.execute('UPDATE attendance SET justified=$1 WHERE id=$2 AND school_id=$3',[decision==='approved',j.attendance_id,S(req)]);});res.json({ok:true});}));
  router.get('/settings', ah(async(req,res)=>{const s=await db.maybeOne('SELECT code,name,city,academic_year,parent_bulletin_min_avg,description,address,phone,contact_email,hours FROM schools WHERE id=$1',[S(req)]);res.json(s||{});}));
  router.put('/settings', ah(async(req,res)=>{const b=req.body||{},name=str(b.name,120);if(!name)throw bad("Le nom de l'établissement est obligatoire");const min=Number(b.parent_bulletin_min_avg);if(!(min>=0&&min<=20))throw bad('La moyenne minimale doit être comprise entre 0 et 20');await db.execute('UPDATE schools SET name=$1,city=$2,academic_year=$3,parent_bulletin_min_avg=$4,description=$5,address=$6,phone=$7,contact_email=$8,hours=$9 WHERE id=$10',[name,str(b.city,80),str(b.academic_year,20),min,typeof b.description==='string'?b.description.trim().slice(0,2000):'',str(b.address,200),str(b.phone,60),normEmail(b.contact_email)||'',str(b.hours,200),S(req)]);res.json({ok:true});}));
  router.get('/announcements', ah(async(req,res)=>{const items=await db.many('SELECT id,title,body,category,audience,event_date,pinned,created_at FROM announcements WHERE school_id=$1 ORDER BY pinned DESC,created_at DESC,id DESC LIMIT 200',[S(req)]);const imgs=await db.many('SELECT announcement_id,id,file_name,position FROM announcement_images WHERE school_id=$1 ORDER BY position,id',[S(req)]);items.forEach(a=>{a.images=imgs.filter(i=>Number(i.announcement_id)===Number(a.id));});res.json({items,max_images:MAX_IMAGES});}));
}

if (!isPostgres()) {
router.put('/parents/:id/children', (req, res) => {
  const p = targetUser(req);
  if (p.role !== 'parent') throw bad('Ce compte n\'est pas un parent');
  const ids = Array.isArray(req.body && req.body.student_ids) ? req.body.student_ids : [];
  db.transaction(() => {
    db.prepare('DELETE FROM parent_students WHERE parent_id = ?').run(p.id);
    for (const sid of [...new Set(ids.map(intOrNull).filter((x) => x !== null))]) {
      const st = must('students', sid, S(req), 'Élève');
      db.prepare('INSERT INTO parent_students (parent_id, student_id) VALUES (?,?)').run(p.id, st.id);
    }
  })();
  res.json({ ok: true });
});

router.get('/teachers/:id/assignments', (req, res) => {
  const t = targetUser(req);
  const items = db
    .prepare(
      `SELECT ta.class_id, ta.subject_id, c.name AS class_name, s.name AS subject_name
       FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
       WHERE ta.school_id = ? AND ta.teacher_id = ? ORDER BY c.name, s.name`
    )
    .all(S(req), t.id);
  res.json({ items });
});
router.put('/teachers/:id/assignments', (req, res) => {
  const t = targetUser(req);
  if (t.role !== 'teacher') throw bad("Ce compte n'est pas un professeur");
  const list = Array.isArray(req.body && req.body.assignments) ? req.body.assignments : [];
  db.transaction(() => {
    db.prepare('DELETE FROM teaching_assignments WHERE teacher_id = ? AND school_id = ?').run(t.id, S(req));
    for (const a of list) {
      const c = must('classes', a.class_id, S(req), 'Classe');
      const s = must('subjects', a.subject_id, S(req), 'Matière');
      db.prepare('INSERT OR IGNORE INTO teaching_assignments (school_id, teacher_id, class_id, subject_id) VALUES (?,?,?,?)').run(S(req), t.id, c.id, s.id);
    }
  })();
  res.json({ ok: true });
});

/* ---------- Suivi : discipline, absences, justificatifs ---------- */
router.get('/discipline', (req, res) => {
  const params = [S(req)];
  let where = 'd.school_id = ?';
  const cid = intOrNull(req.query.class_id);
  if (cid !== null) { where += ' AND d.class_id = ?'; params.push(cid); }
  if (['positive', 'negative'].includes(req.query.kind)) { where += ' AND d.kind = ?'; params.push(req.query.kind); }
  const items = db
    .prepare(
      `SELECT d.id, d.kind, d.description, d.date, c.name AS class_name,
        su.first_name || ' ' || su.last_name AS student_name,
        IFNULL(tu.first_name || ' ' || tu.last_name, '') AS teacher_name
       FROM discipline d
       JOIN students st ON st.id = d.student_id JOIN users su ON su.id = st.user_id
       JOIN classes c ON c.id = d.class_id LEFT JOIN users tu ON tu.id = d.recorded_by
       WHERE ${where} ORDER BY d.date DESC, d.id DESC LIMIT 300`
    )
    .all(...params);
  res.json({ items });
});

router.get('/absences', (req, res) => {
  const params = [S(req)];
  let where = "a.school_id = ? AND a.status != 'present'";
  const cid = intOrNull(req.query.class_id);
  if (cid !== null) { where += ' AND a.class_id = ?'; params.push(cid); }
  if (isDate(req.query.date)) { where += ' AND a.date = ?'; params.push(req.query.date); }
  const items = db
    .prepare(
      `SELECT a.id, a.date, a.status, a.justified, c.name AS class_name, sub.name AS subject_name,
        su.first_name || ' ' || su.last_name AS student_name
       FROM attendance a JOIN students st ON st.id = a.student_id JOIN users su ON su.id = st.user_id
       JOIN classes c ON c.id = a.class_id JOIN subjects sub ON sub.id = a.subject_id
       WHERE ${where} ORDER BY a.date DESC, su.last_name LIMIT 300`
    )
    .all(...params);
  res.json({ items });
});

router.get('/justifications', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const items = db
    .prepare(
      `SELECT j.id, j.reason, j.status, j.created_at, j.original_name, (j.file_name IS NOT NULL) AS has_file,
        a.date, a.status AS absence_status, sub.name AS subject_name, c.name AS class_name,
        su.first_name || ' ' || su.last_name AS student_name
       FROM justifications j JOIN attendance a ON a.id = j.attendance_id
       JOIN students st ON st.id = j.student_id JOIN users su ON su.id = st.user_id
       JOIN classes c ON c.id = a.class_id JOIN subjects sub ON sub.id = a.subject_id
       WHERE j.school_id = ? AND j.status = ? ORDER BY j.created_at DESC LIMIT 200`
    )
    .all(S(req), status);
  res.json({ items });
});
router.post('/justifications/:id/review', (req, res) => {
  const j = must('justifications', req.params.id, S(req), 'Justificatif');
  const decision = req.body && req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) throw bad('Décision invalide');
  db.transaction(() => {
    db.prepare("UPDATE justifications SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(decision, req.user.id, j.id);
    db.prepare('UPDATE attendance SET justified = ? WHERE id = ? AND school_id = ?').run(decision === 'approved' ? 1 : 0, j.attendance_id, S(req));
  })();
  res.json({ ok: true });
});

/* ---------- Actualités & événements (site vitrine) ---------- */
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;
function announcementBody(req) {
  const b = req.body || {};
  const title = str(b.title, 150);
  const body = typeof b.body === 'string' ? b.body.trim().slice(0, 5000) : '';
  if (!title) throw bad('Le titre est obligatoire');
  if (!body) throw bad('Le contenu est obligatoire');
  if (!['news', 'event', 'info'].includes(b.category)) throw bad('Catégorie invalide');
  if (!['public', 'members'].includes(b.audience)) throw bad('Visibilité invalide');
  let eventDate = null;
  if (b.event_date) { if (!isDate(b.event_date)) throw bad("Date de l'événement invalide"); eventDate = b.event_date; }
  return { title, body, category: b.category, audience: b.audience, event_date: eventDate, pinned: truthy(b.pinned) ? 1 : 0 };
}
router.get('/announcements', (req, res) => {
  res.json({ items: attachImages(db.prepare(
    `SELECT id, title, body, category, audience, event_date, pinned, created_at FROM announcements
     WHERE school_id = ? ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 200`).all(S(req))), max_images: MAX_IMAGES });
});

const uploadImages = makeUploader(['.jpg', '.jpeg', '.png', '.webp'], 5, MAX_IMAGES);
const idList = (v) => {
  let arr = v;
  if (typeof v === 'string' && v) { try { arr = JSON.parse(v); } catch (e) { arr = []; } }
  return Array.isArray(arr) ? arr.map(intOrNull).filter((x) => x !== null) : [];
};
const insertImage = (schoolId, annId, file, position) =>
  db.prepare('INSERT INTO announcement_images (school_id, announcement_id, file_name, position) VALUES (?,?,?,?)').run(schoolId, annId, file.filename, position);
if (isPostgres()) {
  router.post('/announcements', uploadImages.array('images', MAX_IMAGES), ah(async(req,res)=>{const files=req.files||[];try{const a=announcementBody(req);files.forEach(verifyFile);if(files.length>MAX_IMAGES)throw bad(`${MAX_IMAGES} images maximum par publication`);const id=await db.transaction(async tx=>{const r=await tx.maybeOne('INSERT INTO announcements(school_id,title,body,category,audience,event_date,pinned,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[S(req),a.title,a.body,a.category,a.audience,a.event_date,a.pinned===1,req.user.id]);for(let i=0;i<files.length;i++){if(storageEnabled())await persistFile(S(req),files[i]);await tx.execute('INSERT INTO announcement_images(school_id,announcement_id,file_name,position) VALUES($1,$2,$3,$4)',[S(req),r.id,files[i].filename,i]);}return Number(r.id);});res.status(201).json({id,stored:storageEnabled()});}catch(e){for(const f of files){removeFile(S(req),f.filename);if(storageEnabled())await removeStoredFile(S(req),f.filename).catch(()=>{});}throw e;}}));
  router.put('/announcements/:id', uploadImages.array('images', MAX_IMAGES), ah(async(req,res)=>{const files=req.files||[];try{const row=await db.maybeOne('SELECT * FROM announcements WHERE id=$1 AND school_id=$2',[intOrNull(req.params.id),S(req)]);if(!row)throw notFound('Annonce introuvable');const a=announcementBody(req);const existing=await db.many('SELECT id,file_name,position FROM announcement_images WHERE announcement_id=$1 AND school_id=$2 ORDER BY position,id',[row.id,S(req)]);const removeIds=new Set(idList(req.body&&req.body.remove_images));const removed=existing.filter(x=>removeIds.has(Number(x.id)));if(existing.length-removed.length+files.length>MAX_IMAGES)throw bad(`${MAX_IMAGES} images maximum par publication`);files.forEach(verifyFile);await db.transaction(async tx=>{await tx.execute('UPDATE announcements SET title=$1,body=$2,category=$3,audience=$4,event_date=$5,pinned=$6,updated_at=NOW() WHERE id=$7',[a.title,a.body,a.category,a.audience,a.event_date,a.pinned===1,row.id]);for(const old of removed){await tx.execute('DELETE FROM announcement_images WHERE id=$1',[old.id]);if(storageEnabled())await removeStoredFile(S(req),old.file_name);}const last=existing.reduce((m,x)=>Math.max(m,Number(x.position)),-1);for(let i=0;i<files.length;i++){if(storageEnabled())await persistFile(S(req),files[i]);await tx.execute('INSERT INTO announcement_images(school_id,announcement_id,file_name,position) VALUES($1,$2,$3,$4)',[S(req),row.id,files[i].filename,last+1+i]);}});files.forEach(f=>removeFile(S(req),f.filename));res.json({ok:true});}catch(e){files.forEach(f=>removeFile(S(req),f.filename));throw e;}}));
  router.delete('/announcements/:id',ah(async(req,res)=>{const row=await db.maybeOne('SELECT id FROM announcements WHERE id=$1 AND school_id=$2',[intOrNull(req.params.id),S(req)]);if(!row)throw notFound('Annonce introuvable');const imgs=await db.many('SELECT file_name FROM announcement_images WHERE announcement_id=$1 AND school_id=$2',[row.id,S(req)]);await db.execute('DELETE FROM announcements WHERE id=$1',[row.id]);for(const i of imgs){if(storageEnabled())await removeStoredFile(S(req),i.file_name);removeFile(S(req),i.file_name);}res.json({ok:true});}));
}


router.post('/announcements', uploadImages.array('images', MAX_IMAGES), (req, res) => {
  const files = req.files || [];
  try {
    const a = announcementBody(req);
    files.forEach(verifyFile);
    const id = db.transaction(() => {
      const r = db.prepare('INSERT INTO announcements (school_id, title, body, category, audience, event_date, pinned, author_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(S(req), a.title, a.body, a.category, a.audience, a.event_date, a.pinned, req.user.id);
      const annId = Number(r.lastInsertRowid);
      files.forEach((f, i) => insertImage(S(req), annId, f, i));
      return annId;
    })();
    res.status(201).json({ id });
  } catch (e) {
    files.forEach((f) => removeFile(S(req), f.filename)); // aucun fichier orphelin si la publication est refusée
    throw e;
  }
});

router.put('/announcements/:id', uploadImages.array('images', MAX_IMAGES), (req, res) => {
  const files = req.files || [];
  try {
    const row = must('announcements', req.params.id, S(req), 'Annonce');
    const a = announcementBody(req);
    const existing = db.prepare('SELECT id, file_name, position FROM announcement_images WHERE announcement_id = ? AND school_id = ? ORDER BY position, id').all(row.id, S(req));
    const removeIds = new Set(idList(req.body && req.body.remove_images));
    const toRemove = existing.filter((i) => removeIds.has(i.id));
    if (existing.length - toRemove.length + files.length > MAX_IMAGES) throw bad(`${MAX_IMAGES} images maximum par publication`);
    files.forEach(verifyFile);
    db.transaction(() => {
      db.prepare("UPDATE announcements SET title = ?, body = ?, category = ?, audience = ?, event_date = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?")
        .run(a.title, a.body, a.category, a.audience, a.event_date, a.pinned, row.id);
      toRemove.forEach((i) => db.prepare('DELETE FROM announcement_images WHERE id = ?').run(i.id));
      const last = existing.reduce((m, i) => Math.max(m, i.position), -1);
      files.forEach((f, i) => insertImage(S(req), row.id, f, last + 1 + i));
    })();
    toRemove.forEach((i) => removeFile(S(req), i.file_name)); // fichiers retirés du disque après validation
    res.json({ ok: true });
  } catch (e) {
    files.forEach((f) => removeFile(S(req), f.filename));
    throw e;
  }
});

router.delete('/announcements/:id', (req, res) => {
  const row = must('announcements', req.params.id, S(req), 'Annonce');
  const imgs = db.prepare('SELECT file_name FROM announcement_images WHERE announcement_id = ? AND school_id = ?').all(row.id, S(req));
  db.prepare('DELETE FROM announcements WHERE id = ?').run(row.id); // les lignes d'images partent en cascade
  imgs.forEach((i) => removeFile(S(req), i.file_name));
  res.json({ ok: true });
});

/* ---------- Paramètres de l'établissement ---------- */
router.get('/settings', (req, res) => {
  const s = req.school;
  res.json({
    code: s.code, name: s.name, city: s.city, academic_year: s.academic_year, parent_bulletin_min_avg: s.parent_bulletin_min_avg,
    description: s.description, address: s.address, phone: s.phone, contact_email: s.contact_email, hours: s.hours,
  });
});
router.put('/settings', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 120);
  if (!name) throw bad("Le nom de l'établissement est obligatoire");
  const min = Number(b.parent_bulletin_min_avg);
  if (!(min >= 0 && min <= 20)) throw bad('La moyenne minimale doit être comprise entre 0 et 20');
  const email = normEmail(b.contact_email) || '';
  db.prepare('UPDATE schools SET name = ?, city = ?, academic_year = ?, parent_bulletin_min_avg = ?, description = ?, address = ?, phone = ?, contact_email = ?, hours = ? WHERE id = ?')
    .run(name, str(b.city, 80), str(b.academic_year, 20), min, typeof b.description === 'string' ? b.description.trim().slice(0, 2000) : '', str(b.address, 200), str(b.phone, 60), email, str(b.hours, 200), S(req));
  res.json({ ok: true });
});

}

module.exports = router;
