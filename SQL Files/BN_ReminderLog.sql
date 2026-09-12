-- =====================================================================
-- BN_ReminderLog
-- Stores every payment reminder email sent (auto or manual)
-- Database: BizNAV_App
-- =====================================================================

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_ReminderLog' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_ReminderLog](
    [Id]              INT IDENTITY(1,1) PRIMARY KEY,
    [CompanyCode]     NVARCHAR(20)   NOT NULL,       -- 'COMPANYA' | 'COMPANYB'
    [CustomerNo]      NVARCHAR(30)   NOT NULL,
    [CustomerName]    NVARCHAR(200)  NULL,
    [InvoiceNo]       NVARCHAR(50)   NOT NULL,
    [ExtInvoiceNo]    NVARCHAR(50)   NULL,
    [PostingDate]     DATE           NULL,
    [DueDate]         DATE           NULL,
    [Amount]          DECIMAL(18,2)  NULL,
    [OverdueDays]     INT            NULL,
    [ReminderStage]   NVARCHAR(30)   NOT NULL,       -- PRE_DUE | DUE_DAY | OVERDUE | FOLLOW_UP
    [ReminderNumber]  INT            NOT NULL DEFAULT 1, -- 1st, 2nd, 3rd mail etc.
    [SalespersonCode] NVARCHAR(20)   NULL,
    [SalespersonName] NVARCHAR(100)  NULL,
    [EmailTo]         NVARCHAR(500)  NOT NULL,
    [EmailCc]         NVARCHAR(1000) NULL,
    [EmailFrom]       NVARCHAR(200)  NULL,
    [Subject]         NVARCHAR(500)  NULL,
    [Body]            NVARCHAR(MAX)  NULL,
    [SentAt]          DATETIME       NOT NULL DEFAULT GETDATE(),
    [SentByUserId]    INT            NULL,           -- NULL = auto cron
    [SentByUserName]  NVARCHAR(100)  NULL,           -- 'SYSTEM' | username
    [IsManual]        BIT            NOT NULL DEFAULT 0,
    [Status]          NVARCHAR(20)   NOT NULL DEFAULT 'SENT', -- SENT | FAILED | PENDING
    [ErrorMessage]    NVARCHAR(MAX)  NULL,
    [MessageId]       NVARCHAR(500)  NULL,           -- SMTP Message-ID for email threading
    [CreatedAt]       DATETIME       NOT NULL DEFAULT GETDATE()
  );

  CREATE INDEX IX_ReminderLog_Customer  ON [dbo].[BN_ReminderLog]([CustomerNo]);
  CREATE INDEX IX_ReminderLog_Invoice   ON [dbo].[BN_ReminderLog]([InvoiceNo]);
  CREATE INDEX IX_ReminderLog_SentAt    ON [dbo].[BN_ReminderLog]([SentAt] DESC);
  CREATE INDEX IX_ReminderLog_SP        ON [dbo].[BN_ReminderLog]([SalespersonCode]);
END
GO
