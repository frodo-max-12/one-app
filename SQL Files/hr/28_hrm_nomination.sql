-- ============================================================================
-- ONE App Lens — Phase 3D-D2 — HRM_Nomination
-- File:  SQL Files/hr/28_hrm_nomination.sql
-- Date:  2026-05-21
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent.
--
-- WHAT IT CREATES:
--   dbo.HRM_Nomination — beneficiary nominations for PF, Gratuity, Insurance,
--   Bonus. Required by statute (PF Form-11 etc.). Each scheme may have one
--   nominee (SharePct = 100) OR multiple nominees summing to 100.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Nomination]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Nomination] (
        NominationId    INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        SchemeKind      NVARCHAR(30)   NOT NULL,        -- 'PF' | 'Gratuity' | 'Insurance' | 'Bonus' | 'Other'
        NomineeName     NVARCHAR(150)  NOT NULL,
        Relationship    NVARCHAR(50)   NOT NULL,
        DOB             DATE           NULL,
        Address         NVARCHAR(500)  NULL,
        SharePct        DECIMAL(5,2)   NOT NULL DEFAULT 100.00,   -- e.g. 100 = sole nominee; 50/50 split
        Notes           NVARCHAR(500)  NULL,

        IsActive        BIT            NOT NULL DEFAULT 1,
        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)   NULL,

        INDEX IX_HRM_Nom_User_Scheme (UserId, SchemeKind, IsActive)
    );
    PRINT '[OK] dbo.HRM_Nomination created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Nomination already exists.';
GO
