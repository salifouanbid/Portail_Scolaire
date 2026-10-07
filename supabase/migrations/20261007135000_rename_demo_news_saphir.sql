UPDATE public.announcements
SET title = replace(replace(title, 'Collège Jean Piaget', 'Saphir'), 'Jean Piaget', 'Saphir'),
    body = replace(replace(body, 'Collège Jean Piaget', 'Saphir'), 'Jean Piaget', 'Saphir'),
    updated_at = now()
WHERE id = 1
  AND school_id = 1;
