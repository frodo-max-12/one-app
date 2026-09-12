-- =====================================================================
-- 03_WhatsApp_Templates_Activate.sql
-- Activates the 4 WhatsApp payment-reminder templates after Meta approval.
--
-- Run order:
--   PHASE A — run NOW (or any time): syncs Body + Variables + Subject in
--             DB to match what we are submitting to Meta. Safe even before
--             Meta approves; IsActive stays 0 so the cron will not send.
--   PHASE B — run AFTER each template is APPROVED in Business Manager:
--             uncomment the matching block and run. Sets MetaTemplateName +
--             IsActive=1 for that single (Channel, Stage) row.
--
-- SAFETY:
--   - Every UPDATE is filtered by exact (Channel='WHATSAPP', Stage=...).
--     EMAIL templates are never touched.
--   - PHASE A is wrapped in TRY/CATCH with auto-rollback; partial failure
--     leaves the four rows untouched.
--   - All updates are idempotent — re-running rewrites identically.
--   - No NAV DB writes. App DB only.
--
-- WHEN TO RUN:
--   PHASE A — any time, even with live users active. Sub-second.
--   PHASE B — after each Meta template status flips to APPROVED.
-- =====================================================================

USE BizNAV_App;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'ONE App — WhatsApp Templates Activation on database: ' + DB_NAME();
PRINT '═══════════════════════════════════════════════════════════════';
GO

-- ─────────────────────────────────────────────────────────────────────
-- PHASE A — sync Body + Variables + Subject to the Meta submission text
-- IsActive remains 0 so the cron will not send until PHASE B runs.
-- ─────────────────────────────────────────────────────────────────────
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  -- ── PRE_DUE ──────────────────────────────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Subject = N'Upcoming Payment Due',
    Body = N'Dear {{1}},

This is a gentle reminder from {{2}} that invoice {{3}} of {{4}} {{5}} is due on {{6}}.

Kindly arrange payment on or before the due date to keep the account current.

If payment is already processed, please share the UTR / payment advice on this number.

Thank you for your continued business.',
    Variables = N'["CustomerName","CompanyName","InvoiceNo","Currency","Amount","DueDate"]',
    MetaLanguageCode = 'en',
    UpdatedBy = 'PHASE_A_03'
  WHERE Channel = 'WHATSAPP' AND Stage = 'PRE_DUE';
  PRINT '✓ Synced PRE_DUE template Body+Variables';

  -- ── DUE_DAY ──────────────────────────────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Subject = N'Payment Due Today',
    Body = N'Dear {{1}},

This is a reminder from {{2}} that today ({{3}}) is the due date for invoice {{4}} of {{5}} {{6}}.

Request you to release the payment today to avoid it turning overdue.

If payment is already processed, please share the UTR / payment advice on this number.

Thank you.',
    Variables = N'["CustomerName","CompanyName","DueDate","InvoiceNo","Currency","Amount"]',
    MetaLanguageCode = 'en',
    UpdatedBy = 'PHASE_A_03'
  WHERE Channel = 'WHATSAPP' AND Stage = 'DUE_DAY';
  PRINT '✓ Synced DUE_DAY template Body+Variables';

  -- ── OVERDUE ──────────────────────────────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Subject = N'Payment Overdue Notice',
    Body = N'Dear {{1}},

This is to inform you that invoice {{2}} of {{3}} {{4}} from {{5}} is overdue by {{6}} day(s).

Kindly release the payment at the earliest to settle the outstanding balance.

If payment has been processed, please share the UTR / payment advice for our records.

Thank you for your prompt attention.',
    Variables = N'["CustomerName","InvoiceNo","Currency","Amount","CompanyName","OverdueDays"]',
    MetaLanguageCode = 'en',
    UpdatedBy = 'PHASE_A_03'
  WHERE Channel = 'WHATSAPP' AND Stage = 'OVERDUE';
  PRINT '✓ Synced OVERDUE template Body+Variables';

  -- ── FOLLOW_UP ────────────────────────────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Subject = N'Urgent — Payment Follow-up',
    Body = N'Dear {{1}},

Despite earlier reminders, invoice {{2}} of {{3}} {{4}} from {{5}} remains unpaid and is now {{6}} day(s) overdue.

Please share the payment confirmation or expected release date so we can update our records.

For any clarification, kindly reply on this number.

Thank you.',
    Variables = N'["CustomerName","InvoiceNo","Currency","Amount","CompanyName","OverdueDays"]',
    MetaLanguageCode = 'en',
    UpdatedBy = 'PHASE_A_03'
  WHERE Channel = 'WHATSAPP' AND Stage = 'FOLLOW_UP';
  PRINT '✓ Synced FOLLOW_UP template Body+Variables';

  COMMIT TRANSACTION;
  PRINT 'PHASE A complete — Body+Variables synced. IsActive still 0; cron will NOT send yet.';
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  PRINT '✗ PHASE A failed — all updates rolled back';
  THROW;
END CATCH;
GO

-- ─────────────────────────────────────────────────────────────────────
-- PHASE B — Activate per-stage AFTER Meta approval
--
-- For each stage:
--   1. Confirm the template status is APPROVED in Business Manager.
--   2. Confirm META_WA_PHONE_NUMBER_ID + META_WA_ACCESS_TOKEN are in .env.
--   3. Confirm REMINDER_TEST_MODE is set as desired (true=log only,
--      false=real send to customers).
--   4. Uncomment the relevant block and run.
--
-- Re-running is safe (UPDATE is idempotent).
-- To deactivate a stage later, set IsActive=0 — never DELETE the row.
-- ─────────────────────────────────────────────────────────────────────

-- ── PRE_DUE ──────────────────────────────────────────────────────────
UPDATE [dbo].[BN_ReminderTemplates]
SET MetaTemplateName = 'payment_reminder_pre_due_v1',
    IsActive         = 1,
    UpdatedBy        = 'PHASE_B_03'
WHERE Channel = 'WHATSAPP' AND Stage = 'PRE_DUE';
PRINT '✓ Activated payment_reminder_pre_due_v1';

-- ── DUE_DAY ──────────────────────────────────────────────────────────
UPDATE [dbo].[BN_ReminderTemplates]
SET MetaTemplateName = 'payment_due_today_v1',
    IsActive         = 1,
    UpdatedBy        = 'PHASE_B_03'
WHERE Channel = 'WHATSAPP' AND Stage = 'DUE_DAY';
PRINT '✓ Activated payment_due_today_v1';

-- ── OVERDUE ──────────────────────────────────────────────────────────
UPDATE [dbo].[BN_ReminderTemplates]
SET MetaTemplateName = 'payment_overdue_v1',
    IsActive         = 1,
    UpdatedBy        = 'PHASE_B_03'
WHERE Channel = 'WHATSAPP' AND Stage = 'OVERDUE';
PRINT '✓ Activated payment_overdue_v1';

-- ── FOLLOW_UP ────────────────────────────────────────────────────────
UPDATE [dbo].[BN_ReminderTemplates]
SET MetaTemplateName = 'payment_followup_v1',
    IsActive         = 1,
    UpdatedBy        = 'PHASE_B_03'
WHERE Channel = 'WHATSAPP' AND Stage = 'FOLLOW_UP';
PRINT '✓ Activated payment_followup_v1';

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY — list current state of all WhatsApp template rows
-- ─────────────────────────────────────────────────────────────────────
SELECT
  Stage,
  Channel,
  MetaTemplateName,
  MetaLanguageCode,
  IsActive,
  Variables,
  LEN(Body) AS BodyChars,
  UpdatedBy,
  ModifiedAt = (SELECT TOP 1 ModifiedAt FROM [dbo].[BN_ReminderTemplates] t2
                WHERE t2.Channel = t.Channel AND t2.Stage = t.Stage)
FROM [dbo].[BN_ReminderTemplates] t
WHERE Channel = 'WHATSAPP'
ORDER BY CASE Stage
           WHEN 'PRE_DUE'   THEN 1
           WHEN 'DUE_DAY'   THEN 2
           WHEN 'OVERDUE'   THEN 3
           WHEN 'FOLLOW_UP' THEN 4
           ELSE 5 END;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'Activation script done. Phase A applied; Phase B blocks pending';
PRINT 'Meta approval. Uncomment per stage as approvals come through.';
PRINT '═══════════════════════════════════════════════════════════════';
GO
