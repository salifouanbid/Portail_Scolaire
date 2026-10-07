INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'prof.maths', 'prof.maths@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'teacher', 'Professeur', 'Mathématiques', true, false
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id = 1 AND username = 'prof.maths');

INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'prof.physique', 'prof.physique@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'teacher', 'Professeur', 'Physique', true, false
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id = 1 AND username = 'prof.physique');

INSERT INTO public.teaching_assignments (school_id, teacher_id, class_id, subject_id)
SELECT 1, u.id, 1, 1 FROM public.users u
WHERE u.school_id = 1 AND u.username = 'prof.maths'
  AND NOT EXISTS (SELECT 1 FROM public.teaching_assignments a WHERE a.teacher_id=u.id AND a.class_id=1 AND a.subject_id=1);

INSERT INTO public.teaching_assignments (school_id, teacher_id, class_id, subject_id)
SELECT 1, u.id, 1, 2 FROM public.users u
WHERE u.school_id = 1 AND u.username = 'prof.physique'
  AND NOT EXISTS (SELECT 1 FROM public.teaching_assignments a WHERE a.teacher_id=u.id AND a.class_id=1 AND a.subject_id=2);
