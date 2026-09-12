-- =====================================================================
-- 37_BN_Notification.sql  —  ONE App unified Notification inbox (v1.13)
-- App DB: BizNAV_App (writable). ADDITIVE — safe to run on live prod.
--
-- One row = one notification for one user. Written by:
--   • event hooks (notify() called inside route handlers — leave approved, etc.)
--   • the daily scan / NAV poll cron (services/notificationCron.js)
-- Read by: the in-app bell (GET /api/notifications) and pushed to the phone
-- via FCM (services/fcm.js). RefKey de-dupes so the daily scan does not
-- re-insert the same "visit today" every morning.
-- =====================================================================
IF OBJECT_ID('dbo.BN_Notification', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BN_Notification (
    NotifId        INT IDENTITY(1,1) PRIMARY KEY,
    UserId         INT           NOT NULL,          -- recipient (User_Login.Id)
    Category       NVARCHAR(30)  NULL,              -- sales | hr | warehouse | store | system
    Type           NVARCHAR(50)  NOT NULL,          -- visit_today | payment_overdue | leave_approved | invoice_created | ...
    Severity       NVARCHAR(10)  NOT NULL DEFAULT 'info',  -- info | success | warning | critical
    Title          NVARCHAR(200) NOT NULL,
    Body           NVARCHAR(1000) NULL,
    DeepLink       NVARCHAR(300) NULL,              -- in-app path opened on tap, e.g. /modules/sales/visitplan.html
    RefKey         NVARCHAR(200) NULL,              -- de-dup key, e.g. 'visit:2026-08-18:1234'
    DueDate        DATE          NULL,              -- optional (for due-based alerts)
    Company        NVARCHAR(10)  NULL,              -- optional context (COMPANYA/COMPANYB)
    Meta           NVARCHAR(MAX) NULL,              -- optional JSON payload
    IsRead         BIT           NOT NULL DEFAULT 0,
    ReadAt         DATETIME2     NULL,
    PushSentAt     DATETIME2     NULL,              -- FCM delivery bookkeeping
    WaSentAt       DATETIME2     NULL,              -- WhatsApp escalation bookkeeping
    EmailSentAt    DATETIME2     NULL,
    IsActive       BIT           NOT NULL DEFAULT 1,-- soft delete / dismiss
    CreatedByUserId INT          NULL,              -- who caused it (optional)
    CreatedAt      DATETIME2     NOT NULL DEFAULT SYSDATETIME()
  );

  -- Bell list + unread badge (the hot path).
  CREATE INDEX IX_BN_Notification_User
    ON dbo.BN_Notification (UserId, IsActive, IsRead, CreatedAt DESC);

  -- De-dup lookups by RefKey (per user).
  CREATE INDEX IX_BN_Notification_RefKey
    ON dbo.BN_Notification (UserId, RefKey)
    WHERE RefKey IS NOT NULL;
END
GO
