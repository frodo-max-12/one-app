-- =====================================================================
-- 38_BN_PushToken.sql  —  FCM device tokens per user (v1.13)
-- App DB: BizNAV_App (writable). ADDITIVE — safe to run on live prod.
--
-- The installed mobile app (Capacitor) registers its FCM token on login via
-- POST /api/notifications/register-token. One user can have several devices;
-- one physical device (Token) maps to exactly one current user (re-login on a
-- shared device re-points the token). services/fcm.js reads active tokens to
-- deliver a BN_Notification to the phone even when the app is closed.
-- =====================================================================
IF OBJECT_ID('dbo.BN_PushToken', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BN_PushToken (
    TokenId     INT IDENTITY(1,1) PRIMARY KEY,
    UserId      INT           NOT NULL,          -- owner (User_Login.Id)
    Token       NVARCHAR(400) NOT NULL,          -- FCM registration token
    Platform    NVARCHAR(20)  NULL,              -- android | ios | web
    DeviceInfo  NVARCHAR(200) NULL,              -- model / os (best-effort)
    IsActive    BIT           NOT NULL DEFAULT 1,
    CreatedAt   DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
    LastSeenAt  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
  );

  -- A token is globally unique to a device; upsert keys on it.
  CREATE UNIQUE INDEX UX_BN_PushToken_Token ON dbo.BN_PushToken (Token);
  CREATE INDEX IX_BN_PushToken_User ON dbo.BN_PushToken (UserId, IsActive);
END
GO
