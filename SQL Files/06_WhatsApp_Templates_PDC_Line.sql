-- =====================================================================
-- 06_WhatsApp_Templates_PDC_Line.sql
-- Syncs BN_ReminderTemplates.Body for all 4 WhatsApp payment templates
-- to match the updated Meta templates submitted on 2026-05-15.
--
-- WHAT CHANGED:
--   Added one disclaimer line to each of the 4 reminder templates so
--   customers who have already handed a Post-Dated Cheque (PDC) to the
--   salesperson don't think they need to act on the reminder. The
--   reminder will stop automatically once the cheque clears at the
--   bank and the accounts team applies the receipt in NAV.
--
--   New line (identical across all 4 stages):
--     Note: If you have already submitted a Post-Dated Cheque (PDC)
--     against this invoice, kindly disregard this reminder — it will
--     stop automatically once the Cheque is cleared by the bank and
--     credited to our account.
--
-- SAFETY PROFILE:
--   - Zero data loss — only the Body column is rewritten on 4 rows.
--   - Auto-rollback on any failure (XACT_ABORT ON + TRY/CATCH).
--   - Idempotent — re-running rewrites identically.
--   - App DB only (BizNAV_App). NAV DB is NEVER touched.
--   - IsActive is NOT changed. MetaTemplateName is NOT changed.
--   - Variables list + position is NOT changed (PDC line uses no vars).
--
-- WHEN TO RUN:
--   After all 4 templates flip from "In-review" → "Approved" in
--   Meta WhatsApp Manager (usually 1–24h for utility category). Safe
--   to run before approval too — Meta is the source of truth for the
--   outbound message body, this DB row is just for our Reminder Log
--   UI readability + audit trail.
--
-- WHAT IF SOMETHING GOES WRONG:
--   - Whole block is one transaction with XACT_ABORT ON → any error
--     aborts and rolls back all 4 updates. No partial state possible.
--   - To revert: re-run 03_WhatsApp_Templates_Activate.sql Phase A,
--     which has the pre-PDC bodies. Both files are idempotent so the
--     last one run wins.
--   - The cron's outbound WhatsApp send relies on tpl.MetaTemplateName
--     + the Variables array, NOT the Body string. So even if Body in
--     DB is out of sync with Meta, the cron keeps working — only the
--     Reminder Log UI display would show stale text.
-- =====================================================================

USE BizNAV_App;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'ONE App — WhatsApp Templates: PDC disclaimer line';
PRINT 'Database: ' + DB_NAME();
PRINT '═══════════════════════════════════════════════════════════════';
GO

SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  -- ── PRE_DUE — payment_reminder_pre_due_v1 ────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Body = N'Dear {{1}},

This is a gentle reminder from {{2}} that invoice {{3}} of {{4}} {{5}} is due on {{6}}.

Kindly arrange payment on or before the due date to keep the account current.

If payment is already processed, please share the UTR / payment advice on this number.

Note: If you have already submitted a Post-Dated Cheque (PDC) against this invoice, kindly disregard this reminder — it will stop automatically once the Cheque is cleared by the bank and credited to our account.

Thank you for your continued business.',
    UpdatedBy = 'PDC_LINE_06'
  WHERE Channel = 'WHATSAPP' AND Stage = 'PRE_DUE';

  IF @@ROWCOUNT <> 1
    THROW 50001, 'PRE_DUE template row not found — expected exactly 1 row.', 1;
  PRINT '✓ Synced PRE_DUE template Body';

  -- ── DUE_DAY — payment_due_today_v1 ───────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Body = N'Dear {{1}},

This is a reminder from {{2}} that today ({{3}}) is the due date for invoice {{4}} of {{5}} {{6}}.

Request you to release the payment today to avoid it turning overdue.

If payment is already processed, please share the UTR / payment advice on this number.

Note: If you have already submitted a Post-Dated Cheque (PDC) against this invoice, kindly disregard this reminder — it will stop automatically once the Cheque is cleared by the bank and credited to our account.

Thank you.',
    UpdatedBy = 'PDC_LINE_06'
  WHERE Channel = 'WHATSAPP' AND Stage = 'DUE_DAY';

  IF @@ROWCOUNT <> 1
    THROW 50002, 'DUE_DAY template row not found — expected exactly 1 row.', 1;
  PRINT '✓ Synced DUE_DAY template Body';

  -- ── OVERDUE — payment_overdue_v1 ─────────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Body = N'Dear {{1}},

This is to inform you that invoice {{2}} of {{3}} {{4}} from {{5}} is overdue by {{6}} day(s).

Kindly release the payment at the earliest to settle the outstanding balance.

If payment has been processed, please share the UTR / payment advice for our records.

Note: If you have already submitted a Post-Dated Cheque (PDC) against this invoice, kindly disregard this reminder — it will stop automatically once the Cheque is cleared by the bank and credited to our account.

Thank you for your prompt attention.',
    UpdatedBy = 'PDC_LINE_06'
  WHERE Channel = 'WHATSAPP' AND Stage = 'OVERDUE';

  IF @@ROWCOUNT <> 1
    THROW 50003, 'OVERDUE template row not found — expected exactly 1 row.', 1;
  PRINT '✓ Synced OVERDUE template Body';

  -- ── FOLLOW_UP — payment_followup_v1 ──────────────────────────────
  UPDATE [dbo].[BN_ReminderTemplates]
  SET
    Body = N'Dear {{1}},

Despite earlier reminders, invoice {{2}} of {{3}} {{4}} from {{5}} remains unpaid and is now {{6}} day(s) overdue.

Please share the payment confirmation or expected release date so we can update our records.

If payment has been processed, please share the UTR / payment advice for our records.

Note: If you have already submitted a Post-Dated Cheque (PDC) against this invoice, kindly disregard this reminder — it will stop automatically once the Cheque is cleared by the bank and credited to our account.

For any clarification, kindly reply on this number to Sales Person number.

Thank you.',
    UpdatedBy = 'PDC_LINE_06'
  WHERE Channel = 'WHATSAPP' AND Stage = 'FOLLOW_UP';

  IF @@ROWCOUNT <> 1
    THROW 50004, 'FOLLOW_UP template row not found — expected exactly 1 row.', 1;
  PRINT '✓ Synced FOLLOW_UP template Body';

  COMMIT TRANSACTION;
  PRINT '───────────────────────────────────────────────────────────────';
  PRINT 'COMMITTED — all 4 templates updated with PDC disclaimer line.';
  PRINT 'IsActive + MetaTemplateName + Variables UNCHANGED.';
  PRINT '───────────────────────────────────────────────────────────────';
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  PRINT '✗ FAILED — all 4 updates rolled back. Error follows:';
  THROW;
END CATCH;
GO

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY — inspect current state of the 4 WhatsApp template rows
-- Confirm: BodyChars increased by ~210 (the new PDC line length).
-- ─────────────────────────────────────────────────────────────────────
SELECT
  Stage,
  MetaTemplateName,
  MetaLanguageCode,
  IsActive,
  LEN(Body)             AS BodyChars,
  Variables,
  UpdatedBy,
  CASE WHEN Body LIKE N'%Post-Dated Cheque (PDC)%'
       THEN '✓ contains PDC line'
       ELSE '✗ PDC line MISSING'
  END AS PDC_LineStatus
FROM [dbo].[BN_ReminderTemplates]
WHERE Channel = 'WHATSAPP'
ORDER BY CASE Stage
           WHEN 'PRE_DUE'   THEN 1
           WHEN 'DUE_DAY'   THEN 2
           WHEN 'OVERDUE'   THEN 3
           WHEN 'FOLLOW_UP' THEN 4
           ELSE 5 END;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'Done. Expected output: 4 rows, all showing "✓ contains PDC line".';
PRINT '═══════════════════════════════════════════════════════════════';
GO
