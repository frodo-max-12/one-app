-- ============================================================================
-- ONE App Lens — Phase 4C — HRM_Helpdesk_Ticket
-- File:  SQL Files/hr/29_hrm_helpdesk_ticket.sql
-- Date:  2026-05-22
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. ADDITIVE only.
--   * SET XACT_ABORT ON.
--   * Zero data loss; auto-rollback on any failure.
--
-- WHAT IT CREATES:
--   dbo.HRM_Helpdesk_Ticket — one row per support ticket raised by any
--   employee. The reviewer (HR) picks it up via AssignedToUserId. Status
--   moves through: open → in-progress → on-hold|resolved → closed.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Helpdesk_Ticket]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Helpdesk_Ticket] (
        TicketId          INT            IDENTITY(1,1) PRIMARY KEY,
        TicketNo          NVARCHAR(20)   NULL,              -- friendly display, e.g. 'HD-2026-0001' (filled by trigger or app)
        UserId            INT            NOT NULL,          -- the employee who raised it (User_Login.Id)
        UserCode          NVARCHAR(50)   NULL,              -- denorm for fast filtering
        Category          NVARCHAR(50)   NOT NULL,          -- 'Employee Information' | 'Income Tax' | 'Loans' | 'Leave & Attendance' | 'Payroll' | 'IT / Access' | 'Other'
        Subject           NVARCHAR(200)  NOT NULL,
        Description       NVARCHAR(MAX)  NULL,
        Priority          NVARCHAR(10)   NOT NULL DEFAULT 'Medium',   -- Low | Medium | High | Critical

        Status            NVARCHAR(20)   NOT NULL DEFAULT 'open',     -- open | in-progress | on-hold | resolved | closed
        AssignedToUserId  INT            NULL,                         -- FK -> User_Login.Id (HR member who owns it)
        AssignedAt        DATETIME2(0)   NULL,

        ResolvedByUserId  INT            NULL,
        ResolvedAt        DATETIME2(0)   NULL,
        Resolution        NVARCHAR(MAX)  NULL,                         -- final answer / fix summary

        ClosedByUserId    INT            NULL,
        ClosedAt          DATETIME2(0)   NULL,

        CreatedAt         DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt         DATETIME2(0)   NULL,

        INDEX IX_HRM_HD_User      (UserId, Status, CreatedAt DESC),
        INDEX IX_HRM_HD_Assigned  (AssignedToUserId, Status, CreatedAt DESC),
        INDEX IX_HRM_HD_Status    (Status, Priority, CreatedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Helpdesk_Ticket created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Helpdesk_Ticket already exists.';
GO

SELECT TOP 0 * FROM [dbo].[HRM_Helpdesk_Ticket];
GO
