// =====================================================================
// modules/hr/routes/payrollStructure.js — Salary structure foundation (Phase 5A)
// Mounted at /api/hr/payroll-structure/* by ../index.js
//
// Endpoints (all HR-only):
//   GET    /options                            — enums + slab info
//   GET    /components                         — list master components (?archived=)
//   POST   /components                         — create component
//   PATCH  /components/:id                     — update component
//   DELETE /components/:id                     — soft-archive
//
//   GET    /structures                         — list structures (with linked count)
//   POST   /structures                         — create structure + components in one shot
//   GET    /structures/:id                     — detail with linked components
//   PATCH  /structures/:id                     — update header + replace junction (replace-all semantic)
//   DELETE /structures/:id                     — soft-archive
//
//   GET    /preview?structureId=X&ctc=Y        — formula-resolved breakdown (no DB write)
//
//   GET    /employees                          — list of users with their current salary summary
//   GET    /employees/:userId/salary           — current + history for an employee
//   POST   /employees/:userId/salary           — assign new salary (auto-computes + freezes components)
//   POST   /employees/:userId/salary/:id/cancel — mark an assignment cancelled (rollback)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

// ── Constants ────────────────────────────────────────────────────────────────
const KINDS          = ['Earning', 'Deduction', 'Reimbursement'];
const TAXABILITIES   = ['Taxable', 'NonTaxable', 'PartialExempt'];
const FORMULA_TYPES  = ['Fixed', 'PctOfBasic', 'PctOfCTC', 'PctOfGross', 'Slab', 'Balancer', 'Manual'];

// Maharashtra PT slab (FY 2026-27). Monthly gross thresholds.
// Feb-extra-₹100 logic belongs in the payroll-run (Phase 5B), not the structure.
function ptMaharashtraMonthly(monthlyGross) {
  if (!monthlyGross || monthlyGross <= 7500)  return 0;
  if (monthlyGross <= 10000)                   return 175;
  return 200;
}

// ESI is only deducted if monthly gross ≤ ₹21,000.
function isEsiEligible(monthlyGross) {
  return monthlyGross > 0 && monthlyGross <= 21000;
}

// ── HR gate on every endpoint ────────────────────────────────────────────────
router.use(authenticate);
router.use((req, res, next) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  next();
});

// ── GET /options ─────────────────────────────────────────────────────────────
router.get('/options', (req, res) => {
  res.json({
    kinds: KINDS,
    taxabilities: TAXABILITIES,
    formulaTypes: FORMULA_TYPES,
    ptSlabs: [
      { upTo: 7500,   amount: 0,   note: '≤ ₹7,500' },
      { upTo: 10000,  amount: 175, note: '₹7,501 – ₹10,000' },
      { upTo: null,   amount: 200, note: '> ₹10,000 (Feb +₹100 to total ₹2,500/yr — applied at payroll run)' },
    ],
    esiCeiling: 21000,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ────────────────────────────────────────────────────────────────────────────
router.get('/components', async (req, res) => {
  const archived = req.query.archived === 'true';
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT ComponentId, Code, Name, Kind, Taxability,
             IsStatutoryPF, IsStatutoryESI, IsStatutoryPT,
             FormulaType, DefaultValue, DisplayOrder, IsActive
      FROM HRM_Salary_Component
      WHERE IsActive = ${archived ? 0 : 1}
      ORDER BY DisplayOrder, Name;
    `);
    res.json({ components: r.recordset });
  } catch (err) {
    console.error('[components/list]', err);
    res.status(500).json({ message: 'Failed to list', error: err.message });
  }
});

router.post('/components', async (req, res) => {
  const b = req.body || {};
  const err = validateComponentBody(b, true);
  if (err) return res.status(400).json({ message: err });
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('cd',  sql.NVarChar(20),  b.code.trim().toUpperCase())
      .input('nm',  sql.NVarChar(100), b.name.trim())
      .input('k',   sql.NVarChar(15),  b.kind)
      .input('tx',  sql.NVarChar(20),  b.taxability)
      .input('pf',  sql.Bit,           b.isStatutoryPF  ? 1 : 0)
      .input('esi', sql.Bit,           b.isStatutoryESI ? 1 : 0)
      .input('pt',  sql.Bit,           b.isStatutoryPT  ? 1 : 0)
      .input('ft',  sql.NVarChar(20),  b.formulaType)
      .input('dv',  sql.Decimal(15,2), b.defaultValue == null ? null : Number(b.defaultValue))
      .input('ord', sql.Int,           parseInt(b.displayOrder, 10) || 50)
      .query(`
        INSERT INTO HRM_Salary_Component
          (Code, Name, Kind, Taxability, IsStatutoryPF, IsStatutoryESI, IsStatutoryPT, FormulaType, DefaultValue, DisplayOrder)
        OUTPUT INSERTED.ComponentId
        VALUES (@cd, @nm, @k, @tx, @pf, @esi, @pt, @ft, @dv, @ord);
      `);
    res.status(201).json({ componentId: r.recordset[0].ComponentId });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE'))
      return res.status(409).json({ message: 'Component code already exists' });
    console.error('[components/create]', e);
    res.status(500).json({ message: 'Failed to create', error: e.message });
  }
});

router.patch('/components/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.name        != null) { r.input('nm', sql.NVarChar(100), String(b.name).trim());        sets.push('Name = @nm'); }
    if (b.kind        != null) {
      if (!KINDS.includes(b.kind))                  return res.status(400).json({ message: 'Invalid kind' });
      r.input('k', sql.NVarChar(15), b.kind);        sets.push('Kind = @k');
    }
    if (b.taxability  != null) {
      if (!TAXABILITIES.includes(b.taxability))     return res.status(400).json({ message: 'Invalid taxability' });
      r.input('tx', sql.NVarChar(20), b.taxability); sets.push('Taxability = @tx');
    }
    if (b.formulaType != null) {
      if (!FORMULA_TYPES.includes(b.formulaType))   return res.status(400).json({ message: 'Invalid formula type' });
      r.input('ft', sql.NVarChar(20), b.formulaType); sets.push('FormulaType = @ft');
    }
    if (b.defaultValue !== undefined) { r.input('dv', sql.Decimal(15,2), b.defaultValue == null ? null : Number(b.defaultValue)); sets.push('DefaultValue = @dv'); }
    if (b.isStatutoryPF  !== undefined) { r.input('pf',  sql.Bit, b.isStatutoryPF  ? 1 : 0); sets.push('IsStatutoryPF  = @pf'); }
    if (b.isStatutoryESI !== undefined) { r.input('esi', sql.Bit, b.isStatutoryESI ? 1 : 0); sets.push('IsStatutoryESI = @esi'); }
    if (b.isStatutoryPT  !== undefined) { r.input('pt',  sql.Bit, b.isStatutoryPT  ? 1 : 0); sets.push('IsStatutoryPT  = @pt'); }
    if (b.displayOrder  != null)  { r.input('ord', sql.Int, parseInt(b.displayOrder, 10) || 50); sets.push('DisplayOrder = @ord'); }
    if (b.isActive      !== undefined) { r.input('act', sql.Bit, b.isActive ? 1 : 0); sets.push('IsActive = @act'); }
    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE HRM_Salary_Component SET ${sets.join(', ')} WHERE ComponentId = @id;`);
    res.json({ ok: true });
  } catch (e) { console.error('[components/patch]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.delete('/components/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Salary_Component SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE ComponentId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[components/delete]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

function validateComponentBody(b, isNew) {
  if (isNew && !(b.code && String(b.code).trim()))    return 'Code is required';
  if (isNew && !(b.name && String(b.name).trim()))    return 'Name is required';
  if (isNew && !KINDS.includes(b.kind))               return 'Invalid kind';
  if (isNew && !TAXABILITIES.includes(b.taxability))  return 'Invalid taxability';
  if (isNew && !FORMULA_TYPES.includes(b.formulaType))return 'Invalid formula type';
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// STRUCTURES
// ────────────────────────────────────────────────────────────────────────────
router.get('/structures', async (req, res) => {
  const archived = req.query.archived === 'true';
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT S.StructureId, S.Code, S.Name, S.Description, S.IsActive,
             S.CreatedAt, S.UpdatedAt,
             (SELECT COUNT(*) FROM HRM_Salary_Structure_Component J WHERE J.StructureId = S.StructureId) AS CompCount,
             (SELECT COUNT(*) FROM HRM_Employee_Salary E WHERE E.StructureId = S.StructureId AND E.Status = 'active') AS InUseCount
      FROM HRM_Salary_Structure S
      WHERE S.IsActive = ${archived ? 0 : 1}
      ORDER BY S.Name;
    `);
    res.json({ structures: r.recordset });
  } catch (e) { console.error('[structures/list]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.post('/structures', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  if (!code) return res.status(400).json({ message: 'Code is required' });
  if (!name) return res.status(400).json({ message: 'Name is required' });
  const compIds = Array.isArray(b.componentIds) ? b.componentIds.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
  if (!compIds.length) return res.status(400).json({ message: 'Pick at least one component' });

  try {
    const pool = await getAppPool();
    const h = await pool.request()
      .input('cd',   sql.NVarChar(30),  code)
      .input('nm',   sql.NVarChar(150), name)
      .input('desc', sql.NVarChar(500), b.description || null)
      .query(`
        INSERT INTO HRM_Salary_Structure (Code, Name, Description)
        OUTPUT INSERTED.StructureId
        VALUES (@cd, @nm, @desc);
      `);
    const sid = h.recordset[0].StructureId;
    await linkComponents(pool, sid, compIds);
    res.status(201).json({ structureId: sid });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE'))
      return res.status(409).json({ message: 'Structure code already exists' });
    console.error('[structures/create]', e);
    res.status(500).json({ message: 'Failed', error: e.message });
  }
});

router.get('/structures/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const hQ = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Salary_Structure WHERE StructureId = @id;');
    const s = hQ.recordset[0];
    if (!s) return res.status(404).json({ message: 'Structure not found' });
    const cQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT J.StructureCompId, J.ComponentId, J.OverrideValue, J.DisplayOrder,
             C.Code, C.Name, C.Kind, C.Taxability, C.FormulaType, C.DefaultValue
      FROM HRM_Salary_Structure_Component J
      JOIN HRM_Salary_Component C ON C.ComponentId = J.ComponentId
      WHERE J.StructureId = @id
      ORDER BY J.DisplayOrder, C.Name;
    `);
    res.json({ structure: s, components: cQ.recordset });
  } catch (e) { console.error('[structures/get]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.patch('/structures/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.name        != null) { r.input('nm',   sql.NVarChar(150), String(b.name).trim()); sets.push('Name = @nm'); }
    if (b.description !== undefined) { r.input('desc', sql.NVarChar(500), b.description || null); sets.push('Description = @desc'); }
    if (b.isActive    !== undefined) { r.input('act',  sql.Bit, b.isActive ? 1 : 0);  sets.push('IsActive = @act'); }
    if (sets.length) {
      sets.push('UpdatedAt = SYSDATETIME()');
      await r.query(`UPDATE HRM_Salary_Structure SET ${sets.join(', ')} WHERE StructureId = @id;`);
    }
    // Replace-all junction (if componentIds provided)
    if (Array.isArray(b.componentIds)) {
      const compIds = b.componentIds.map(n => parseInt(n, 10)).filter(Number.isFinite);
      await pool.request().input('id', sql.Int, id)
        .query('DELETE FROM HRM_Salary_Structure_Component WHERE StructureId = @id;');
      if (compIds.length) await linkComponents(pool, id, compIds);
    }
    res.json({ ok: true });
  } catch (e) { console.error('[structures/patch]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.delete('/structures/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    // Refuse if any active employee salary uses this structure
    const u = await pool.request().input('id', sql.Int, id)
      .query("SELECT COUNT(*) AS Cnt FROM HRM_Employee_Salary WHERE StructureId = @id AND Status = 'active';");
    if (u.recordset[0].Cnt > 0) {
      return res.status(409).json({ message: 'Structure is in use by active employee salaries; reassign first.' });
    }
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Salary_Structure SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE StructureId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[structures/delete]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

async function linkComponents(pool, structureId, componentIds) {
  // Read each component's master DisplayOrder so the junction inherits the same default order
  const ordQ = await pool.request().query(`
    SELECT ComponentId, DisplayOrder FROM HRM_Salary_Component
    WHERE ComponentId IN (${componentIds.join(',')});
  `);
  const ordMap = {};
  ordQ.recordset.forEach(r => { ordMap[r.ComponentId] = r.DisplayOrder; });
  for (const cid of componentIds) {
    await pool.request()
      .input('sid', sql.Int, structureId)
      .input('cid', sql.Int, cid)
      .input('ord', sql.Int, ordMap[cid] || 50)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM HRM_Salary_Structure_Component WHERE StructureId = @sid AND ComponentId = @cid)
          INSERT INTO HRM_Salary_Structure_Component (StructureId, ComponentId, DisplayOrder)
          VALUES (@sid, @cid, @ord);
      `);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// FORMULA RESOLVER — used by /preview and by POST /employees/:id/salary
// ────────────────────────────────────────────────────────────────────────────
async function resolveStructureFor(pool, structureId, annualCtc) {
  const cQ = await pool.request().input('id', sql.Int, structureId).query(`
    SELECT J.ComponentId, J.OverrideValue, J.DisplayOrder,
           C.Code, C.Name, C.Kind, C.Taxability, C.FormulaType, C.DefaultValue
    FROM HRM_Salary_Structure_Component J
    JOIN HRM_Salary_Component C ON C.ComponentId = J.ComponentId
    WHERE J.StructureId = @id AND C.IsActive = 1
    ORDER BY J.DisplayOrder, C.Name;
  `);
  const list = cQ.recordset;
  if (!list.length) return { lines: [], monthlyGross: 0 };

  const ctcMonthly = Number(annualCtc) / 12;
  const rowsByCode = {};
  const orderedRows = list.map(c => {
    const value = c.OverrideValue != null ? Number(c.OverrideValue) : (c.DefaultValue != null ? Number(c.DefaultValue) : 0);
    const row = {
      componentId:   c.ComponentId,
      code:          c.Code,
      name:          c.Name,
      kind:          c.Kind,
      taxability:    c.Taxability,
      formulaType:   c.FormulaType,
      formulaValue:  value,
      monthly:       0,
      annual:        0,
      formulaSummary: formulaSummary(c.FormulaType, value),
      displayOrder:  c.DisplayOrder,
    };
    rowsByCode[c.Code] = row;
    return row;
  });

  // Pass 1: Earnings except Balancer
  for (const row of orderedRows) {
    if (row.kind !== 'Earning' || row.formulaType === 'Balancer') continue;
    row.monthly = computeMonthly(row, { ctcMonthly, basicMonthly: rowsByCode.BASIC?.monthly || 0, grossMonthly: 0 });
  }

  // Pass 2: sum of all non-Balancer Earnings = pre-balancer gross
  const earningsSum = orderedRows.filter(r => r.kind === 'Earning' && r.formulaType !== 'Balancer')
    .reduce((s, r) => s + r.monthly, 0);

  // Pass 3: Balancer = monthly CTC - earningsSum (clamped ≥ 0)
  const balancer = orderedRows.find(r => r.kind === 'Earning' && r.formulaType === 'Balancer');
  if (balancer) {
    balancer.monthly = Math.max(0, round2(ctcMonthly - earningsSum));
  }

  // Final monthly gross = sum of all Earnings (incl. Balancer)
  const monthlyGross = orderedRows.filter(r => r.kind === 'Earning').reduce((s, r) => s + r.monthly, 0);

  // Pass 4: Deductions (need monthly gross + basic)
  for (const row of orderedRows) {
    if (row.kind === 'Earning') continue;
    if (row.code === 'ESI_EE' && !isEsiEligible(monthlyGross)) {
      row.monthly = 0;
      row.formulaSummary = `Not eligible (gross > ₹21,000)`;
      continue;
    }
    if (row.code === 'PT_MH' || row.formulaType === 'Slab') {
      row.monthly = ptMaharashtraMonthly(monthlyGross);
      row.formulaSummary = `Slab ₹${row.monthly}/mo (Maharashtra)`;
      continue;
    }
    if (row.formulaType === 'Manual') {
      row.monthly = 0;
      continue;
    }
    row.monthly = computeMonthly(row, { ctcMonthly, basicMonthly: rowsByCode.BASIC?.monthly || 0, grossMonthly: monthlyGross });
  }

  // Annual + rounding
  for (const r of orderedRows) {
    r.monthly = round2(r.monthly);
    r.annual  = round2(r.monthly * 12);
  }

  return { lines: orderedRows, monthlyGross: round2(monthlyGross), ctcMonthly: round2(ctcMonthly) };
}

function computeMonthly(row, ctx) {
  const v = Number(row.formulaValue || 0);
  switch (row.formulaType) {
    case 'Fixed':       return v;
    case 'PctOfCTC':    return (ctx.ctcMonthly  * v) / 100;
    case 'PctOfBasic':  return (ctx.basicMonthly * v) / 100;
    case 'PctOfGross':  return (ctx.grossMonthly * v) / 100;
    default:            return 0;
  }
}

function formulaSummary(type, value) {
  if (type === 'Fixed')       return `Fixed ₹${value}`;
  if (type === 'PctOfBasic')  return `${value}% of Basic`;
  if (type === 'PctOfCTC')    return `${value}% of CTC`;
  if (type === 'PctOfGross')  return `${value}% of Gross`;
  if (type === 'Balancer')    return `CTC residual`;
  if (type === 'Slab')        return `Slab-based`;
  if (type === 'Manual')      return `Manual entry`;
  return type;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── GET /preview ─────────────────────────────────────────────────────────────
router.get('/preview', async (req, res) => {
  const structureId = parseInt(req.query.structureId, 10);
  const ctc         = Number(req.query.ctc);
  if (!Number.isFinite(structureId)) return res.status(400).json({ message: 'structureId required' });
  if (!Number.isFinite(ctc) || ctc < 0) return res.status(400).json({ message: 'ctc must be a number ≥ 0' });
  try {
    const pool = await getAppPool();
    const out = await resolveStructureFor(pool, structureId, ctc);
    res.json(out);
  } catch (e) { console.error('[preview]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// EMPLOYEE SALARIES
// ────────────────────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT
        U.Id AS UserId, U.Name, U.Email, E.EmpCode, E.Department, E.Designation,
        ES.SalaryId,
        ES.CTC          AS CurrentCTC,
        ES.MonthlyGross AS CurrentMonthly,
        ES.EffectiveFrom,
        S.Code AS StructureCode, S.Name AS StructureName
      FROM User_Login U
      LEFT JOIN HRM_Employee E ON E.UserId = U.Id
      OUTER APPLY (
        SELECT TOP 1 *
        FROM HRM_Employee_Salary ES2
        WHERE ES2.UserId = U.Id AND ES2.Status = 'active'
        ORDER BY ES2.EffectiveFrom DESC
      ) ES
      LEFT JOIN HRM_Salary_Structure S ON S.StructureId = ES.StructureId
      WHERE U.IsActive = 1
      ORDER BY U.Name;
    `);
    res.json({ employees: r.recordset });
  } catch (e) { console.error('[employees/list]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.get('/employees/:userId/salary', async (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  if (!Number.isFinite(uid)) return res.status(400).json({ message: 'Invalid userId' });
  try {
    const pool = await getAppPool();
    const hQ = await pool.request().input('uid', sql.Int, uid).query(`
      SELECT ES.SalaryId, ES.UserId, ES.StructureId, ES.CTC, ES.MonthlyGross,
             ES.EffectiveFrom, ES.EffectiveTo, ES.Status, ES.Remarks,
             ES.AssignedBy, ES.AssignedAt,
             S.Code AS StructureCode, S.Name AS StructureName,
             AU.Name AS AssignedByName
      FROM HRM_Employee_Salary ES
      LEFT JOIN HRM_Salary_Structure S ON S.StructureId = ES.StructureId
      LEFT JOIN User_Login AU ON AU.Id = ES.AssignedBy
      WHERE ES.UserId = @uid
      ORDER BY ES.EffectiveFrom DESC;
    `);
    const salaries = hQ.recordset;
    if (!salaries.length) return res.json({ salaries: [], current: null, currentLines: [] });

    const current = salaries.find(s => s.Status === 'active') || salaries[0];
    const lQ = await pool.request().input('id', sql.Int, current.SalaryId).query(`
      SELECT ComponentId, ComponentCode, ComponentName, Kind, FormulaSummary,
             MonthlyAmount, AnnualAmount, DisplayOrder
      FROM HRM_Employee_Salary_Component
      WHERE SalaryId = @id
      ORDER BY DisplayOrder, ComponentName;
    `);
    res.json({ salaries, current, currentLines: lQ.recordset });
  } catch (e) { console.error('[employee-salary/get]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.post('/employees/:userId/salary', async (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  if (!Number.isFinite(uid)) return res.status(400).json({ message: 'Invalid userId' });
  const b = req.body || {};
  const structureId = parseInt(b.structureId, 10);
  const ctc         = Number(b.ctc);
  const eff         = b.effectiveFrom ? new Date(b.effectiveFrom) : null;
  if (!Number.isFinite(structureId)) return res.status(400).json({ message: 'structureId required' });
  if (!Number.isFinite(ctc) || ctc < 0) return res.status(400).json({ message: 'ctc must be ≥ 0' });
  if (!eff || isNaN(eff))            return res.status(400).json({ message: 'effectiveFrom required' });

  try {
    const pool = await getAppPool();

    // Resolve the structure components against this CTC
    const resolved = await resolveStructureFor(pool, structureId, ctc);
    if (!resolved.lines.length) return res.status(400).json({ message: 'Structure has no active components' });

    // Mark prior active row as superseded; set its EffectiveTo to day-before
    await pool.request()
      .input('uid', sql.Int, uid)
      .input('eff', sql.Date, eff)
      .query(`
        UPDATE HRM_Employee_Salary
        SET Status = 'superseded',
            EffectiveTo = DATEADD(DAY, -1, @eff),
            UpdatedAt = SYSDATETIME()
        WHERE UserId = @uid AND Status = 'active' AND EffectiveFrom <= @eff;
      `);

    // Insert new active row
    const insH = await pool.request()
      .input('uid', sql.Int,           uid)
      .input('sid', sql.Int,           structureId)
      .input('ctc', sql.Decimal(15,2), ctc)
      .input('mg',  sql.Decimal(15,2), resolved.monthlyGross)
      .input('eff', sql.Date,          eff)
      .input('rem', sql.NVarChar(500), b.remarks || null)
      .input('ab',  sql.Int,           req.user.id)
      .query(`
        INSERT INTO HRM_Employee_Salary (UserId, StructureId, CTC, MonthlyGross, EffectiveFrom, Status, Remarks, AssignedBy)
        OUTPUT INSERTED.SalaryId
        VALUES (@uid, @sid, @ctc, @mg, @eff, 'active', @rem, @ab);
      `);
    const salaryId = insH.recordset[0].SalaryId;

    // Insert each frozen component line
    for (const line of resolved.lines) {
      await pool.request()
        .input('sid',   sql.Int,           salaryId)
        .input('cid',   sql.Int,           line.componentId)
        .input('cd',    sql.NVarChar(20),  line.code)
        .input('nm',    sql.NVarChar(100), line.name)
        .input('k',     sql.NVarChar(15),  line.kind)
        .input('fs',    sql.NVarChar(100), line.formulaSummary || null)
        .input('mo',    sql.Decimal(15,2), line.monthly)
        .input('an',    sql.Decimal(15,2), line.annual)
        .input('ord',   sql.Int,           line.displayOrder || 50)
        .query(`
          INSERT INTO HRM_Employee_Salary_Component
            (SalaryId, ComponentId, ComponentCode, ComponentName, Kind, FormulaSummary, MonthlyAmount, AnnualAmount, DisplayOrder)
          VALUES (@sid, @cid, @cd, @nm, @k, @fs, @mo, @an, @ord);
        `);
    }
    res.status(201).json({ salaryId, monthlyGross: resolved.monthlyGross });
  } catch (e) {
    console.error('[employee-salary/assign]', e);
    res.status(500).json({ message: 'Failed to assign salary', error: e.message });
  }
});

router.post('/employees/:userId/salary/:id/cancel', async (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  const id  = parseInt(req.params.id,     10);
  if (!Number.isFinite(uid) || !Number.isFinite(id)) return res.status(400).json({ message: 'Invalid ids' });
  try {
    const pool = await getAppPool();
    const cur = await pool.request().input('id', sql.Int, id).input('uid', sql.Int, uid)
      .query("SELECT Status FROM HRM_Employee_Salary WHERE SalaryId = @id AND UserId = @uid;");
    if (!cur.recordset.length) return res.status(404).json({ message: 'Not found' });
    if (cur.recordset[0].Status !== 'active') return res.status(400).json({ message: 'Only active assignments can be cancelled' });

    await pool.request().input('id', sql.Int, id)
      .query("UPDATE HRM_Employee_Salary SET Status = 'cancelled', UpdatedAt = SYSDATETIME() WHERE SalaryId = @id;");

    // Re-activate the most-recent superseded row if any
    await pool.request().input('uid', sql.Int, uid).query(`
      WITH Prev AS (
        SELECT TOP 1 SalaryId FROM HRM_Employee_Salary
        WHERE UserId = @uid AND Status = 'superseded'
        ORDER BY EffectiveFrom DESC
      )
      UPDATE HRM_Employee_Salary
      SET Status = 'active', EffectiveTo = NULL, UpdatedAt = SYSDATETIME()
      WHERE SalaryId IN (SELECT SalaryId FROM Prev);
    `);
    res.json({ ok: true });
  } catch (e) { console.error('[employee-salary/cancel]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

module.exports = router;
