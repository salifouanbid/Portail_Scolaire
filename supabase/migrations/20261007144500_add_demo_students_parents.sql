
INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'parent1', 'parent1@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'parent', 'Parent', '1', true, false WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id=1 AND username='parent1');
INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'parent2', 'parent2@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'parent', 'Parent', '2', true, false WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id=1 AND username='parent2');
INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'parent3', 'parent3@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'parent', 'Parent', '3', true, false WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id=1 AND username='parent3');
INSERT INTO public.users (school_id, username, email, password_hash, role, first_name, last_name, active, must_change_password)
SELECT 1, 'parent4', 'parent4@saphir.demo', '$2b$10$1H4QukBQOOPsC26UAVvW/.a86p1BItBSR9p0pIdZaewbJSnbTO.ZS', 'parent', 'Parent', '4', true, false WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE school_id=1 AND username='parent4');

INSERT INTO public.parent_students(parent_id,student_id)
SELECT p.id,s.id FROM public.users p, public.students s WHERE p.school_id=1 AND p.username='parent1' AND s.school_id=1 AND s.matricule IN ('M2026001','M2026002') ON CONFLICT DO NOTHING;
INSERT INTO public.parent_students(parent_id,student_id)
SELECT p.id,s.id FROM public.users p, public.students s WHERE p.school_id=1 AND p.username='parent2' AND s.school_id=1 AND s.matricule IN ('M2026003','M2026004') ON CONFLICT DO NOTHING;
INSERT INTO public.parent_students(parent_id,student_id)
SELECT p.id,s.id FROM public.users p, public.students s WHERE p.school_id=1 AND p.username='parent3' AND s.school_id=1 AND s.matricule IN ('M2026005','M2026006') ON CONFLICT DO NOTHING;
INSERT INTO public.parent_students(parent_id,student_id)
SELECT p.id,s.id FROM public.users p, public.students s WHERE p.school_id=1 AND p.username='parent4' AND s.school_id=1 AND s.matricule='M2026001' ON CONFLICT DO NOTHING;
