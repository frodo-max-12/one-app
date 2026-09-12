-- ============================================================================
-- ONE App Lens — Phase 6C — HRM_Letter_Issued (audit log)
-- File:  SQL Files/hr/54_hrm_letter_issued.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Letter_Issued — one row per letter HR generates. Captures
--   WHO generated WHAT for WHOM and WHEN, plus the FULLY RENDERED body
--   (placeholders already resolved). This is the audit trail —
--   regenerating the same letter later won't necessarily produce the
--   same text because employee data may have changed.
--
--   RenderedBody is stored so the original letter can be re-downloaded
--   verbatim months later. PDF can be regenerated from RenderedBody at
--   any time without re-resolving placeholders (idempotent).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Letter_Issued]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Letter_Issued] (
        LetterId        INT             IDENTITY(1,1) PRIMARY KEY,
        LetterNo        NVARCHAR(30)    NULL,                          -- friendly display, e.g. 'LTR-2026-0001'
        TemplateId      INT             NOT NULL,
        TemplateCode    NVARCHAR(40)    NOT NULL,                      -- denorm
        TemplateName    NVARCHAR(150)   NOT NULL,                      -- denorm
        ForUserId       INT             NOT NULL,                      -- the employee the letter is FOR
        ForEmpCode      NVARCHAR(50)    NULL,                          -- denorm
        ForEmpName      NVARCHAR(150)   NULL,                          -- denorm

        Subject         NVARCHAR(300)   NULL,                          -- resolved subject
        RenderedBody    NVARCHAR(MAX)   NOT NULL,                      -- placeholders already resolved
        SignatureBlock  NVARCHAR(MAX)   NULL,
        ExtraNotes      NVARCHAR(500)   NULL,                          -- HR can add a comment

        IssuedBy        INT             NOT NULL,
        IssuedByName    NVARCHAR(150)   NULL,                          -- denorm at issue time
        IssuedAt        DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),

        INDEX IX_HRM_LI_For   (ForUserId, IssuedAt DESC),
        INDEX IX_HRM_LI_Tmpl  (TemplateId, IssuedAt DESC),
        INDEX IX_HRM_LI_Date  (IssuedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Letter_Issued created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Letter_Issued already exists.';
GO
