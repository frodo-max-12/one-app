-- =====================================================================
-- 40_BN_PdcReminderLog.sql  (App DB: BizNAV_App)
-- Audit + de-dup log for the PDC "cheque deposit reminder" WhatsApp cron.
--
-- One row per (cheque × tier × recipient phone). The cron checks this table
-- before sending so a given cheque's 5/3/1/0-day reminder to a given phone
-- fires at most once — safe to re-run the cron any number of times per day.
--
-- Mirrors BN_ReminderLog (payment reminders) but keyed on cheque + DaysBefore.
-- Additive; safe to run multiple times.
-- =====================================================================
IF OBJECT_ID('dbo.BN_PdcReminderLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.BN_PdcReminderLog (
        Id             INT IDENTITY(1,1) PRIMARY KEY,
        CompanyCode    NVARCHAR(10)   NOT NULL,          -- COMPANYA | COMPANYB
        PDCId          INT            NULL,              -- BN_PDC.PDCId (source cheque)
        CustomerCode   NVARCHAR(50)   NULL,              -- NAV Customer [No_]
        CustomerName   NVARCHAR(200)  NULL,
        ChequeNo       NVARCHAR(50)   NULL,
        ChequeDate     DATE           NULL,              -- post-dated cheque / deposit date
        Amount         DECIMAL(18, 2) NULL,
        BankName       NVARCHAR(100)  NULL,              -- customer's bank (drawn on)
        DaysBefore     INT            NOT NULL,          -- 5 | 3 | 1 | 0 (0 = deposit day)
        RecipientKind  NVARCHAR(30)   NULL,              -- CUSTOMER | SALESPERSON | ROLE_CC:... | TEST_FORWARD
        PhoneTo        NVARCHAR(30)   NULL,
        TemplateName   NVARCHAR(100)  NULL,
        WaMessageId    NVARCHAR(100)  NULL,              -- Meta wamid on success
        Status         NVARCHAR(20)   NOT NULL,          -- SENT | FAILED | SKIPPED
        ErrorMessage   NVARCHAR(500)  NULL,
        IsManual       BIT            NOT NULL DEFAULT 0,-- 1 = fired from an on-demand run
        SentAt         DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        INDEX IX_BN_PdcReminderLog_Dedup   (CompanyCode, ChequeNo, ChequeDate, DaysBefore, PhoneTo, Status),
        INDEX IX_BN_PdcReminderLog_Cheque  (CompanyCode, ChequeNo, ChequeDate),
        INDEX IX_BN_PdcReminderLog_Sent    (SentAt)
    );
    PRINT 'Created dbo.BN_PdcReminderLog';
END
ELSE
    PRINT 'dbo.BN_PdcReminderLog already exists — no change.';
