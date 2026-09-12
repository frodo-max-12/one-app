-- ============================================================================
-- Widen BN_ReminderLog recipient columns to stop truncation errors (8152)
-- File:  SQL Files/reminder/06_widen_reminder_log_recipients.sql
-- Date:  2026-05-25
--
-- SYMPTOM (in pm2 logs):
--   "String or binary data would be truncated in table 'BizNAV_App.dbo.BN_ReminderLog',
--    column 'WhatsAppPhoneTo'. Truncated value: ..."
--
-- CAUSE: When recipient lists started including team-scoped CC chains
-- (Customer + Salesperson + Sales Head + Electrical Head + Admin), the values
-- exceeded the original column widths. Logging fails silently for every send.
--
-- SAFETY: BizNAV_App only. Idempotent — ALTER COLUMN with same type widens.
-- ZERO data loss — only widening, never narrowing or dropping.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- Show current widths BEFORE
PRINT '── BEFORE ──';
SELECT name AS ColumnName, max_length, system_type_id
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.BN_ReminderLog')
  AND name IN ('WhatsAppPhoneTo','EmailTo','EmailCc','PhoneNumber','Recipient','RecipientName')
ORDER BY name;
GO

-- Widen the WhatsApp phone destination column
IF COL_LENGTH('dbo.BN_ReminderLog', 'WhatsAppPhoneTo') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [WhatsAppPhoneTo] NVARCHAR(2000) NULL;
    PRINT '[OK] BN_ReminderLog.WhatsAppPhoneTo widened to NVARCHAR(2000).';
END

-- Widen email To / Cc — same family of issue likely
IF COL_LENGTH('dbo.BN_ReminderLog', 'EmailTo') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [EmailTo] NVARCHAR(2000) NULL;
    PRINT '[OK] BN_ReminderLog.EmailTo widened to NVARCHAR(2000).';
END

IF COL_LENGTH('dbo.BN_ReminderLog', 'EmailCc') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [EmailCc] NVARCHAR(2000) NULL;
    PRINT '[OK] BN_ReminderLog.EmailCc widened to NVARCHAR(2000).';
END

-- Some installations name the columns differently — these are defensive
IF COL_LENGTH('dbo.BN_ReminderLog', 'PhoneNumber') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [PhoneNumber] NVARCHAR(2000) NULL;
    PRINT '[OK] BN_ReminderLog.PhoneNumber widened to NVARCHAR(2000).';
END

IF COL_LENGTH('dbo.BN_ReminderLog', 'Recipient') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [Recipient] NVARCHAR(2000) NULL;
    PRINT '[OK] BN_ReminderLog.Recipient widened to NVARCHAR(2000).';
END

IF COL_LENGTH('dbo.BN_ReminderLog', 'RecipientName') IS NOT NULL
BEGIN
    ALTER TABLE [dbo].[BN_ReminderLog]
    ALTER COLUMN [RecipientName] NVARCHAR(500) NULL;
    PRINT '[OK] BN_ReminderLog.RecipientName widened to NVARCHAR(500).';
END
GO

-- Show widths AFTER
PRINT '── AFTER ──';
SELECT name AS ColumnName, max_length, system_type_id
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.BN_ReminderLog')
  AND name IN ('WhatsAppPhoneTo','EmailTo','EmailCc','PhoneNumber','Recipient','RecipientName')
ORDER BY name;
GO
