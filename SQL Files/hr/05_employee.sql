-- ============================================================================
-- ONE App Lens — Phase 0 — Table 5/5
-- File:  SQL Files/hr/05_employee.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_Employee — the HR-side extension of User_Login. We deliberately
--   keep auth-critical fields (Username/Password/Role/CompanyACode/CompanyBCode) on
--   User_Login and only put HR profile data here so the existing login flow
--   does NOT change in Phase 0.
--
--   Mirrors the GreytHR Employee Profile sections we'll need from Phase 1:
--     - Employee Information (gender, login username, mobile, ext)
--     - Personal Information (DOB, blood group, marital, nationality)
--     - Contact (address, city, district, state, country, pincode, phones, email)
--     - Emergency Contact (name, relationship, phone)
--     - Joining info (DOJ, designation, department, location, reporting manager)
--     - Face enrolment (path to enrolled face descriptor for face-api.js)
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Employee]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Employee] (
        EmpId            INT            IDENTITY(1,1) PRIMARY KEY,
        UserId           INT            NOT NULL UNIQUE,       -- 1:1 with User_Login.Id
        EmpCode          NVARCHAR(50)   NULL,                  -- canonical employee code shown on profile (e.g. SJ10070)

        -- Employee Information
        Title            NVARCHAR(10)   NULL,                  -- Mr/Mrs/Ms/Dr
        FirstName        NVARCHAR(100)  NULL,
        MiddleName       NVARCHAR(100)  NULL,
        LastName         NVARCHAR(100)  NULL,
        NickName         NVARCHAR(50)   NULL,
        Gender           NVARCHAR(10)   NULL,                  -- 'Male'|'Female'|'Other'
        Mobile           NVARCHAR(20)   NULL,
        Extension        NVARCHAR(10)   NULL,
        WorkEmail        NVARCHAR(200)  NULL,
        PersonalEmail    NVARCHAR(200)  NULL,

        -- Personal Information
        DOB              DATE           NULL,
        BloodGroup       NVARCHAR(10)   NULL,
        MaritalStatus    NVARCHAR(20)   NULL,                  -- 'Single'|'Married'|'Divorced'|'Widowed'
        MarriageDate     DATE           NULL,
        SpouseName       NVARCHAR(150)  NULL,
        FatherName       NVARCHAR(150)  NULL,
        MotherName       NVARCHAR(150)  NULL,
        Nationality      NVARCHAR(50)   NULL DEFAULT 'Indian',
        PAN              NVARCHAR(20)   NULL,
        Aadhaar          NVARCHAR(20)   NULL,                  -- consider encryption later

        -- Contact (permanent)
        Address          NVARCHAR(500)  NULL,
        City             NVARCHAR(100)  NULL,
        District         NVARCHAR(100)  NULL,
        State            NVARCHAR(100)  NULL,
        Country          NVARCHAR(100)  NULL DEFAULT 'India',
        Pincode          NVARCHAR(10)   NULL,
        AltPhone         NVARCHAR(20)   NULL,

        -- Emergency Contact
        EmgName          NVARCHAR(150)  NULL,
        EmgRelationship  NVARCHAR(50)   NULL,
        EmgPhone         NVARCHAR(20)   NULL,
        EmgAddress       NVARCHAR(500)  NULL,

        -- Joining / Position
        DateOfJoining    DATE           NULL,
        Designation      NVARCHAR(150)  NULL,
        Department       NVARCHAR(50)   NULL,                  -- 'SALES' | 'FAE' | 'CSR' | 'STORE' | 'PURCHASE' | 'ACCOUNT' | 'PRODUCT' | 'HR' | 'ADMIN'
        Location         NVARCHAR(100)  NULL,                  -- 'Pune' | 'Bangalore' | ...
        ReportingManagerId INT          NULL,                  -- FK -> HRM_Employee.EmpId
        ConfirmationDate DATE           NULL,
        EmployeeType     NVARCHAR(20)   NULL DEFAULT 'Permanent',  -- 'Permanent'|'Probation'|'Contract'|'Intern'

        -- Face enrolment for Lens
        EnrolledFaceDescriptor NVARCHAR(MAX) NULL,             -- JSON array of 128-dim face-api.js descriptor
        EnrolledSelfieUrl NVARCHAR(500) NULL,
        EnrolledAt        DATETIME2(0)  NULL,

        -- Mobile app device fingerprint (set at first install; helps detect "shared device" abuse)
        DeviceId         NVARCHAR(100)  NULL,
        DeviceModel      NVARCHAR(100)  NULL,
        DeviceLastSeenAt DATETIME2(0)   NULL,

        -- Lifecycle
        IsActive         BIT            NOT NULL DEFAULT 1,
        ResignDate       DATE           NULL,
        LastWorkingDay   DATE           NULL,
        SettledOn        DATE           NULL,
        FitToBeRehired   BIT            NULL,
        AltEmailOnExit   NVARCHAR(200)  NULL,
        AltMobileOnExit  NVARCHAR(20)   NULL,

        CreatedAt        DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt        DATETIME2(0)   NULL,

        INDEX IX_HRM_Emp_Dept     (Department, IsActive),
        INDEX IX_HRM_Emp_Manager  (ReportingManagerId)
    );

    PRINT '[OK] dbo.HRM_Employee created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Employee already exists.';
END
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Employee';
GO
