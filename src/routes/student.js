const express = require('express');
const db = require('../db');
const studentViews = require('./studentViews');

const router = express.Router();

router.use(studentViews(async (req) => {
  if (db.driver === 'postgres') { const st = await db.maybeOne('SELECT id FROM students WHERE user_id=$1 AND school_id=$2',[req.user.id,req.user.school_id]); return st ? st.id : null; }
  const st = db.prepare('SELECT id FROM students WHERE user_id = ? AND school_id = ?').get(req.user.id, req.user.school_id);
  return st ? st.id : null;
}));

module.exports = router;
