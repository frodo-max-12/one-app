// =====================================================================
// modules/hr/routes/holiday.js — Holiday master read API
// Mounted at /api/hr/holiday/* by ../index.js
//
// GET /                  — list holidays (?year=2026&type=General|Restricted|All)
// GET /upcoming?n=4      — next N upcoming holidays from today
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate } = require('../../../auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const type = (req.query.type || 'All');
    const pool = await getAppPool();
    const r = pool.request()
      .input('y',  sql.Int,         year)
      .input('t1', sql.NVarChar(20), type === 'All' ? null : type);
    const result = await r.query(`
      SELECT HolidayId, HolidayDate, Occasion, HolidayType, Location, Company, Notes
      FROM [dbo].[HRM_Holiday]
      WHERE IsActive = 1
        AND YEAR(HolidayDate) = @y
        AND (@t1 IS NULL OR HolidayType = @t1)
      ORDER BY HolidayDate;
    `);
    return res.json({ ok: true, holidays: result.recordset });
  } catch (err) {
    console.error('[/api/hr/holiday] failed:', err.message);
    return res.status(500).json({ message: 'Holiday fetch failed', detail: err.message });
  }
});

router.get('/upcoming', authenticate, async (req, res) => {
  try {
    const n = Math.min(20, Math.max(1, parseInt(req.query.n) || 4));
    const pool = await getAppPool();
    const r = await pool.request()
      .input('n', sql.Int, n)
      .query(`
        SELECT TOP (@n) HolidayId, HolidayDate, Occasion, HolidayType
        FROM [dbo].[HRM_Holiday]
        WHERE IsActive = 1
          AND HolidayType = 'General'
          AND HolidayDate >= CAST(GETDATE() AS DATE)
        ORDER BY HolidayDate;
      `);
    return res.json({ ok: true, upcoming: r.recordset });
  } catch (err) {
    console.error('[/api/hr/holiday/upcoming] failed:', err.message);
    return res.status(500).json({ message: 'Upcoming holiday fetch failed', detail: err.message });
  }
});

module.exports = router;
