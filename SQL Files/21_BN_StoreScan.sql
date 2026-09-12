/* ============================================================================
   20_BN_StoreScan.sql
   Store Electrical module — "Retailer — Store Auditing" sub-module
   Stores every inward / outward scan captured by the mobile OCR scanner.

   Module : backend/modules/store
   DB     : BizNAV_App   (NEVER write to NAV_Live — NAV is read-only)

   Follows the BN_ table convention used by 13_BN_Warehouse_Tables.sql:
     Company / IsActive / CreatedAt / CreatedBy / UpdatedAt  + soft-delete.

   >>> COORDINATION: confirm that 20 is still free before merge.
       (He has used through 19_BN_WhStock_SourcePo.sql.)
   ============================================================================ */

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'BN_StoreScan')
BEGIN
    CREATE TABLE dbo.BN_StoreScan (
        Id              INT IDENTITY(1,1) PRIMARY KEY,

        /* ---- what was scanned ---- */
        ModelName       NVARCHAR(200)   NOT NULL,            -- full model line as printed
        QtyPerBox       INT             NOT NULL DEFAULT 1,  -- units inside one box
        Boxes           INT             NOT NULL DEFAULT 1,  -- number of boxes scanned
        Qty             INT             NOT NULL,            -- signed GRAND total = QtyPerBox×Boxes (− for outward)
        Direction       VARCHAR(10)     NOT NULL,            -- 'IN' or 'OUT'
        ItemCode        NVARCHAR(50)     NULL,               -- EAN / item code if OCR caught it
        Brand           NVARCHAR(50)     NULL,               -- auto-detected brand (RETAILER, etc.)

        /* ---- scan provenance / audit trail ---- */
        ScanStatus      VARCHAR(10)     NOT NULL,            -- 'GREEN' (auto) or 'YELLOW' (confirmed)
        OcrSource       VARCHAR(20)      NULL,               -- 'phone' | 'phone+cloud' | 'hold'
        OcrRawText      NVARCHAR(MAX)    NULL,               -- raw OCR text (debug / re-parse)
        ImagePath       NVARCHAR(400)    NULL,               -- saved carton photo (uploads/store/...)
        CapturedAt      DATETIME2       NOT NULL,            -- when the scan was taken on device

        /* ---- BN_ standard columns (match warehouse pattern) ---- */
        Company         NVARCHAR(100)   NOT NULL,            -- tenant / company scope
        IsActive        BIT             NOT NULL DEFAULT 1,  -- soft-delete flag
        CreatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        CreatedBy       NVARCHAR(150)    NULL,               -- user email from session
        UpdatedAt       DATETIME2        NULL
    );

    /* Helpful indexes for the Total Audit view (group by model, filter by direction) */
    CREATE INDEX IX_BN_StoreScan_Company_Active
        ON dbo.BN_StoreScan (Company, IsActive);

    CREATE INDEX IX_BN_StoreScan_Model
        ON dbo.BN_StoreScan (Company, IsActive, ModelName);

    CREATE INDEX IX_BN_StoreScan_Direction
        ON dbo.BN_StoreScan (Company, IsActive, Direction);

    PRINT 'Created table dbo.BN_StoreScan + indexes';
END
ELSE
BEGIN
    PRINT 'dbo.BN_StoreScan already exists — skipping';
END
GO
