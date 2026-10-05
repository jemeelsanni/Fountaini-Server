-- NotificationType.EMAIL_CHANGED — sent to the OLD address when
-- PATCH /api/users/:id/email changes it (see updateUserEmail,
-- users.service.ts). ALTER TYPE ... ADD VALUE is transactional as of
-- Postgres 12, so this is safe as a single statement.
ALTER TYPE "NotificationType" ADD VALUE 'EMAIL_CHANGED';
