 USE BizNAV_App;
  GO
                                                                                                                                                                              -- ────────────────────────────────────────────────────────────
  -- 1) CREATE TABLE: BN_ReminderLog                                                                                                                                          -- ────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_ReminderLog' AND xtype='U')
  BEGIN
    CREATE TABLE [dbo].[BN_ReminderLog](
      [Id]              INT IDENTITY(1,1) PRIMARY KEY,
      [CompanyCode]     NVARCHAR(20)   NOT NULL,
      [CustomerNo]      NVARCHAR(30)   NOT NULL,
      [CustomerName]    NVARCHAR(200)  NULL,
      [InvoiceNo]       NVARCHAR(50)   NOT NULL,
      [ExtInvoiceNo]    NVARCHAR(50)   NULL,
      [PostingDate]     DATE           NULL,
      [DueDate]         DATE           NULL,
      [Amount]          DECIMAL(18,2)  NULL,
      [OverdueDays]     INT            NULL,
      [ReminderStage]   NVARCHAR(30)   NOT NULL,
      [ReminderNumber]  INT            NOT NULL DEFAULT 1,
      [SalespersonCode] NVARCHAR(20)   NULL,
      [SalespersonName] NVARCHAR(100)  NULL,
      [EmailTo]         NVARCHAR(500)  NOT NULL,
      [EmailCc]         NVARCHAR(1000) NULL,
      [EmailFrom]       NVARCHAR(200)  NULL,
      [Subject]         NVARCHAR(500)  NULL,
      [Body]            NVARCHAR(MAX)  NULL,
      [SentAt]          DATETIME       NOT NULL DEFAULT GETDATE(),
      [SentByUserId]    INT            NULL,
      [SentByUserName]  NVARCHAR(100)  NULL,
      [IsManual]        BIT            NOT NULL DEFAULT 0,
      [Status]          NVARCHAR(20)   NOT NULL DEFAULT 'SENT',
      [ErrorMessage]    NVARCHAR(MAX)  NULL,
      [CreatedAt]       DATETIME       NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_ReminderLog_Customer ON [dbo].[BN_ReminderLog]([CustomerNo]);
    CREATE INDEX IX_ReminderLog_Invoice  ON [dbo].[BN_ReminderLog]([InvoiceNo]);
    CREATE INDEX IX_ReminderLog_SentAt   ON [dbo].[BN_ReminderLog]([SentAt] DESC);
    CREATE INDEX IX_ReminderLog_SP       ON [dbo].[BN_ReminderLog]([SalespersonCode]);
    PRINT '✓ BN_ReminderLog created';
  END
  ELSE
    PRINT '• BN_ReminderLog already exists';
  GO

  -- ────────────────────────────────────────────────────────────
  -- 2) CREATE TABLE: BN_ReminderTemplates
  -- ────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_ReminderTemplates' AND xtype='U')
  BEGIN
    CREATE TABLE [dbo].[BN_ReminderTemplates](
      [Id]         INT IDENTITY(1,1) PRIMARY KEY,
      [Stage]      NVARCHAR(30)  NOT NULL UNIQUE,
      [Subject]    NVARCHAR(500) NOT NULL,
      [Body]       NVARCHAR(MAX) NOT NULL,
      [IsActive]   BIT           NOT NULL DEFAULT 1,
      [UpdatedAt]  DATETIME      NOT NULL DEFAULT GETDATE(),
      [UpdatedBy]  NVARCHAR(100) NULL
    );
    PRINT '✓ BN_ReminderTemplates created';
  END
  ELSE
    PRINT '• BN_ReminderTemplates already exists';
  GO

  -- ────────────────────────────────────────────────────────────
  -- 3) SEED 4 templates (only if table is empty)
  -- ────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates])
  BEGIN
    INSERT INTO [dbo].[BN_ReminderTemplates](Stage, Subject, Body) VALUES
    ('PRE_DUE',
     'Payment Reminder - Invoice {{InvoiceNo}} due on {{DueDate}}',
     'Dear {{CustomerName}},

  This is a gentle reminder that the below invoice is due for payment on {{DueDate}}.

  Invoice No.   : {{InvoiceNo}}
  Posting Date  : {{PostingDate}}
  Due Date      : {{DueDate}}
  Amount        : INR {{Amount}}

  Kindly arrange the payment on or before the due date. Please ignore this reminder if payment is already made.

  Regards,
  MIS Executive
  {{CompanyName}}'),

    ('DUE_DAY',
     'Payment Due Today - Invoice {{InvoiceNo}}',
     'Dear {{CustomerName}},

  Today ({{DueDate}}) is the last day to make the payment for the below invoice as per the agreed credit days.

  Invoice No.   : {{InvoiceNo}}
  Posting Date  : {{PostingDate}}
  Due Date      : {{DueDate}}
  Amount        : INR {{Amount}}

  Request you to release the payment today to avoid it turning overdue.

  Regards,
  MIS Executive
  {{CompanyName}}'),

    ('OVERDUE',
     'Payment Overdue - Invoice {{InvoiceNo}} ({{OverdueDays}} days)',
     'Dear {{CustomerName}},

  The below invoice is overdue by {{OverdueDays}} days. Request you to release the payment at the earliest.

  Invoice No.   : {{InvoiceNo}}
  Posting Date  : {{PostingDate}}
  Due Date      : {{DueDate}}
  Overdue Days  : {{OverdueDays}}
  Amount        : INR {{Amount}}

  Kindly treat this as urgent.

  Regards,
  MIS Executive
  {{CompanyName}}'),

    ('FOLLOW_UP',
     'URGENT: Payment Follow-up - Invoice {{InvoiceNo}} ({{OverdueDays}} days overdue)',
     'Dear {{CustomerName}},

  Despite our earlier reminders, the below invoice remains unpaid and is now {{OverdueDays}} days overdue.

  Invoice No.   : {{InvoiceNo}}
  Posting Date  : {{PostingDate}}
  Due Date      : {{DueDate}}
  Overdue Days  : {{OverdueDays}}
  Amount        : INR {{Amount}}

  We request your immediate attention to settle this payment. Please share the payment confirmation / expected date of release at the earliest.

  Regards,
  MIS Executive
  {{CompanyName}}');
    PRINT '✓ 4 templates seeded';
  END
  ELSE
    PRINT '• Templates already exist';
  GO

  -- ────────────────────────────────────────────────────────────
  -- 4) Verify
  -- ────────────────────────────────────────────────────────────
  SELECT 'BN_ReminderLog'       AS TableName, COUNT(*) AS RowCount FROM [dbo].[BN_ReminderLog]
  UNION ALL
  SELECT 'BN_ReminderTemplates', COUNT(*)                FROM [dbo].[BN_ReminderTemplates];
  GO