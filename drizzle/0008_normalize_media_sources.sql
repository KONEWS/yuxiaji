UPDATE `user_subjects` SET `source` = CASE WHEN `subject_id` IS NOT NULL THEN 'bangumi' ELSE 'manual' END WHERE `source` IS NULL OR `source` NOT IN ('bangumi', 'manual', 'local');
