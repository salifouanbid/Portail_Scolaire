// Vues communes ÉLÈVE / PARENT : les deux espaces affichent la même information sur un élève.
// Le routeur reçoit une fonction "resolve" qui donne l'id de l'élève AUTORISÉ pour l'utilisateur connecté.
const express = require('express');
const db = require('../db');
const { bad, notFound, intOrNull, ah } = require('../services/util');
const config = require('../config');
const isPostgres = () => config.databaseProvider === 'postgres';
const { buildReport, evolution } = require('../services/reports');
const { streamBulletin } = require('../services/pdf');
const reportsPg = require('../services/reportsPg');

function studentViews(resolve) {
  const r = express.Router({ mergeParams: true });
  r.use(async (req, res, next) => {
    try { const sid = await resolve(req); if (!sid) return res.status(404).json({ error: 'Élève introuvable' }); req.studentId = sid; next(); } catch (e) { next(e); }
  });

  const S = (req) => req.user.school_id;
  const visibleTerms = (req) =>
    db.prepare("SELECT id, name, status FROM terms WHERE school_id = ? AND status != 'upcoming' ORDER BY position").all(S(req));
  function pickTerm(req, terms) {
    const wanted = intOrNull(req.query.term_id);
    return terms.find((t) => t.id === wanted) || terms.find((t) => t.status === 'open') || terms[terms.length - 1] || null;
  }
  const lang = (req) => (req.query.lang === 'en' ? 'en' : 'fr');

  if (!isPostgres()) {
  r.get('/dashboard', (req, res) => {
    const terms = visibleTerms(req);
    const term = pickTerm(req, terms);
    const info = db
      .prepare(
        `SELECT s.id, s.matricule, u.first_name, u.last_name, c.name AS class_name
         FROM students s JOIN users u ON u.id = s.user_id JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND s.school_id = ?`
      )
      .get(req.studentId, S(req));
    if (!term) return res.json({ student: info, terms, term: null, report: null, evolution: [] });
    res.json({
      student: info,
      terms,
      term,
      report: buildReport(S(req), req.studentId, term.id, lang(req)),
      evolution: evolution(S(req), req.studentId),
      bulletin_min_avg: req.user.role === 'parent' ? req.school.parent_bulletin_min_avg : null,
    });
  });

  r.get('/bulletin.pdf', (req, res) => {
    const term = pickTerm(req, visibleTerms(req));
    if (!term) throw bad('Aucune période disponible');
    const report = buildReport(S(req), req.studentId, term.id, lang(req));
    if (!report) throw notFound();
    if (req.user.role === 'parent') {
      const min = req.school.parent_bulletin_min_avg;
      if (report.general === null || report.general < min) {
        const e = new Error(`Le bulletin est réservé aux élèves ayant au moins ${min}/20 de moyenne`);
        e.status = 403;
        throw e;
      }
    }
    streamBulletin(res, { school: req.school, report, lang: lang(req) });
  });

  r.get('/attendance', (req, res) => {
    const items = db
      .prepare(
        `SELECT a.id, a.date, a.status, a.justified, sub.name AS subject_name,
          (SELECT j.id FROM justifications j WHERE j.attendance_id = a.id ORDER BY j.id DESC LIMIT 1) AS justification_id,
          (SELECT j.status FROM justifications j WHERE j.attendance_id = a.id ORDER BY j.id DESC LIMIT 1) AS justification_status
         FROM attendance a JOIN subjects sub ON sub.id = a.subject_id
         WHERE a.school_id = ? AND a.student_id = ? AND a.status != 'present' ORDER BY a.date DESC, a.id DESC LIMIT 200`
      )
      .all(S(req), req.studentId);
    const total = db.prepare('SELECT COUNT(*) c FROM attendance WHERE school_id = ? AND student_id = ?').get(S(req), req.studentId).c;
    res.json({ items, total_recorded: total });
  });

  r.get('/programme', (req, res) => {
    const st = db.prepare('SELECT class_id FROM students WHERE id = ? AND school_id = ?').get(req.studentId, S(req));
    const chapters = db
      .prepare(
        `SELECT ch.id, ch.title, ch.status, sub.name AS subject_name FROM chapters ch JOIN subjects sub ON sub.id = ch.subject_id
         WHERE ch.school_id = ? AND ch.class_id = ? ORDER BY sub.name, ch.position, ch.id`
      )
      .all(S(req), st.class_id);
    const lessons = db
      .prepare(
        `SELECT l.id, l.date, l.content, l.homework, sub.name AS subject_name FROM lessons l JOIN subjects sub ON sub.id = l.subject_id
         WHERE l.school_id = ? AND l.class_id = ? ORDER BY l.date DESC, l.id DESC LIMIT 40`
      )
      .all(S(req), st.class_id);
    res.json({ chapters, lessons });
  });

  r.get('/archives', (req, res) => {
    const st = db.prepare('SELECT class_id FROM students WHERE id = ? AND school_id = ?').get(req.studentId, S(req));
    const params = [S(req), st.class_id];
    let where = 'a.school_id = ? AND a.class_id = ?';
    const sub = intOrNull(req.query.subject_id);
    if (sub !== null) { where += ' AND a.subject_id = ?'; params.push(sub); }
    const items = db
      .prepare(
        `SELECT a.id, a.title, a.original_name, a.size, a.created_at, sub.id AS subject_id, sub.name AS subject_name
         FROM archives a JOIN subjects sub ON sub.id = a.subject_id WHERE ${where} ORDER BY a.created_at DESC`
      )
      .all(...params);
    const subjects = db
      .prepare('SELECT DISTINCT sub.id, sub.name FROM archives a JOIN subjects sub ON sub.id = a.subject_id WHERE a.school_id = ? AND a.class_id = ? ORDER BY sub.name')
      .all(S(req), st.class_id);
    res.json({ items, subjects });
  });
  }

  if (isPostgres()) {
    r.get('/dashboard', ah(async (req, res) => {
      const terms = await db.many("SELECT id,name,status FROM terms WHERE school_id=$1 AND status!='upcoming' ORDER BY position", [S(req)]);
      const wanted = intOrNull(req.query.term_id);
      const term = terms.find((t) => Number(t.id) === wanted) || terms.find((t) => t.status === 'open') || terms[terms.length - 1] || null;
      const student = await db.maybeOne('SELECT s.id,s.matricule,u.first_name,u.last_name,c.name AS class_name FROM students s JOIN users u ON u.id=s.user_id JOIN classes c ON c.id=s.class_id WHERE s.id=$1 AND s.school_id=$2', [req.studentId, S(req)]);
      if (!term) return res.json({ student, terms, term: null, report: null, evolution: [] });
      // Même format qu'en SQLite (report + evolution) : moyennes pondérées, rang, moyenne de classe.
      const [report, evo] = await Promise.all([
        reportsPg.buildReport(S(req), req.studentId, term.id, lang(req)),
        reportsPg.evolution(S(req), req.studentId),
      ]);
      res.json({ student, terms, term, report, evolution: evo, bulletin_min_avg: req.user.role === 'parent' ? req.school.parent_bulletin_min_avg : null });
    }));
    r.get('/bulletin.pdf', ah(async (req, res) => {
      const terms = await db.many("SELECT id,name,status FROM terms WHERE school_id=$1 AND status!='upcoming' ORDER BY position", [S(req)]);
      const wanted = intOrNull(req.query.term_id);
      const term = terms.find((t) => Number(t.id) === wanted) || terms.find((t) => t.status === 'open') || terms[terms.length - 1] || null;
      if (!term) throw bad('Aucune période disponible');
      const report = await reportsPg.buildReport(S(req), req.studentId, term.id, lang(req));
      if (!report) throw notFound();
      if (req.user.role === 'parent') {
        const min = req.school.parent_bulletin_min_avg;
        if (report.general === null || report.general < min) {
          const e = new Error(`Le bulletin est réservé aux élèves ayant au moins ${min}/20 de moyenne`);
          e.status = 403;
          throw e;
        }
      }
      streamBulletin(res, { school: req.school, report, lang: lang(req) });
    }));
    r.get('/attendance',ah(async(req,res)=>{const items=await db.many(`SELECT a.id,a.date,a.status,a.justified,sub.name AS subject_name,(SELECT j.id FROM justifications j WHERE j.attendance_id=a.id ORDER BY j.id DESC LIMIT 1) AS justification_id,(SELECT j.status FROM justifications j WHERE j.attendance_id=a.id ORDER BY j.id DESC LIMIT 1) AS justification_status FROM attendance a JOIN subjects sub ON sub.id=a.subject_id WHERE a.school_id=$1 AND a.student_id=$2 AND a.status!='present' ORDER BY a.date DESC,a.id DESC LIMIT 200`,[S(req),req.studentId]);const total=await db.maybeOne('SELECT COUNT(*) AS c FROM attendance WHERE school_id=$1 AND student_id=$2',[S(req),req.studentId]);res.json({items,total_recorded:Number(total.c)});}));
    r.get('/programme',ah(async(req,res)=>{const st=await db.maybeOne('SELECT class_id FROM students WHERE id=$1 AND school_id=$2',[req.studentId,S(req)]);const chapters=await db.many('SELECT ch.id,ch.title,ch.status,sub.name AS subject_name FROM chapters ch JOIN subjects sub ON sub.id=ch.subject_id WHERE ch.school_id=$1 AND ch.class_id=$2 ORDER BY sub.name,ch.position,ch.id',[S(req),st.class_id]);const lessons=await db.many('SELECT l.id,l.date,l.content,l.homework,sub.name AS subject_name FROM lessons l JOIN subjects sub ON sub.id=l.subject_id WHERE l.school_id=$1 AND l.class_id=$2 ORDER BY l.date DESC,l.id DESC LIMIT 40',[S(req),st.class_id]);res.json({chapters,lessons});}));
    r.get('/archives',ah(async(req,res)=>{const st=await db.maybeOne('SELECT class_id FROM students WHERE id=$1 AND school_id=$2',[req.studentId,S(req)]);const params=[S(req),st.class_id];let where='a.school_id=$1 AND a.class_id=$2';const sub=intOrNull(req.query.subject_id);if(sub!==null){params.push(sub);where+=` AND a.subject_id=$${params.length}`;}const items=await db.many(`SELECT a.id,a.title,a.original_name,a.size,a.created_at,sub.id AS subject_id,sub.name AS subject_name FROM archives a JOIN subjects sub ON sub.id=a.subject_id WHERE ${where} ORDER BY a.created_at DESC`,params);const subjects=await db.many('SELECT DISTINCT sub.id,sub.name FROM archives a JOIN subjects sub ON sub.id=a.subject_id WHERE a.school_id=$1 AND a.class_id=$2 ORDER BY sub.name',[S(req),st.class_id]);res.json({items,subjects});}));
  }
  return r;
}

module.exports = studentViews;
