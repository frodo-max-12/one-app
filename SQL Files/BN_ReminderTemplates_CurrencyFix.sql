-- =====================================================================
-- BN_ReminderTemplates — replace hardcoded "INR" with {{Currency}} placeholder
-- so per-company currency (INR for COMPANYA, USD for CompanyB) renders correctly.
-- Run this once against the BizNAV_App database.
-- =====================================================================

-- CONSOLIDATED template — subject + body
UPDATE [dbo].[BN_ReminderTemplates]
SET
  Subject = 'Payment Reminder — {{CustomerName}} ({{TotalCount}} invoice(s), {{Currency}} {{GrandTotal}})',
  Body    = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">
<p>Dear {{CustomerName}},</p>

<p>Please find below the summary of your open invoices with <b>{{CompanyName}}</b>. Kindly arrange the payments against the overdue and due invoices at the earliest.</p>

{{InvoiceTable}}

<p style="margin-top:16px;"><b>Total Outstanding: {{Currency}} {{GrandTotal}}</b></p>

<p>If any payment has already been made, please share the remittance details so we can update our records. For any queries, feel free to contact your sales representative.</p>

<p>Regards,<br>
MIS Executive<br>
{{CompanyName}}</p>
</div>',
  UpdatedAt = GETDATE(),
  UpdatedBy = 'CurrencyFix'
WHERE Stage = 'CONSOLIDATED';

-- Per-invoice templates — replace "INR {{Amount}}" with "{{Currency}} {{Amount}}"
UPDATE [dbo].[BN_ReminderTemplates]
SET
  Body = REPLACE(Body, 'INR {{Amount}}', '{{Currency}} {{Amount}}'),
  UpdatedAt = GETDATE(),
  UpdatedBy = 'CurrencyFix'
WHERE Stage IN ('PRE_DUE', 'DUE_DAY', 'OVERDUE', 'FOLLOW_UP')
  AND Body LIKE '%INR {{Amount}}%';

-- Verify
SELECT Id, Stage, Subject, IsActive, UpdatedAt, UpdatedBy
FROM [dbo].[BN_ReminderTemplates]
ORDER BY
  CASE Stage
    WHEN 'CONSOLIDATED' THEN 0
    WHEN 'PRE_DUE'      THEN 1
    WHEN 'DUE_DAY'      THEN 2
    WHEN 'OVERDUE'      THEN 3
    WHEN 'FOLLOW_UP'    THEN 4
    ELSE 99 END;
GO
