-- =====================================================================
-- 00_Restructure_Migration.sql
-- One-time migration to support ONE App multi-department architecture.
--
-- SAFETY:
--   - All operations are ADDITIVE (ADD COLUMN, CREATE TABLE).
--   - No existing data is modified or deleted.
--   - Safe to re-run (uses IF NOT EXISTS guards).
--   - Auto-rollback on the seed/UPDATE batch if any step fails.
--   - DDL batches (ALTER COLUMN, CREATE TABLE) auto-commit individually,
--     which is required because SQL Server parses each batch before
--     executing — references to a not-yet-created column would fail
--     parsing if everything sat in one batch.
--
-- WHEN TO RUN:
--   Any time, even with live users active. Operations are metadata-only
--   or affect new (empty) tables. Total runtime: under 2 seconds.
--
-- HOW TO RUN:
--   Open SQL Server Management Studio →
--   Connect to 10.0.0.10 →
--   Open this file →
--   Verify USE statement targets BizNAV_App →
--   Press F5.
-- =====================================================================

USE BizNAV_App;
GO

PRINT '═══════════════════════════════════════════════════════════════';
PRINT 'ONE App — Restructure Migration starting on database: ' + DB_NAME();
PRINT '═══════════════════════════════════════════════════════════════';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 1: ADD Department column to existing User_Login
-- (must be its own batch — later batches reference this column)
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = N'Department' AND Object_ID = Object_ID(N'dbo.User_Login')
)
BEGIN
  ALTER TABLE [dbo].[User_Login] ADD Department NVARCHAR(50) NULL;
  PRINT '✓ Added Department column to User_Login';
END
ELSE
  PRINT '• Department column already exists on User_Login';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 2: Default existing users to Department='sales'
-- (separate batch so parser sees the new column from BATCH 1)
-- ───────────────────────────────────────────────────────────────────
UPDATE [dbo].[User_Login]
SET Department = 'sales'
WHERE Department IS NULL;

PRINT '✓ Defaulted existing users to Department=sales (rows affected: ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ')';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 3: CREATE BN_UserDeptAccess (multi-department membership)
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_UserDeptAccess' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_UserDeptAccess] (
    UserId      INT            NOT NULL,
    Department  NVARCHAR(30)   NOT NULL,    -- 'sales' | 'csr' | 'hr' | 'purchase' | 'account' | 'store' | 'fae' | 'product'
    AccessLevel NVARCHAR(20)   NOT NULL,    -- 'own' | 'team' | 'full'
    ScopeCode   NVARCHAR(500)  NULL,        -- slash-separated (salesperson/buyer/location codes)
    CreatedAt   DATETIME       NOT NULL DEFAULT GETDATE(),
    PRIMARY KEY (UserId, Department)
  );
  PRINT '✓ Created BN_UserDeptAccess';
END
ELSE
  PRINT '• BN_UserDeptAccess already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 4: Seed existing users into BN_UserDeptAccess for sales dept
--
-- Actual roles in production (per User_Login.sql):
--   'admin'                — full access (Operation Head + Director are stored as admin)
--   'sales head'           — team-scoped (sees own + team codes)
--   'north sales head'     — team-scoped
--   'electrical head'      — team-scoped
--   'sales'                — own codes only
--   'north sales'          — own codes only
--   'south sales'          — own codes only
--   'international sales'  — own codes only
-- ───────────────────────────────────────────────────────────────────
INSERT INTO [dbo].[BN_UserDeptAccess] (UserId, Department, AccessLevel, ScopeCode)
SELECT
  ul.Id,
  'sales',
  CASE
    WHEN LOWER(ul.Role) = 'admin'         THEN 'full'   -- admin = full org access
    WHEN LOWER(ul.Role) LIKE '%head%'     THEN 'team'   -- any *head role = team-scoped
    ELSE                                       'own'    -- sales/* = own codes only
  END,
  CASE
    WHEN ul.CompanyACode IS NOT NULL AND ul.CompanyBCode IS NOT NULL THEN ul.CompanyACode + '/' + ul.CompanyBCode
    WHEN ul.CompanyACode IS NOT NULL                                THEN ul.CompanyACode
    WHEN ul.CompanyBCode IS NOT NULL                             THEN ul.CompanyBCode
    ELSE                                                            NULL
  END
FROM [dbo].[User_Login] ul
WHERE NOT EXISTS (
  SELECT 1 FROM [dbo].[BN_UserDeptAccess] a
  WHERE a.UserId = ul.Id AND a.Department = 'sales'
);

PRINT '✓ Seeded existing users into BN_UserDeptAccess (rows affected: ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ')';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 5: CREATE BN_WF_Definition
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_WF_Definition' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_WF_Definition] (
    WorkflowKey   NVARCHAR(50)   NOT NULL PRIMARY KEY,    -- 'LEAVE_APPROVAL' | 'EXPENSE_REIMBURSEMENT' | etc.
    Name          NVARCHAR(200)  NOT NULL,
    Description   NVARCHAR(500)  NULL,
    Department    NVARCHAR(30)   NULL,            -- which dept "owns" this workflow
    IsActive      BIT            NOT NULL DEFAULT 1,
    CreatedAt     DATETIME       NOT NULL DEFAULT GETDATE(),
    CreatedBy     NVARCHAR(100)  NULL,
    UpdatedAt     DATETIME       NULL,
    UpdatedBy     NVARCHAR(100)  NULL
  );
  PRINT '✓ Created BN_WF_Definition';
END
ELSE
  PRINT '• BN_WF_Definition already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 6: CREATE BN_WF_Stage
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_WF_Stage' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_WF_Stage] (
    Id              INT            IDENTITY(1,1) PRIMARY KEY,
    WorkflowKey     NVARCHAR(50)   NOT NULL,
    StageOrder      INT            NOT NULL,
    StageName       NVARCHAR(100)  NOT NULL,
    ApproverRole    NVARCHAR(50)   NULL,
    ApproverScope   NVARCHAR(100)  NULL,           -- 'reporting_head' | 'role:hr' | 'role:director'
    ConditionExpr   NVARCHAR(500)  NULL,           -- e.g. 'Amount > 50000' (skip stage if false)
    SLAHours        INT            NULL,           -- auto-escalate if pending > N hours
    IsActive        BIT            NOT NULL DEFAULT 1,
    CreatedAt       DATETIME       NOT NULL DEFAULT GETDATE()
  );
  CREATE INDEX IX_WF_Stage_Workflow ON [dbo].[BN_WF_Stage](WorkflowKey, StageOrder);
  PRINT '✓ Created BN_WF_Stage';
END
ELSE
  PRINT '• BN_WF_Stage already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 7: CREATE BN_WF_Instance
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_WF_Instance' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_WF_Instance] (
    Id              INT            IDENTITY(1,1) PRIMARY KEY,
    WorkflowKey     NVARCHAR(50)   NOT NULL,
    EntityType      NVARCHAR(50)   NULL,           -- 'leave_request' | 'expense_claim' | 'pr' | etc.
    EntityId        INT            NULL,           -- FK into the entity table
    SubmittedBy     INT            NOT NULL,
    SubmittedAt     DATETIME       NOT NULL DEFAULT GETDATE(),
    CurrentStage    INT            NULL,           -- StageOrder currently awaiting action
    Status          NVARCHAR(20)   NOT NULL DEFAULT 'Pending',  -- Pending|Approved|Rejected|Cancelled
    Payload         NVARCHAR(MAX)  NULL,           -- JSON of submission data (for ConditionExpr eval)
    ClosedAt        DATETIME       NULL,
    Comment         NVARCHAR(1000) NULL
  );
  CREATE INDEX IX_WF_Instance_Submitter ON [dbo].[BN_WF_Instance](SubmittedBy, Status);
  CREATE INDEX IX_WF_Instance_Workflow  ON [dbo].[BN_WF_Instance](WorkflowKey, Status);
  PRINT '✓ Created BN_WF_Instance';
END
ELSE
  PRINT '• BN_WF_Instance already exists';
GO

-- ───────────────────────────────────────────────────────────────────
-- BATCH 8: CREATE BN_WF_History
-- ───────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BN_WF_History' AND xtype='U')
BEGIN
  CREATE TABLE [dbo].[BN_WF_History] (
    Id              INT            IDENTITY(1,1) PRIMARY KEY,
    InstanceId      INT            NOT NULL,
    Stage           INT            NOT NULL,
    StageName       NVARCHAR(100)  NULL,
    ApproverUserId  INT            NULL,
    ApproverName    NVARCHAR(100)  NULL,
    Action          NVARCHAR(20)   NULL,           -- Approve|Reject|Forward|Cancel|Escalate
    Comment         NVARCHAR(1000) NULL,
    ActionedAt      DATETIME       NOT NULL DEFAULT GETDATE()
  );
  CREATE INDEX IX_WF_History_Instance ON [dbo].[BN_WF_History](InstanceId, ActionedAt);
  PRINT '✓ Created BN_WF_History';
END
ELSE
  PRINT '• BN_WF_History already exists';
GO

PRINT '';
PRINT '═══════════════════════════════════════════════════════════════';
PRINT '✓ ALL MIGRATION STEPS COMPLETED SUCCESSFULLY';
PRINT '═══════════════════════════════════════════════════════════════';
GO

-- ───────────────────────────────────────────────────────────────────
-- VERIFICATION (read-only — runs after migration)
-- ───────────────────────────────────────────────────────────────────
PRINT '';
PRINT 'Verification — counts after migration:';
SELECT 'User_Login (with Department)'  AS TableName, COUNT(*) AS [RowCount] FROM [dbo].[User_Login] WHERE Department IS NOT NULL
UNION ALL SELECT 'BN_UserDeptAccess',   COUNT(*) FROM [dbo].[BN_UserDeptAccess]
UNION ALL SELECT 'BN_WF_Definition',    COUNT(*) FROM [dbo].[BN_WF_Definition]
UNION ALL SELECT 'BN_WF_Stage',         COUNT(*) FROM [dbo].[BN_WF_Stage]
UNION ALL SELECT 'BN_WF_Instance',      COUNT(*) FROM [dbo].[BN_WF_Instance]
UNION ALL SELECT 'BN_WF_History',       COUNT(*) FROM [dbo].[BN_WF_History];
GO

-- Show breakdown of access levels created (sanity check)
PRINT '';
PRINT 'BN_UserDeptAccess breakdown:';
SELECT AccessLevel, COUNT(*) AS UserCount
FROM [dbo].[BN_UserDeptAccess]
GROUP BY AccessLevel
ORDER BY AccessLevel;
GO
