-- =====================================================================
-- BN_ReminderTemplates
-- 4 email templates for payment reminders (editable by admin)
-- Database: BizNAV_App
-- Placeholders allowed in Subject/Body:
--   {{CustomerName}} {{InvoiceNo}} {{ExtInvoiceNo}} {{PostingDate}}
--   {{DueDate}} {{Amount}} {{OverdueDays}} {{CompanyName}}
--   {{SalespersonName}}
-- =====================================================================

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_ReminderTemplates' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_ReminderTemplates](
    [Id]         INT IDENTITY(1,1) PRIMARY KEY,
    [Stage]      NVARCHAR(30)  NOT NULL UNIQUE,    -- PRE_DUE | DUE_DAY | OVERDUE | FOLLOW_UP
    [Subject]    NVARCHAR(500) NOT NULL,
    [Body]       NVARCHAR(MAX) NOT NULL,
    [IsActive]   BIT           NOT NULL DEFAULT 1,
    [UpdatedAt]  DATETIME      NOT NULL DEFAULT GETDATE(),
    [UpdatedBy]  NVARCHAR(100) NULL
  );
END
GO

-- Seed default templates
IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Stage = 'PRE_DUE')
BEGIN
  INSERT INTO [dbo].[BN_ReminderTemplates](Stage, Subject, Body)
  VALUES
  ('PRE_DUE',
   'Payment Reminder - Invoice {{InvoiceNo}} due on {{DueDate}}',
   'Dear {{CustomerName}},

This is a gentle reminder that the below invoice is due for payment on {{DueDate}}.

Invoice No.   : {{InvoiceNo}}
Your PO No.   : {{ExtInvoiceNo}}
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
Your PO No.   : {{ExtInvoiceNo}}
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
Your PO No.   : {{ExtInvoiceNo}}
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
Your PO No.   : {{ExtInvoiceNo}}
Posting Date  : {{PostingDate}}
Due Date      : {{DueDate}}
Overdue Days  : {{OverdueDays}}
Amount        : INR {{Amount}}

We request your immediate attention to settle this payment. Please share the payment confirmation / expected date of release at the earliest.

Regards,
MIS Executive
{{CompanyName}}');
END
GO
