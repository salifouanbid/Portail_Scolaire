const express = require('express');
const db = require('../db');
const studentViews = require('./studentViews');
const { getPreferences, setPreferences } = require('../services/notifications');
const { bad, str, intOrNull, ah } = require('../services/util');
const config = require('../config');
const isPostgres = () => config.databaseProvider === 'postgres';
const { makeUploader, verifyFile, removeFile } = require('../services/upload');
const { persistFile, removeStoredFile, storageEnabled } = require('../services/storage');

const router = express.Router();
router.get('/notifications/preferences', ah(async (req,res)=>res.json(await getPreferences(req.user.id))));
router.put('/notifications/preferences', ah(async (req,res)=>{ const b=req.body||{}; res.json(await setPreferences(req.user.id,{ whatsapp_enabled:b.whatsapp_enabled, email_enabled:b.email_enabled })); }));

// Un parent ne voit QUE les enfants rattachés à son compte (vérifié à chaque requête).
async function linkedStudent(req) {
  if (isPostgres()) { const row=await db.maybeOne('SELECT s.id FROM parent_students ps JOIN students s ON s.id=ps.student_id WHERE ps.parent_id=$1 AND s.id=$2 AND s.school_id=$3',[req.user.id,intOrNull(req.params.studentId),req.user.school_id]); return row?row.id:null; }
  const sid=intOrNull(req.params.studentId); if(sid===null)return null; const row=db.prepare(`SELECT s.id FROM parent_students ps JOIN students s ON s.id=ps.student_id WHERE ps.parent_id=? AND s.id=? AND s.school_id=?`).get(req.user.id,sid,req.user.school_id); return row?row.id:null;
}

router.get('/children', ah(async (req, res) => {
  if (isPostgres()) return res.json({items:await db.many('SELECT s.id,s.matricule,u.first_name,u.last_name,u.active,c.name AS class_name FROM parent_students ps JOIN students s ON s.id=ps.student_id JOIN users u ON u.id=s.user_id JOIN classes c ON c.id=s.class_id WHERE ps.parent_id=$1 AND s.school_id=$2 ORDER BY u.first_name',[req.user.id,req.user.school_id])});
  const items = db
    .prepare(
      `SELECT s.id, s.matricule, u.first_name, u.last_name, u.active, c.name AS class_name
       FROM parent_students ps JOIN students s ON s.id = ps.student_id JOIN users u ON u.id = s.user_id JOIN classes c ON c.id = s.class_id
       WHERE ps.parent_id = ? AND s.school_id = ? ORDER BY u.first_name`
    )
    .all(req.user.id, req.user.school_id);
  res.json({ items });
}));

router.use('/children/:studentId', studentViews(linkedStudent));

const uploadProof = makeUploader(['.pdf', '.png', '.jpg', '.jpeg'], 5);
if (isPostgres()) {
  router.post('/children/:studentId/justifications', uploadProof.single('file'), ah(async(req,res)=>{const file=req.file;try{const sid=await linkedStudent(req);const att=await db.maybeOne('SELECT * FROM attendance WHERE id=$1 AND student_id=$2 AND school_id=$3',[intOrNull(req.body.attendance_id),sid,req.user.school_id]);if(!att||att.status!=='absent')throw bad('Absence introuvable');if(att.justified)throw bad('Cette absence est déjà justifiée');const last=await db.maybeOne('SELECT status FROM justifications WHERE attendance_id=$1 ORDER BY id DESC LIMIT 1',[att.id]);if(last&&(last.status==='pending'||last.status==='approved'))throw bad('Un justificatif existe déjà pour cette absence');const reason=str(req.body.reason,500);if(!reason)throw bad('Le motif est obligatoire');if(file)verifyFile(file);if(file&&storageEnabled())await persistFile(req.user.school_id,file);const r=await db.maybeOne('INSERT INTO justifications(school_id,attendance_id,student_id,submitted_by,reason,file_name,original_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[req.user.school_id,att.id,sid,req.user.id,reason,file?file.filename:null,file?str(file.originalname,200):null]);res.status(201).json({id:Number(r.id),stored:!!file&&storageEnabled()});}catch(e){if(file){removeFile(req.user.school_id,file.filename);if(storageEnabled())await removeStoredFile(req.user.school_id,file.filename).catch(()=>{});}throw e;}}));
}


if (!isPostgres()) {
// Envoi d'un justificatif d'absence (fichier facultatif)
router.post('/children/:studentId/justifications', uploadProof.single('file'), (req, res) => {
  const file = req.file;
  try {
    const sid = linkedStudent(req);
    const att = db
      .prepare('SELECT * FROM attendance WHERE id = ? AND student_id = ? AND school_id = ?')
      .get(intOrNull(req.body.attendance_id), sid, req.user.school_id);
    if (!att || att.status !== 'absent') throw bad('Absence introuvable');
    if (att.justified) throw bad('Cette absence est déjà justifiée');
    const last = db.prepare('SELECT status FROM justifications WHERE attendance_id = ? ORDER BY id DESC LIMIT 1').get(att.id);
    if (last && (last.status === 'pending' || last.status === 'approved')) throw bad('Un justificatif existe déjà pour cette absence');
    const reason = str(req.body.reason, 500);
    if (!reason) throw bad('Le motif est obligatoire');
    if (file) verifyFile(file);
    const r = db
      .prepare('INSERT INTO justifications (school_id, attendance_id, student_id, submitted_by, reason, file_name, original_name) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.school_id, att.id, sid, req.user.id, reason, file ? file.filename : null, file ? str(file.originalname, 200) : null);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (file) removeFile(req.user.school_id, file.filename);
    throw e;
  }
});

}

module.exports = router;
