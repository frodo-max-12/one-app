// =====================================================================
// modules/hr/routes/whois.js — "Who Is In" aggregate
// Mounted at /api/hr/whois/* by ../index.js
//
// GET /today  — counts + names for On Time / Late In / Not Yet In / Out Of Office
//
// Notes:
//   - "On Time"     = signed in before/at shift start (default 09:45)
//   - "Late In"     = signed in after shift start
//   - "Not Yet In"  = active employee, no sign-in row today
//   - "Out Of Office" = on leave / holiday today (Status in L,H,HD)
//   - Scoping: admin/operation head/director → all users; heads → team only;
//     regular sales → just themselves (mirrors existing auth.js role buckets).
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isSalesHead, isLensAdmin } = require('../../../auth');

const DEFAULT_SHIFT_START = '09:45:00';

router.get('/today', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const user = req.user;
    const today = new Date(); today.setHours(0,0,0,0);
    const shiftCutoff = req.query.shiftStart || DEFAULT_SHIFT_START;

    // Build scope: which User_Login.Id values to include
    let scopeWhere = '';
    const r = pool.request();
    r.input('date',     sql.Date,         today);
    r.input('cutoff',   sql.VarChar(8),   shiftCutoff);

    if (isLensAdmin(user)) {
      scopeWhere = ''; // everyone
    } else if (isSalesHead(user)) {
      // sees own + team — derive via shared CompanyACode/CompanyBCode prefix codes
      const codes = ((user.companyaCode || '') + '/' + (user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length === 0) {
        return res.json({ ok: true, scope: 'self', counts: zeroCounts(), employees: { onTime: [], lateIn: [], notYetIn: [], outOfOffice: [] } });
      }
      codes.forEach((c, i) => r.input('c' + i, sql.NVarChar(50), c));
      scopeWhere = `AND (
        EXISTS (SELECT 1 FROM string_split(UL.CompanyACode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@c'+i).join(',')}))
        OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@c'+i).join(',')}))
      )`;
    } else {
      r.input('selfId', sql.Int, user.id);
      scopeWhere = 'AND UL.Id = @selfId';
    }

    const result = await r.query(`
      SELECT
        UL.Id        AS UserId,
        UL.Name      AS Name,
        UL.Email     AS Email,
        UL.CompanyACode   AS CompanyACode,
        A.SignInTime AS SignInTime,
        A.Status     AS Status,
        CASE
          WHEN A.Status IN ('L','H','HD') THEN 'outOfOffice'
          WHEN A.SignInTime IS NULL       THEN 'notYetIn'
          WHEN CONVERT(time, A.SignInTime) <= CONVERT(time, @cutoff) THEN 'onTime'
          ELSE 'lateIn'
        END AS Bucket
      FROM [dbo].[User_Login] UL
      LEFT JOIN [dbo].[HRM_Attendance] A
        ON A.UserId = UL.Id AND A.AttDate = @date AND A.Session = 1
      WHERE UL.IsActive = 1
        ${scopeWhere}
      ORDER BY UL.Name;
    `);

    const out = { onTime: [], lateIn: [], notYetIn: [], outOfOffice: [] };
    for (const row of result.recordset) {
      out[row.Bucket].push({
        userId:     row.UserId,
        name:       row.Name,
        email:      row.Email,
        companyaCode:    row.CompanyACode,
        signInTime: row.SignInTime,
        status:     row.Status,
      });
    }
    return res.json({
      ok: true,
      counts: {
        onTime:      out.onTime.length,
        lateIn:      out.lateIn.length,
        notYetIn:    out.notYetIn.length,
        outOfOffice: out.outOfOffice.length,
      },
      employees: out,
    });
  } catch (err) {
    console.error('[/api/hr/whois/today] failed:', err.message);
    return res.status(500).json({ message: 'Who-is-in failed', detail: err.message });
  }
});

function zeroCounts() {
  return { onTime: 0, lateIn: 0, notYetIn: 0, outOfOffice: 0 };
}

module.exports = router;
