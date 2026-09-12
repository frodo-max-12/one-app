-- ============================================================================
-- ONE App Lens — Phase 6C — HRM_Letter_Template (+ 3 seed templates)
-- File:  SQL Files/hr/53_hrm_letter_template.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Letter_Template — named templates for letters HR generates
--   for employees (Offer / Experience / Salary Certificate / Increment /
--   NOC / Termination / Custom). BodyTemplate is plain text with
--   `{{Placeholder}}` mail-merge tokens resolved at generate time by
--   services/letterPdf.js. The resolver supports these tokens:
--
--     {{EmpName}}        — User_Login.Name of the target employee
--     {{EmpCode}}        — HRM_Employee.EmpCode
--     {{Designation}}    — HRM_Employee.Designation
--     {{Department}}     — HRM_Employee.Department
--     {{Location}}       — HRM_Employee.Location
--     {{DateOfJoining}}  — HRM_Employee.DateOfJoining (DD-MM-YYYY)
--     {{LastWorkingDay}} — HRM_Employee.LastWorkingDay
--     {{ConfirmationDate}} — HRM_Employee.ConfirmationDate
--     {{AnnualCTC}}      — current HRM_Employee_Salary.CTC (₹ formatted)
--     {{MonthlyGross}}   — current MonthlyGross
--     {{PAN}}            — HRM_Employee.PAN
--     {{Today}}          — date of generation (DD-MM-YYYY)
--     {{TodayLong}}      — generation date in "DD MonthName YYYY" form
--     {{Salutation}}     — Mr./Ms. derived from Gender (Mr.+Other → Mr.)
--
--   SignatureBlock is appended below the body — usually the authorised
--   signatory name + designation + company stamp text. HR can edit
--   per-template.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Letter_Template]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Letter_Template] (
        TemplateId      INT             IDENTITY(1,1) PRIMARY KEY,
        Code            NVARCHAR(40)    NOT NULL UNIQUE,
        Name            NVARCHAR(150)   NOT NULL,
        Category        NVARCHAR(30)    NOT NULL DEFAULT 'general',   -- offer | exit | salary | promotion | noc | general
        Subject         NVARCHAR(200)   NULL,
        BodyTemplate    NVARCHAR(MAX)   NOT NULL,                      -- plain text with {{placeholders}}
        SignatureBlock  NVARCHAR(MAX)   NULL,                          -- appended below body
        IsActive        BIT             NOT NULL DEFAULT 1,

        CreatedBy       INT             NULL,
        CreatedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)    NULL,

        INDEX IX_HRM_LT_Active (IsActive, Category, Name)
    );
    PRINT '[OK] dbo.HRM_Letter_Template created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Letter_Template already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- Seed 3 standard templates (idempotent via MERGE on Code)
-- ────────────────────────────────────────────────────────────────────────────
DECLARE @offerBody NVARCHAR(MAX) = N'Date: {{Today}}

Dear {{Salutation}} {{EmpName}},

We are pleased to extend this offer of employment to you for the position of {{Designation}} in the {{Department}} department at Company A Pvt Ltd, based at our {{Location}} office.

Your employment will commence on {{DateOfJoining}}. Your annual Cost to Company (CTC) is INR {{AnnualCTC}}, with a monthly gross of INR {{MonthlyGross}}. The detailed salary structure is provided in Annexure A.

Your employment will be governed by the company''s policies and the terms set out in the Employment Agreement. Please sign and return the duplicate of this letter as a confirmation of your acceptance.

We look forward to a long and mutually rewarding association.

Welcome to the team!';

DECLARE @experienceBody NVARCHAR(MAX) = N'Date: {{Today}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{Salutation}} {{EmpName}} (Employee Code: {{EmpCode}}) was employed with Company A Pvt Ltd from {{DateOfJoining}} to {{LastWorkingDay}}.

At the time of leaving, {{Salutation}} {{EmpName}} held the position of {{Designation}} in the {{Department}} department.

During the tenure with us, we found {{Salutation}} {{EmpName}} sincere, hardworking, and committed to assigned responsibilities. {{Salutation}} {{EmpName}} demonstrated good professional skills and worked well with team members.

We wish {{Salutation}} {{EmpName}} all the best for future endeavours.

For Company A Pvt Ltd';

DECLARE @salaryBody NVARCHAR(MAX) = N'Date: {{Today}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{Salutation}} {{EmpName}} (Employee Code: {{EmpCode}}) is employed with Company A Pvt Ltd since {{DateOfJoining}}.

{{Salutation}} {{EmpName}} currently holds the position of {{Designation}} in the {{Department}} department at our {{Location}} office.

The current Annual Cost to Company (CTC) of {{Salutation}} {{EmpName}} is INR {{AnnualCTC}}, with a monthly gross salary of INR {{MonthlyGross}}.

This certificate is issued on the request of the employee for personal use.

For Company A Pvt Ltd';

DECLARE @sig NVARCHAR(MAX) = N'_______________________________
Authorised Signatory
HR Department
Company A Pvt Ltd
PAN: AAAAA0000A';

MERGE INTO [dbo].[HRM_Letter_Template] AS T
USING (VALUES
    ('OFFER_LETTER',       N'Offer Letter',       N'offer',   N'Offer of Employment - {{EmpName}}',   @offerBody,      @sig),
    ('EXPERIENCE_LETTER',  N'Experience Letter',  N'exit',    N'Experience Certificate - {{EmpName}}', @experienceBody, @sig),
    ('SALARY_CERTIFICATE', N'Salary Certificate', N'salary',  N'Salary Certificate - {{EmpName}}',     @salaryBody,     @sig)
) AS S (Code, Name, Category, Subject, BodyTemplate, SignatureBlock)
ON T.Code = S.Code
WHEN NOT MATCHED THEN
    INSERT (Code, Name, Category, Subject, BodyTemplate, SignatureBlock)
    VALUES (S.Code, S.Name, S.Category, S.Subject, S.BodyTemplate, S.SignatureBlock);
GO

PRINT '[OK] Standard letter templates seeded.';
SELECT Code, Name, Category, IsActive FROM [dbo].[HRM_Letter_Template] ORDER BY Category, Name;
GO
