-- ============================================================================
-- ONE App Lens — Phase 6B — ALTER HRM_Employee (WorkflowDelegateUserId)
-- File:  SQL Files/hr/52_alter_hrm_employee_workflow_delegate.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT ADDS:
--   HRM_Employee.WorkflowDelegateUserId — when this user is currently on
--   approved leave (HRM_Leave.Status='approved' overlapping today), the
--   workflow engine auto-routes their pending approvals to this delegate
--   instead of holding them up. NULL = no permanent delegate.
--
--   This is separate from "Reports To" (ReportingManagerId, which already
--   exists). A delegate is a peer who handles approvals during absences;
--   the reporting line stays unchanged.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'WorkflowDelegateUserId')
BEGIN
    ALTER TABLE [dbo].[HRM_Employee] ADD WorkflowDelegateUserId INT NULL;
    PRINT '[OK] HRM_Employee.WorkflowDelegateUserId added.';
END
ELSE PRINT '[SKIP] HRM_Employee.WorkflowDelegateUserId already exists.';
GO
