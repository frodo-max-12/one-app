-- =====================================================================
-- 02_WhatsApp_Reminder_Migration.sql
-- One-time migration to add WhatsApp channel support to the existing
-- payment-reminder tables.
--
-- Tables affected (App DB only — NO NAV DB writes):
--   [dbo].[BN_ReminderLog]         — add Channel + WhatsApp tracking columns
--   [dbo].[BN_ReminderTemplates]   — add Channel + Meta template metadata
--                                     replace UNIQUE(Stage) with UNIQUE(Channel, Stage)
--                                     seed 4 placeholder WhatsApp templates
--
-- SAFETY:
--   - All schema changes are ADDITIVE (ADD COLUMN with metadata-only DEFAULT)
--     or rebuild a single small unique constraint (4 template rows).
--   - No existing rows are deleted or rewritten.
--   - Existing rows get Channel='EMAIL' via the column DEFAULT — no UPDATE
--     pass needed (SQL Server 2016+ stores constant defaults as metadata).
--   - All guards are IF NOT EXISTS / IF EXISTS — safe to re-run.
--   - DDL batches auto-commit individually (required by SQL Server parser).
--   - The seed batch is wrapped in TRY/CATCH with auto-rollback.
--
-- WHEN TO RUN:
--   Any time, even with live users active. Total runtime: under 1 second.
--
-- HOW TO RUN:
--   Open SSMS → connect to 10.0.0.10 → open this file →
--   verify USE statement targets BizNAV_App → press F5.
-- =====================================================================

USE BizNAV_App;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'ONE App — WhatsApp Reminder Migration starting on database: ' + DB_NAME();
PRINT '═══════════════════════════════════════════════════════════════';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 1: BN_ReminderLog — add Channel column with EMAIL default
-- (must be its own batch — later batches reference this column)
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'Channel' AND Object_ID = Object_ID(N'dbo.BN_ReminderLog')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderLog]
    ADD [Channel] NVARCHAR(20) NOT NULL CONSTRAINT DF_BN_ReminderLog_Channel DEFAULT ('EMAIL');
  PRINT '✓ Added Channel column to BN_ReminderLog (default EMAIL)';
END
ELSE
  PRINT '• Channel column already exists on BN_ReminderLog';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 2: BN_ReminderLog — add WhatsApp tracking columns (nullable)
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'WhatsAppMessageId' AND Object_ID = Object_ID(N'dbo.BN_ReminderLog')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderLog] ADD [WhatsAppMessageId] NVARCHAR(100) NULL;
  PRINT '✓ Added WhatsAppMessageId column to BN_ReminderLog';
END
ELSE
  PRINT '• WhatsAppMessageId column already exists on BN_ReminderLog';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'WhatsAppPhoneTo' AND Object_ID = Object_ID(N'dbo.BN_ReminderLog')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderLog] ADD [WhatsAppPhoneTo] NVARCHAR(20) NULL;
  PRINT '✓ Added WhatsAppPhoneTo column to BN_ReminderLog';
END
ELSE
  PRINT '• WhatsAppPhoneTo column already exists on BN_ReminderLog';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 3: BN_ReminderLog — index on Channel for filter/stats queries
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE Name = N'IX_ReminderLog_Channel' AND Object_ID = Object_ID(N'dbo.BN_ReminderLog')
)
BEGIN
  CREATE INDEX IX_ReminderLog_Channel ON [dbo].[BN_ReminderLog]([Channel]);
  PRINT '✓ Created index IX_ReminderLog_Channel';
END
ELSE
  PRINT '• Index IX_ReminderLog_Channel already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 4: BN_ReminderTemplates — add Channel column with EMAIL default
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'Channel' AND Object_ID = Object_ID(N'dbo.BN_ReminderTemplates')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderTemplates]
    ADD [Channel] NVARCHAR(20) NOT NULL CONSTRAINT DF_BN_ReminderTemplates_Channel DEFAULT ('EMAIL');
  PRINT '✓ Added Channel column to BN_ReminderTemplates (default EMAIL)';
END
ELSE
  PRINT '• Channel column already exists on BN_ReminderTemplates';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 5: BN_ReminderTemplates — add Meta WhatsApp template fields
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'MetaTemplateName' AND Object_ID = Object_ID(N'dbo.BN_ReminderTemplates')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderTemplates] ADD [MetaTemplateName] NVARCHAR(100) NULL;
  PRINT '✓ Added MetaTemplateName column to BN_ReminderTemplates';
END
ELSE
  PRINT '• MetaTemplateName column already exists on BN_ReminderTemplates';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'MetaLanguageCode' AND Object_ID = Object_ID(N'dbo.BN_ReminderTemplates')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderTemplates]
    ADD [MetaLanguageCode] NVARCHAR(10) NOT NULL CONSTRAINT DF_BN_ReminderTemplates_Lang DEFAULT ('en');
  PRINT '✓ Added MetaLanguageCode column to BN_ReminderTemplates (default en)';
END
ELSE
  PRINT '• MetaLanguageCode column already exists on BN_ReminderTemplates';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'Variables' AND Object_ID = Object_ID(N'dbo.BN_ReminderTemplates')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderTemplates] ADD [Variables] NVARCHAR(MAX) NULL;
  PRINT '✓ Added Variables column to BN_ReminderTemplates (JSON array of variable names in template body order)';
END
ELSE
  PRINT '• Variables column already exists on BN_ReminderTemplates';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 6: BN_ReminderTemplates — drop UNIQUE(Stage), add UNIQUE(Channel, Stage)
-- The old constraint blocks adding a second row with Stage='PRE_DUE' for WhatsApp.
-- New composite uniqueness allows one row per (Channel, Stage) pair.
-- ───────────────────────────────────────────────────────────────────
DECLARE @OldUq sysname;
SELECT @OldUq = kc.name
FROM sys.key_constraints kc
INNER JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.parent_object_id = OBJECT_ID(N'dbo.BN_ReminderTemplates')
  AND kc.type = 'UQ'
  AND c.name = 'Stage'
GROUP BY kc.name
HAVING COUNT(*) = 1;   -- only the single-column UNIQUE(Stage)

IF @OldUq IS NOT NULL
BEGIN
  EXEC('ALTER TABLE [dbo].[BN_ReminderTemplates] DROP CONSTRAINT [' + @OldUq + ']');
  PRINT '✓ Dropped old single-column UNIQUE constraint on Stage: ' + @OldUq;
END
ELSE
  PRINT '• No old single-column UNIQUE(Stage) constraint to drop';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE Name = N'UQ_BN_ReminderTemplates_Channel_Stage'
    AND Object_ID = Object_ID(N'dbo.BN_ReminderTemplates')
)
BEGIN
  ALTER TABLE [dbo].[BN_ReminderTemplates]
    ADD CONSTRAINT UQ_BN_ReminderTemplates_Channel_Stage UNIQUE ([Channel], [Stage]);
  PRINT '✓ Added composite UNIQUE constraint on (Channel, Stage)';
END
ELSE
  PRINT '• Composite UNIQUE(Channel, Stage) already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 7: Seed 4 placeholder WhatsApp templates (one per stage)
-- These are PLACEHOLDERS — the MetaTemplateName must be replaced with
-- the actual approved template_name from Meta Business Manager once
-- the templates are submitted and approved.
-- ───────────────────────────────────────────────────────────────────
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Channel='WHATSAPP' AND Stage='PRE_DUE')
  BEGIN
    INSERT INTO [dbo].[BN_ReminderTemplates]
      (Channel, Stage, Subject, Body, IsActive, MetaTemplateName, MetaLanguageCode, Variables, UpdatedBy)
    VALUES
      ('WHATSAPP', 'PRE_DUE',
       N'Payment reminder (pre-due)',
       N'Dear {{1}}, this is a gentle reminder that invoice {{2}} for {{3}} {{4}} is due on {{5}}. Kindly arrange the payment on or before the due date. — {{6}}',
       0,                                                  -- inactive until Meta approves the template
       NULL,                                               -- e.g. 'payment_reminder_pre_due_v1'
       'en',
       N'["CustomerName","InvoiceNo","Currency","Amount","DueDate","CompanyName"]',
       'MIGRATION_02');
    PRINT '✓ Seeded WhatsApp template for stage PRE_DUE (inactive — awaiting Meta approval)';
  END

  IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Channel='WHATSAPP' AND Stage='DUE_DAY')
  BEGIN
    INSERT INTO [dbo].[BN_ReminderTemplates]
      (Channel, Stage, Subject, Body, IsActive, MetaTemplateName, MetaLanguageCode, Variables, UpdatedBy)
    VALUES
      ('WHATSAPP', 'DUE_DAY',
       N'Payment due today',
       N'Dear {{1}}, today ({{5}}) is the due date for invoice {{2}} of {{3}} {{4}}. Request you to release the payment today to avoid it turning overdue. — {{6}}',
       0, NULL, 'en',
       N'["CustomerName","InvoiceNo","Currency","Amount","DueDate","CompanyName"]',
       'MIGRATION_02');
    PRINT '✓ Seeded WhatsApp template for stage DUE_DAY (inactive — awaiting Meta approval)';
  END

  IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Channel='WHATSAPP' AND Stage='OVERDUE')
  BEGIN
    INSERT INTO [dbo].[BN_ReminderTemplates]
      (Channel, Stage, Subject, Body, IsActive, MetaTemplateName, MetaLanguageCode, Variables, UpdatedBy)
    VALUES
      ('WHATSAPP', 'OVERDUE',
       N'Payment overdue',
       N'Dear {{1}}, invoice {{2}} of {{3}} {{4}} is overdue by {{5}} days. Kindly release the payment at the earliest. — {{6}}',
       0, NULL, 'en',
       N'["CustomerName","InvoiceNo","Currency","Amount","OverdueDays","CompanyName"]',
       'MIGRATION_02');
    PRINT '✓ Seeded WhatsApp template for stage OVERDUE (inactive — awaiting Meta approval)';
  END

  IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Channel='WHATSAPP' AND Stage='FOLLOW_UP')
  BEGIN
    INSERT INTO [dbo].[BN_ReminderTemplates]
      (Channel, Stage, Subject, Body, IsActive, MetaTemplateName, MetaLanguageCode, Variables, UpdatedBy)
    VALUES
      ('WHATSAPP', 'FOLLOW_UP',
       N'Urgent payment follow-up',
       N'Dear {{1}}, despite earlier reminders, invoice {{2}} of {{3}} {{4}} remains unpaid and is now {{5}} days overdue. Please share payment confirmation or expected release date. — {{6}}',
       0, NULL, 'en',
       N'["CustomerName","InvoiceNo","Currency","Amount","OverdueDays","CompanyName"]',
       'MIGRATION_02');
    PRINT '✓ Seeded WhatsApp template for stage FOLLOW_UP (inactive — awaiting Meta approval)';
  END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  PRINT '✗ Seed batch failed — all template inserts rolled back';
  THROW;
END CATCH;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'WhatsApp Reminder Migration COMPLETE.';
PRINT '';
PRINT 'Next manual steps (outside this script):';
PRINT '  1. Submit the 4 placeholder templates to Meta Business Manager';
PRINT '     (as Template messages, category = UTILITY).';
PRINT '  2. Once Meta approves each, fill in MetaTemplateName for that stage';
PRINT '     row and set IsActive=1.';
PRINT '  3. Add to .env on the server:';
PRINT '       META_WA_PHONE_NUMBER_ID=...';
PRINT '       META_WA_ACCESS_TOKEN=...';
PRINT '       META_WA_API_VERSION=v22.0';
PRINT '       REMINDER_WHATSAPP_COMPANYA_CUSTOMERS=RETAILER%,DCGBPL%,CG-BPL%,RRK%,PANC%';
PRINT '═══════════════════════════════════════════════════════════════';
GO
