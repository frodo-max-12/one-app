-- ============================================================================
-- ONE App Lens — Phase 6A — HRM_Employee.IsMetroEmployee + auto-seed
-- File:  SQL Files/hr/48_alter_hrm_employee_metro.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--   * Single nullable column with DEFAULT 0.
--   * Auto-seed by Location uses NULL-safe LIKE so existing rows that
--     already have IsMetroEmployee set are NOT overwritten.
--
-- WHAT IT DOES:
--   Adds IsMetroEmployee (BIT) to HRM_Employee. Used by the tax engine
--   (services/taxEngine.js::computeHraExemption) to apply the 50% basic-salary
--   cap on HRA exemption vs the 40% non-metro cap (per Section 10(13A) of
--   the Income-tax Act).
--
--   For HRA purposes ONLY four cities count as metros — Mumbai, Delhi,
--   Chennai, Kolkata. Bangalore/Hyderabad/Pune/Ahmedabad are economically
--   metros but the IT Act still classifies them as non-metro for HRA → 40 %.
--   Auto-seeds based on the Location column.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IsMetroEmployee')
BEGIN
    ALTER TABLE [dbo].[HRM_Employee] ADD IsMetroEmployee BIT NOT NULL DEFAULT 0;
    PRINT '[OK] HRM_Employee.IsMetroEmployee added.';
END
ELSE PRINT '[SKIP] HRM_Employee.IsMetroEmployee already exists.';
GO

-- Auto-seed: only the 4 cities the Income-tax Act treats as metros for HRA.
-- Uses LIKE to catch variants ("Mumbai", "Greater Mumbai", "Navi Mumbai", etc.)
UPDATE [dbo].[HRM_Employee]
SET IsMetroEmployee = 1
WHERE IsMetroEmployee = 0
  AND (
       Location LIKE '%mumbai%'
    OR Location LIKE '%delhi%'
    OR Location LIKE '%chennai%'
    OR Location LIKE '%kolkata%' OR Location LIKE '%calcutta%'
  );
PRINT '[OK] Auto-seeded IsMetroEmployee = 1 for Mumbai/Delhi/Chennai/Kolkata locations.';
GO

SELECT Location, IsMetroEmployee, COUNT(*) AS Cnt
FROM HRM_Employee
GROUP BY Location, IsMetroEmployee
ORDER BY Location;
GO
