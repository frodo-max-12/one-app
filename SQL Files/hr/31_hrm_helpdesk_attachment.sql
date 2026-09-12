-- ============================================================================
-- ONE App Lens — Phase 4C — HRM_Helpdesk_Attachment
-- File:  SQL Files/hr/31_hrm_helpdesk_attachment.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Helpdesk_Attachment — files attached to a ticket. The physical
--   file lives on disk at backend/uploads/hr/helpdesk/{TicketId}/; this row
--   stores the metadata + display name + uploader. Soft-archive via
--   IsArchived (the file on disk is left in place — no auto-delete).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Helpdesk_Attachment]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Helpdesk_Attachment] (
        AttachmentId  BIGINT         IDENTITY(1,1) PRIMARY KEY,
        TicketId      INT            NOT NULL,
        CommentId     BIGINT         NULL,                -- optional — link to the comment that introduced this file
        FileName      NVARCHAR(255)  NOT NULL,            -- original upload name
        StoredName    NVARCHAR(300)  NOT NULL,            -- on-disk name (timestamp_safeName)
        StoredPath    NVARCHAR(600)  NOT NULL,            -- absolute or relative path
        MimeType      NVARCHAR(150)  NULL,
        FileSize      BIGINT         NULL,
        UploadedBy    INT            NOT NULL,
        UploadedAt    DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        IsArchived    BIT            NOT NULL DEFAULT 0,

        INDEX IX_HRM_HDA_Ticket (TicketId, IsArchived, UploadedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Helpdesk_Attachment created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Helpdesk_Attachment already exists.';
GO

SELECT TOP 0 * FROM [dbo].[HRM_Helpdesk_Attachment];
GO
