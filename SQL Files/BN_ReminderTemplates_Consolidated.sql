-- =====================================================================
-- BN_ReminderTemplates — Add CONSOLIDATED template (one-per-customer mail)
-- Run this once against the BizNAV_App database.
-- Placeholders used in this template:
--   {{CustomerName}}  {{CompanyName}}  {{SalespersonName}}
--   {{InvoiceTable}}  {{GrandTotal}}  {{TotalCount}}  {{HighestStage}}
-- =====================================================================

IF NOT EXISTS (SELECT 1 FROM [dbo].[BN_ReminderTemplates] WHERE Stage = 'CONSOLIDATED')
BEGIN
  INSERT INTO [dbo].[BN_ReminderTemplates](Stage, Subject, Body)
  VALUES
  ('CONSOLIDATED',
   'Payment Reminder — {{CustomerName}} ({{TotalCount}} invoice(s), INR {{GrandTotal}})',
   '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">
<p>Dear {{CustomerName}},</p>

<p>Please find below the summary of your open invoices with <b>{{CompanyName}}</b>. Kindly arrange the payments against the overdue and due invoices at the earliest.</p>

{{InvoiceTable}}

<p style="margin-top:16px;"><b>Total Outstanding: INR {{GrandTotal}}</b></p>

<p>If any payment has already been made, please share the remittance details so we can update our records. For any queries, feel free to contact your sales representative.</p>

<p>Regards,<br>
MIS Executive<br>
{{CompanyName}}</p>
</div>');
END
GO

SELECT Id, Stage, Subject, IsActive FROM [dbo].[BN_ReminderTemplates];