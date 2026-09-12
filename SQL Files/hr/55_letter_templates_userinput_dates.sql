-- ============================================================================
-- ONE App Lens — Letter Templates: switch Experience Letter to user-input
-- date range + seed an Increment Letter template
-- File:  SQL Files/hr/55_letter_templates_userinput_dates.sql
-- Date:  2026-05-23
--
-- WHY
--   The seeded Experience Letter used {{DateOfJoining}} and {{LastWorkingDay}}
--   which come from HRM_Employee. LastWorkingDay is NULL for currently-employed
--   staff, so an active employee requesting an experience certificate got
--   "employed from 01-04-2024 to " (blank end date).
--
--   Switching to {{FromDate}} and {{ToDate}} lets HR enter the exact period
--   in the Generate form. Defaults still pull from DOJ / LWD if HR leaves
--   the inputs blank (handled in letters.js → collectExtras: blanks are
--   omitted so the engine falls back to whatever's in the template body —
--   in this case the {{FromDate}}/{{ToDate}} stay literal which is a clear
--   "unresolved" warning in the preview).
--
-- SAFETY: BizNAV_App only. UPDATE re-runnable. Increment seed is MERGE-guarded.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- ── 1. Switch Experience Letter to {{FromDate}} / {{ToDate}} ────────────────
DECLARE @newExperienceBody NVARCHAR(MAX) = N'Date: {{Today}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{Salutation}} {{EmpName}} (Employee Code: {{EmpCode}}) was employed with Company A Pvt Ltd from {{FromDate}} to {{ToDate}}.

At the time of leaving, {{Salutation}} {{EmpName}} held the position of {{Designation}} in the {{Department}} department.

During the tenure with us, we found {{Salutation}} {{EmpName}} sincere, hardworking, and committed to assigned responsibilities. {{Salutation}} {{EmpName}} demonstrated good professional skills and worked well with team members.

We wish {{Salutation}} {{EmpName}} all the best for future endeavours.

For Company A Pvt Ltd';

UPDATE [dbo].[HRM_Letter_Template]
SET BodyTemplate = @newExperienceBody,
    UpdatedAt    = SYSDATETIME()
WHERE Code = 'EXPERIENCE_LETTER';

PRINT '[OK] EXPERIENCE_LETTER body updated to use {{FromDate}} / {{ToDate}}.';
GO


-- ── 2. Seed Increment Letter (uses {{NewDesignation}}, {{NewCTC}}, {{EffectiveDate}}) ──
DECLARE @incrementBody NVARCHAR(MAX) = N'Date: {{Today}}

Dear {{Salutation}} {{EmpName}},

We are pleased to inform you that, in recognition of your performance and contribution, your compensation has been revised with effect from {{EffectiveDate}}.

Your revised annual Cost to Company (CTC) is INR {{NewCTC}}. Your new designation is {{NewDesignation}}, in the {{Department}} department.

All other terms and conditions of your employment remain unchanged. We thank you for your continued commitment and look forward to your ongoing contributions.

Congratulations!

For Company A Pvt Ltd';

DECLARE @sig NVARCHAR(MAX) = N'_______________________________
Authorised Signatory
HR Department
Company A Pvt Ltd
PAN: AAAAA0000A';

MERGE INTO [dbo].[HRM_Letter_Template] AS T
USING (VALUES
    ('INCREMENT_LETTER',  N'Increment / Promotion Letter',  N'promotion',
     N'Salary Revision - {{EmpName}}', @incrementBody, @sig)
) AS S (Code, Name, Category, Subject, BodyTemplate, SignatureBlock)
ON T.Code = S.Code
WHEN NOT MATCHED THEN
    INSERT (Code, Name, Category, Subject, BodyTemplate, SignatureBlock)
    VALUES (S.Code, S.Name, S.Category, S.Subject, S.BodyTemplate, S.SignatureBlock);

PRINT '[OK] INCREMENT_LETTER seeded (if not already present).';
GO

SELECT Code, Name, Category, IsActive,
       LEFT(BodyTemplate, 80) + N'…' AS BodyPreview
FROM [dbo].[HRM_Letter_Template]
ORDER BY Category, Name;
GO
