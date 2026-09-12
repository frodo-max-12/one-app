// =====================================================================
// modules/hr/routes/employee.js — Employee directory + CRUD (Phase 3D)
// Mounted at /api/hr/employees/* by ../index.js
//
// Endpoints:
//   GET  /                         — list (search, dept, location, active)
//   GET  /:id                      — full profile (User_Login + HRM_Employee + family + docs)
//   POST /                         — create user + employee in one shot (HR-only)
//   PATCH /:id                     — partial update (HR-only OR self for limited fields)
//   GET  /:id/family               — list family members
//   POST /:id/family               — add family member
//   PUT  /family/:familyId         — update family member
//   DELETE /family/:familyId       — remove family member
//   GET  /:id/documents            — list docs metadata
//   POST /:id/documents            — upload doc (multipart) — body field 'file'
//   DELETE /documents/:docId       — soft archive a doc
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, isFullAccess, FULL_ACCESS_ROLES } = require('../../../auth');
// Roles a full-access actor (admin/op-head/director) can manage but HR cannot escalate to/touch.
const FULL_ACCESS_SET = new Set((FULL_ACCESS_ROLES || ['admin', 'operation head', 'director']).map(r => r.toLowerCase()));
// Valid roles for the login PATCH (data-integrity guard — an unknown role locks the user out).
const VALID_ROLES = new Set(['sales', 'sales head', 'north sales', 'north sales head', 'south sales', 'international sales',
  'sales head electrical', 'electrical head', 'fae', 'fae head', 'product head', 'product assistant', 'csr', 'csr head',
  'store electrical', 'retailer auditor', 'retailer delivery', 'ar collecting', 'warehouse',
  'it', 'it head', 'account', 'account head', 'purchase', 'purchase head', 'mis',
  'hr', 'hr head', 'admin', 'operation head', 'director']);

// ── Document storage setup ──────────────────────────────────────────────────
const DOC_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'documents');
try { fs.mkdirSync(DOC_ROOT, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uid = parseInt(req.params.id);
      const dir = path.join(DOC_ROOT, String(uid));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}_${safe}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB cap per file
});

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can list employees' });
    const search = (req.query.search || '').trim();
    const dept   = (req.query.department || '').trim();
    const loc    = (req.query.location   || '').trim();
    const active = req.query.active === undefined ? true : (req.query.active === 'true');

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['UL.IsActive = ' + (active ? '1' : '0')];
    if (search) {
      r.input('q', sql.NVarChar(200), '%' + search + '%');
      where.push(`(
        UL.Name LIKE @q OR UL.Email LIKE @q OR UL.Username LIKE @q OR UL.CompanyACode LIKE @q
        OR ISNULL(E.EmpCode,'') LIKE @q OR ISNULL(E.Mobile,'') LIKE @q
      )`);
    }
    if (dept) { r.input('d', sql.NVarChar(50),  dept); where.push('E.Department = @d'); }
    if (loc)  { r.input('l', sql.NVarChar(100), loc);  where.push('E.Location = @l'); }

    const result = await r.query(`
      SELECT
        UL.Id              AS UserId,
        UL.Name            AS Name,
        UL.Username        AS Username,
        UL.Email           AS Email,
        UL.Role            AS Role,
        UL.CompanyACode         AS CompanyACode,
        UL.CompanyBCode      AS CompanyBCode,
        UL.IsActive        AS IsActive,
        E.EmpId            AS EmpId,
        E.EmpCode          AS EmpCode,
        E.Designation      AS Designation,
        E.Department       AS Department,
        E.Location         AS Location,
        E.DateOfJoining    AS DateOfJoining,
        E.Mobile           AS Mobile,
        E.EmployeeType     AS EmployeeType,
        E.OfficeId         AS OfficeId,
        G.Name             AS OfficeName
      FROM [dbo].[User_Login] UL
      LEFT JOIN [dbo].[HRM_Employee] E ON E.UserId = UL.Id
      LEFT JOIN [dbo].[HRM_Geofence] G ON G.GeofenceId = E.OfficeId
      WHERE ${where.join(' AND ')}
      ORDER BY UL.Name;
    `);
    return res.json({ ok: true, employees: result.recordset });
  } catch (err) {
    console.error('[/api/hr/employees] failed:', err.message);
    return res.status(500).json({ message: 'List failed', detail: err.message });
  }
});

// ── GET /:id — full profile ─────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    // Permission: lens admin OR self
    if (!isLensAdmin(req.user) && Number(req.user.id) !== id) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    const pool = await getAppPool();
    const profile = await pool.request()
      .input('uid', sql.Int, id)
      .query(`
        SELECT
          UL.Id AS UserId, UL.Username, UL.Name, UL.Email, UL.Role,
          UL.CompanyACode, UL.CompanyBCode, UL.IsActive, UL.CreatedAt AS UserCreatedAt,
          E.*,
          G.Name AS OfficeName, G.City AS OfficeCity
        FROM [dbo].[User_Login] UL
        LEFT JOIN [dbo].[HRM_Employee]  E ON E.UserId = UL.Id
        LEFT JOIN [dbo].[HRM_Geofence]  G ON G.GeofenceId = E.OfficeId
        WHERE UL.Id = @uid;
      `);
    if (profile.recordset.length === 0) return res.status(404).json({ message: 'Not found' });

    const family = await pool.request().input('uid', sql.Int, id)
      .query(`SELECT * FROM [dbo].[HRM_EmployeeFamily] WHERE UserId = @uid ORDER BY FamilyId;`);
    const docs = await pool.request().input('uid', sql.Int, id)
      .query(`SELECT D.*, UL.Name AS UploadedByName FROM [dbo].[HRM_EmployeeDocument] D
              LEFT JOIN [dbo].[User_Login] UL ON UL.Id = D.UploadedBy
              WHERE D.UserId = @uid AND D.IsActive = 1 ORDER BY D.UploadedAt DESC;`);
    const positions = await pool.request().input('uid', sql.Int, id).query(`
      SELECT PH.*, RM.Name AS ReportingManagerName
      FROM [dbo].[HRM_PositionHistory] PH
      LEFT JOIN [dbo].[User_Login] RM ON RM.Id = PH.ReportingManagerId
      WHERE PH.UserId = @uid
      ORDER BY PH.EffectiveFrom DESC;`).catch(() => ({ recordset: [] }));
    const prevEmp = await pool.request().input('uid', sql.Int, id).query(`
      SELECT * FROM [dbo].[HRM_PreviousEmployment] WHERE UserId = @uid ORDER BY FromDate DESC;`).catch(() => ({ recordset: [] }));
    const nominations = await pool.request().input('uid', sql.Int, id).query(`
      SELECT * FROM [dbo].[HRM_Nomination] WHERE UserId = @uid AND IsActive = 1 ORDER BY SchemeKind;`).catch(() => ({ recordset: [] }));

    return res.json({
      ok: true,
      profile: profile.recordset[0],
      family: family.recordset,
      documents: docs.recordset,
      positions: positions.recordset,
      previousEmployment: prevEmp.recordset,
      nominations: nominations.recordset,
    });
  } catch (err) {
    console.error('[/api/hr/employees/:id] failed:', err.message);
    return res.status(500).json({ message: 'Fetch failed', detail: err.message });
  }
});

// ── POST / — create User_Login + HRM_Employee atomically ────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can add employees' });
    const b = req.body || {};
    // Required
    if (!b.firstName || !b.lastName) return res.status(400).json({ message: 'firstName and lastName required' });
    if (!b.email || !/^[^@]+@[^@]+\.[^@]+$/.test(b.email)) return res.status(400).json({ message: 'valid email required' });
    if (!b.password || b.password.length < 6) return res.status(400).json({ message: 'password ≥ 6 chars required' });
    if (!b.role) return res.status(400).json({ message: 'role required' });

    const pool = await getAppPool();
    // Check email unique
    const dup = await pool.request().input('e', sql.NVarChar(200), b.email)
      .query(`SELECT TOP 1 Id FROM [dbo].[User_Login] WHERE Username = @e OR Email = @e;`);
    if (dup.recordset.length > 0) return res.status(409).json({ message: 'An account with this email already exists' });

    const fullName = [b.firstName, b.middleName, b.lastName].filter(Boolean).join(' ').trim();

    // 1. Insert User_Login (plaintext password — existing app convention; migrate to bcrypt in Phase 5)
    const uIns = await pool.request()
      .input('u', sql.NVarChar(100), b.email)
      .input('p', sql.NVarChar(100), b.password)
      .input('r', sql.NVarChar(50),  b.role)
      .input('n', sql.NVarChar(100), fullName)
      .input('s', sql.NVarChar(200), b.companyaCode || null)
      .input('a', sql.NVarChar(200), b.companybCode || null)
      .input('e', sql.NVarChar(200), b.email)
      .query(`
        INSERT INTO [dbo].[User_Login] (Username, Password, Role, Name, CompanyACode, CompanyBCode, Email, IsActive, CreatedAt)
        OUTPUT INSERTED.Id
        VALUES (@u, @p, @r, @n, @s, @a, @e, 1, GETDATE());
      `);
    const newUserId = uIns.recordset[0].Id;

    // 2. Insert HRM_Employee
    const eIns = pool.request();
    eIns.input('uid',  sql.Int,           newUserId);
    eIns.input('code', sql.NVarChar(50),  b.empCode || null);
    eIns.input('title', sql.NVarChar(10), b.title || null);
    eIns.input('fn',   sql.NVarChar(100), b.firstName);
    eIns.input('mn',   sql.NVarChar(100), b.middleName || null);
    eIns.input('ln',   sql.NVarChar(100), b.lastName);
    eIns.input('gen',  sql.NVarChar(10),  b.gender || null);
    eIns.input('dob',  sql.Date,          b.dob || null);
    eIns.input('mob',  sql.NVarChar(20),  b.mobile || null);
    eIns.input('wem',  sql.NVarChar(200), b.email);
    eIns.input('pem',  sql.NVarChar(200), b.personalEmail || null);
    eIns.input('pan',  sql.NVarChar(20),  b.pan || null);
    eIns.input('aad',  sql.NVarChar(20),  b.aadhaar || null);
    eIns.input('addr', sql.NVarChar(500), b.address || null);
    eIns.input('city', sql.NVarChar(100), b.city || null);
    eIns.input('state',sql.NVarChar(100), b.state || null);
    eIns.input('pin',  sql.NVarChar(10),  b.pincode || null);
    eIns.input('emN',  sql.NVarChar(150), b.emgName || null);
    eIns.input('emR',  sql.NVarChar(50),  b.emgRelationship || null);
    eIns.input('emP',  sql.NVarChar(20),  b.emgPhone || null);
    eIns.input('doj',  sql.Date,          b.dateOfJoining || null);
    eIns.input('des',  sql.NVarChar(150), b.designation || null);
    eIns.input('dep',  sql.NVarChar(50),  b.department || null);
    eIns.input('loc',  sql.NVarChar(100), b.location || null);
    eIns.input('typ',  sql.NVarChar(20),  b.employeeType || 'Permanent');
    eIns.input('off',  sql.Int,           b.officeId || null);
    eIns.input('bN',   sql.NVarChar(200), b.bankName || null);
    eIns.input('bAc',  sql.NVarChar(50),  b.bankAccountNo || null);
    eIns.input('ifsc', sql.NVarChar(20),  b.ifsc || null);
    eIns.input('bBr',  sql.NVarChar(150), b.bankBranch || null);
    eIns.input('pfno', sql.NVarChar(50),  b.pfNo || null);
    eIns.input('uan',  sql.NVarChar(20),  b.pfUan || null);
    eIns.input('esi',  sql.NVarChar(30),  b.esiNo || null);
    eIns.input('iPF',  sql.Bit,           b.includePF  ? 1 : 0);
    eIns.input('iES',  sql.Bit,           b.includeESI ? 1 : 0);
    eIns.input('iLW',  sql.Bit,           b.includeLWF ? 1 : 0);
    eIns.input('pm',   sql.NVarChar(30),  b.paymentMode || 'Bank Transfer');

    await eIns.query(`
      INSERT INTO [dbo].[HRM_Employee]
        (UserId, EmpCode, Title, FirstName, MiddleName, LastName, Gender, DOB, Mobile,
         WorkEmail, PersonalEmail, PAN, Aadhaar,
         Address, City, State, Pincode,
         EmgName, EmgRelationship, EmgPhone,
         DateOfJoining, Designation, Department, Location, EmployeeType, OfficeId,
         BankName, BankAccountNo, IFSC, BankBranch,
         PFNo, PFUAN, ESINo,
         IncludePF, IncludeESI, IncludeLWF, PaymentMode,
         IsActive)
      VALUES
        (@uid, @code, @title, @fn, @mn, @ln, @gen, @dob, @mob,
         @wem, @pem, @pan, @aad,
         @addr, @city, @state, @pin,
         @emN, @emR, @emP,
         @doj, @des, @dep, @loc, @typ, @off,
         @bN, @bAc, @ifsc, @bBr,
         @pfno, @uan, @esi,
         @iPF, @iES, @iLW, @pm,
         1);
    `);

    return res.status(201).json({ ok: true, userId: newUserId, fullName });
  } catch (err) {
    console.error('[POST /api/hr/employees] failed:', err.message);
    return res.status(500).json({ message: 'Create failed', detail: err.message });
  }
});

// ── PATCH /:id — partial update ─────────────────────────────────────────────
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const isSelf = Number(req.user.id) === id;
    if (!isLensAdmin(req.user) && !isSelf) return res.status(403).json({ message: 'Not allowed' });

    const b = req.body || {};
    const pool = await getAppPool();

    // Ensure HRM_Employee row exists (legacy users may have only User_Login)
    const eRow = await pool.request().input('uid', sql.Int, id)
      .query(`SELECT EmpId FROM [dbo].[HRM_Employee] WHERE UserId = @uid;`);
    if (eRow.recordset.length === 0) {
      await pool.request().input('uid', sql.Int, id)
        .query(`INSERT INTO [dbo].[HRM_Employee] (UserId, IsActive) VALUES (@uid, 1);`);
    }

    // Build dynamic SET
    const ALLOWED_HR = ['EmpCode','Title','FirstName','MiddleName','LastName','NickName','Gender','Mobile','Extension',
      'PersonalEmail','DOB','BloodGroup','MaritalStatus','MarriageDate','SpouseName','FatherName','MotherName','Nationality',
      'PAN','Aadhaar','Address','City','District','State','Country','Pincode','AltPhone',
      'EmgName','EmgRelationship','EmgPhone','EmgAddress',
      'DateOfJoining','Designation','Department','Location','ReportingManagerId','ConfirmationDate','EmployeeType','OfficeId',
      'BankName','BankAccountNo','IFSC','BankBranch','PFNo','PFUAN','ESINo','IncludePF','IncludeESI','IncludeLWF','PaymentMode',
      'PassportNo','PassportIssueDate','PassportExpiryDate','PassportPlaceOfIssue','PassportCountry',
      'VisaNo','VisaType','VisaCountry','VisaExpiryDate',
      'ResignDate','LastWorkingDay','SettledOn','FitToBeRehired','AltEmailOnExit','AltMobileOnExit',
      'ResignationReason','NoticeServed','NoticePeriodDays','ExitInterviewDate','ExitInterviewNotes'];
    const ALLOWED_SELF = ['NickName','Mobile','PersonalEmail','BloodGroup','MaritalStatus','MarriageDate','SpouseName',
      'Address','City','District','State','Country','Pincode','AltPhone',
      'EmgName','EmgRelationship','EmgPhone','EmgAddress',
      'PassportNo','PassportIssueDate','PassportExpiryDate','PassportPlaceOfIssue','PassportCountry',
      'VisaNo','VisaType','VisaCountry','VisaExpiryDate'];

    const allowed = isLensAdmin(req.user) ? ALLOWED_HR : ALLOWED_SELF;
    const sets = [];
    const r = pool.request().input('uid', sql.Int, id);
    for (const k of Object.keys(b)) {
      const colName = k.charAt(0).toUpperCase() + k.slice(1);
      if (!allowed.includes(colName)) continue;
      let val = b[k];
      if (val === '' ) val = null;
      r.input(colName, val);
      sets.push(`${colName} = @${colName}`);
    }
    if (sets.length === 0) return res.status(400).json({ message: 'no allowed fields supplied' });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE [dbo].[HRM_Employee] SET ${sets.join(', ')} WHERE UserId = @uid;`);

    // If full Name should change (Title/First/Middle/Last changed), also sync User_Login.Name
    if (isLensAdmin(req.user) && (b.firstName !== undefined || b.lastName !== undefined || b.middleName !== undefined)) {
      const fresh = await pool.request().input('uid', sql.Int, id)
        .query(`SELECT FirstName, MiddleName, LastName FROM [dbo].[HRM_Employee] WHERE UserId = @uid;`);
      const f = fresh.recordset[0];
      if (f) {
        const full = [f.FirstName, f.MiddleName, f.LastName].filter(Boolean).join(' ').trim();
        if (full) await pool.request().input('uid', sql.Int, id).input('n', sql.NVarChar(100), full)
          .query(`UPDATE [dbo].[User_Login] SET Name = @n WHERE Id = @uid;`);
      }
    }
    return res.json({ ok: true, updated: sets.length - 1 });
  } catch (err) {
    console.error('[PATCH /api/hr/employees/:id] failed:', err.message);
    return res.status(500).json({ message: 'Update failed', detail: err.message });
  }
});

// ── Family endpoints ────────────────────────────────────────────────────────
router.post('/:id/family', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== id) return res.status(403).json({ message: 'Not allowed' });
    const b = req.body || {};
    if (!b.name || !b.relationship) return res.status(400).json({ message: 'name + relationship required' });
    const pool = await getAppPool();
    const out = await pool.request()
      .input('uid', sql.Int,          id)
      .input('n',   sql.NVarChar(150),b.name)
      .input('rel', sql.NVarChar(50), b.relationship)
      .input('g',   sql.NVarChar(10), b.gender || null)
      .input('dob', sql.Date,         b.dob || null)
      .input('occ', sql.NVarChar(100),b.occupation || null)
      .input('mob', sql.NVarChar(20), b.mobile || null)
      .input('dep', sql.Bit,          b.isDependent ? 1 : 0)
      .input('em',  sql.Bit,          b.isEmergency ? 1 : 0)
      .input('nt',  sql.NVarChar(500),b.notes || null)
      .query(`
        INSERT INTO [dbo].[HRM_EmployeeFamily]
          (UserId, Name, Relationship, Gender, DOB, Occupation, Mobile, IsDependent, IsEmergency, Notes)
        OUTPUT INSERTED.FamilyId
        VALUES (@uid, @n, @rel, @g, @dob, @occ, @mob, @dep, @em, @nt);
      `);
    return res.status(201).json({ ok: true, familyId: out.recordset[0].FamilyId });
  } catch (err) {
    return res.status(500).json({ message: 'Family add failed', detail: err.message });
  }
});

router.delete('/family/:familyId', authenticate, async (req, res) => {
  try {
    const fid = parseInt(req.params.familyId);
    if (!Number.isFinite(fid) || fid <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    // Permission: lens admin OR row owner
    const owner = await pool.request().input('fid', sql.Int, fid)
      .query(`SELECT UserId FROM [dbo].[HRM_EmployeeFamily] WHERE FamilyId = @fid;`);
    if (owner.recordset.length === 0) return res.status(404).json({ message: 'Not found' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== Number(owner.recordset[0].UserId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    await pool.request().input('fid', sql.Int, fid)
      .query(`DELETE FROM [dbo].[HRM_EmployeeFamily] WHERE FamilyId = @fid;`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Family delete failed', detail: err.message });
  }
});

// ── Document endpoints (upload via multipart) ───────────────────────────────
router.post('/:id/documents', authenticate, upload.single('file'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== id) return res.status(403).json({ message: 'Not allowed' });
    if (!req.file) return res.status(400).json({ message: 'file required' });

    const docType = (req.body && req.body.docType) || 'other';
    const docName = (req.body && req.body.docName) || req.file.originalname;
    const relUrl = '/uploads/hr/documents/' + id + '/' + req.file.filename;

    const pool = await getAppPool();
    const out = await pool.request()
      .input('uid',  sql.Int,           id)
      .input('typ',  sql.NVarChar(50),  docType)
      .input('nm',   sql.NVarChar(200), docName)
      .input('url',  sql.NVarChar(500), relUrl)
      .input('sz',   sql.Int,           req.file.size)
      .input('mt',   sql.NVarChar(100), req.file.mimetype)
      .input('by',   sql.Int,           req.user.id)
      .query(`
        INSERT INTO [dbo].[HRM_EmployeeDocument]
          (UserId, DocType, DocName, FileUrl, FileSize, MimeType, UploadedBy)
        OUTPUT INSERTED.DocId
        VALUES (@uid, @typ, @nm, @url, @sz, @mt, @by);
      `);
    return res.status(201).json({ ok: true, docId: out.recordset[0].DocId, fileUrl: relUrl });
  } catch (err) {
    console.error('[POST /:id/documents] failed:', err.message);
    return res.status(500).json({ message: 'Upload failed', detail: err.message });
  }
});

// ── Position History (HR-only writes; everyone with read access sees) ──────
router.post('/:id/position', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can add position history' });
    const b = req.body || {};
    if (!b.designation || !b.effectiveFrom) return res.status(400).json({ message: 'designation + effectiveFrom required' });

    const pool = await getAppPool();
    // Close any existing current row by setting EffectiveTo
    if (!b.effectiveTo) {
      await pool.request()
        .input('uid', sql.Int, id)
        .input('to',  sql.Date, b.effectiveFrom)
        .query(`UPDATE [dbo].[HRM_PositionHistory]
                SET EffectiveTo = DATEADD(day, -1, @to)
                WHERE UserId = @uid AND EffectiveTo IS NULL;`);
    }
    const out = await pool.request()
      .input('uid', sql.Int,           id)
      .input('des', sql.NVarChar(150), b.designation)
      .input('dep', sql.NVarChar(50),  b.department || null)
      .input('loc', sql.NVarChar(100), b.location || null)
      .input('rm',  sql.Int,           b.reportingManagerId || null)
      .input('et',  sql.NVarChar(20),  b.employeeType || null)
      .input('ef',  sql.Date,          b.effectiveFrom)
      .input('eto', sql.Date,          b.effectiveTo || null)
      .input('rfc', sql.NVarChar(50),  b.reasonForChange || 'role-change')
      .input('nt',  sql.NVarChar(500), b.notes || null)
      .input('by',  sql.Int,           req.user.id)
      .query(`
        INSERT INTO [dbo].[HRM_PositionHistory]
          (UserId, Designation, Department, Location, ReportingManagerId, EmployeeType,
           EffectiveFrom, EffectiveTo, ReasonForChange, Notes, CreatedBy)
        OUTPUT INSERTED.HistoryId
        VALUES (@uid, @des, @dep, @loc, @rm, @et, @ef, @eto, @rfc, @nt, @by);
      `);

    // If this is now-current, also sync HRM_Employee.Designation/Department/Location
    if (!b.effectiveTo) {
      await pool.request()
        .input('uid', sql.Int,           id)
        .input('des', sql.NVarChar(150), b.designation)
        .input('dep', sql.NVarChar(50),  b.department || null)
        .input('loc', sql.NVarChar(100), b.location || null)
        .input('et',  sql.NVarChar(20),  b.employeeType || null)
        .query(`UPDATE [dbo].[HRM_Employee]
                SET Designation = @des,
                    Department  = ISNULL(@dep, Department),
                    Location    = ISNULL(@loc, Location),
                    EmployeeType= ISNULL(@et,  EmployeeType),
                    UpdatedAt   = SYSDATETIME()
                WHERE UserId = @uid;`);
    }
    return res.status(201).json({ ok: true, historyId: out.recordset[0].HistoryId });
  } catch (err) {
    console.error('[POST /:id/position] failed:', err.message);
    return res.status(500).json({ message: 'Position add failed', detail: err.message });
  }
});

router.delete('/position/:posId', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
    const id = parseInt(req.params.posId);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id).query(`DELETE FROM [dbo].[HRM_PositionHistory] WHERE HistoryId = @id;`);
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ message: 'Delete failed', detail: err.message }); }
});

// ── Previous Employment ─────────────────────────────────────────────────────
router.post('/:id/previous-employment', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== id) return res.status(403).json({ message: 'Not allowed' });
    const b = req.body || {};
    if (!b.companyName) return res.status(400).json({ message: 'companyName required' });

    const pool = await getAppPool();
    const out = await pool.request()
      .input('uid', sql.Int,           id)
      .input('co',  sql.NVarChar(200), b.companyName)
      .input('des', sql.NVarChar(150), b.designation || null)
      .input('fd',  sql.Date,          b.fromDate || null)
      .input('td',  sql.Date,          b.toDate || null)
      .input('sal', sql.Decimal(12,2), b.lastSalary != null ? Number(b.lastSalary) : null)
      .input('rfl', sql.NVarChar(500), b.reasonForLeaving || null)
      .input('nt',  sql.NVarChar(sql.MAX), b.notes || null)
      .query(`
        INSERT INTO [dbo].[HRM_PreviousEmployment]
          (UserId, CompanyName, Designation, FromDate, ToDate, LastSalary, ReasonForLeaving, Notes)
        OUTPUT INSERTED.PrevId
        VALUES (@uid, @co, @des, @fd, @td, @sal, @rfl, @nt);
      `);
    return res.status(201).json({ ok: true, prevId: out.recordset[0].PrevId });
  } catch (err) { return res.status(500).json({ message: 'Add failed', detail: err.message }); }
});

router.delete('/previous-employment/:prevId', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.prevId);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const own = await pool.request().input('id', sql.Int, id)
      .query(`SELECT UserId FROM [dbo].[HRM_PreviousEmployment] WHERE PrevId = @id;`);
    if (own.recordset.length === 0) return res.status(404).json({ message: 'Not found' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== Number(own.recordset[0].UserId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    await pool.request().input('id', sql.Int, id).query(`DELETE FROM [dbo].[HRM_PreviousEmployment] WHERE PrevId = @id;`);
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ message: 'Delete failed', detail: err.message }); }
});

// ── Nomination ──────────────────────────────────────────────────────────────
router.post('/:id/nomination', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== id) return res.status(403).json({ message: 'Not allowed' });
    const b = req.body || {};
    if (!b.schemeKind || !b.nomineeName || !b.relationship) return res.status(400).json({ message: 'schemeKind + nomineeName + relationship required' });
    const pool = await getAppPool();
    const out = await pool.request()
      .input('uid',   sql.Int,           id)
      .input('sk',    sql.NVarChar(30),  b.schemeKind)
      .input('nm',    sql.NVarChar(150), b.nomineeName)
      .input('rel',   sql.NVarChar(50),  b.relationship)
      .input('dob',   sql.Date,          b.dob || null)
      .input('addr',  sql.NVarChar(500), b.address || null)
      .input('share', sql.Decimal(5,2),  Number(b.sharePct || 100))
      .input('nt',    sql.NVarChar(500), b.notes || null)
      .query(`
        INSERT INTO [dbo].[HRM_Nomination]
          (UserId, SchemeKind, NomineeName, Relationship, DOB, Address, SharePct, Notes)
        OUTPUT INSERTED.NominationId
        VALUES (@uid, @sk, @nm, @rel, @dob, @addr, @share, @nt);
      `);
    return res.status(201).json({ ok: true, nominationId: out.recordset[0].NominationId });
  } catch (err) { return res.status(500).json({ message: 'Add failed', detail: err.message }); }
});

router.delete('/nomination/:nomId', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.nomId);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const own = await pool.request().input('id', sql.Int, id)
      .query(`SELECT UserId FROM [dbo].[HRM_Nomination] WHERE NominationId = @id;`);
    if (own.recordset.length === 0) return res.status(404).json({ message: 'Not found' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== Number(own.recordset[0].UserId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    await pool.request().input('id', sql.Int, id)
      .query(`UPDATE [dbo].[HRM_Nomination] SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE NominationId = @id;`);
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ message: 'Delete failed', detail: err.message }); }
});

router.delete('/documents/:docId', authenticate, async (req, res) => {
  try {
    const docId = parseInt(req.params.docId);
    if (!Number.isFinite(docId) || docId <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const owner = await pool.request().input('id', sql.Int, docId)
      .query(`SELECT UserId, FileUrl FROM [dbo].[HRM_EmployeeDocument] WHERE DocId = @id;`);
    if (owner.recordset.length === 0) return res.status(404).json({ message: 'Not found' });
    if (!isLensAdmin(req.user) && Number(req.user.id) !== Number(owner.recordset[0].UserId)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    await pool.request().input('id', sql.Int, docId)
      .query(`UPDATE [dbo].[HRM_EmployeeDocument] SET IsActive = 0, ArchivedAt = SYSDATETIME() WHERE DocId = @id;`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Delete failed', detail: err.message });
  }
});

// ── PATCH /:id/login — HR/admin: manage the User_Login account (role, codes,
// contact, active). Separate from PATCH /:id (which edits HR profile fields). ──
router.patch('/:id/login', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can manage logins' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const b = req.body || {};
    const pool = await getAppPool();

    // Protect top-of-trust accounts: only a FULL-ACCESS actor (admin/op-head/director)
    // may modify a user whose CURRENT role is full-access, or grant a role TO full-access.
    // Stops an HR login from resetting/escalating the admin/director.
    const cur = await pool.request().input('id', sql.Int, id)
      .query(`SELECT Role FROM [dbo].[User_Login] WHERE Id = @id;`);
    if (!cur.recordset.length) return res.status(404).json({ message: 'user not found' });
    if (FULL_ACCESS_SET.has(String(cur.recordset[0].Role || '').toLowerCase().trim()) && !isFullAccess(req.user))
      return res.status(403).json({ message: 'Only a full-access admin can manage admin / operation-head / director accounts.' });
    if (b.role !== undefined) {
      const newRole = String(b.role).trim().toLowerCase();
      if (!newRole) return res.status(400).json({ message: 'role cannot be blank' });
      if (!VALID_ROLES.has(newRole)) return res.status(400).json({ message: `Unknown role "${b.role}".` });
      if (FULL_ACCESS_SET.has(newRole) && !isFullAccess(req.user))
        return res.status(403).json({ message: 'Only a full-access admin can grant admin / operation-head / director.' });
    }

    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    const add = (col, val, type) => { r.input(col, type, (val === '' ? null : val)); sets.push(`${col} = @${col}`); };
    if (b.role       !== undefined) add('Role', String(b.role).trim().toLowerCase(), sql.NVarChar(50));
    if (b.name       !== undefined) add('Name',       b.name,       sql.NVarChar(100));
    if (b.companyaCode    !== undefined) add('CompanyACode',    b.companyaCode,    sql.NVarChar(1000));
    if (b.companybCode !== undefined) add('CompanyBCode', b.companybCode, sql.NVarChar(1000));
    if (b.email      !== undefined) add('Email',      b.email,      sql.NVarChar(100));
    if (b.phone      !== undefined) add('Phone',      b.phone,      sql.NVarChar(20));
    if (b.department !== undefined) add('Department', b.department, sql.NVarChar(50));
    if (b.isActive   !== undefined) { r.input('IsActive', sql.Bit, b.isActive ? 1 : 0); sets.push('IsActive = @IsActive'); }
    if (!sets.length) return res.status(400).json({ message: 'no fields to update' });
    await r.query(`UPDATE [dbo].[User_Login] SET ${sets.join(', ')} WHERE Id = @id;`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/hr/employees/:id/login] failed:', err.message);
    return res.status(500).json({ message: 'Login update failed', detail: err.message });
  }
});

// ── POST /:id/reset-password — HR/admin set a new login password ─────────────
router.post('/:id/reset-password', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can reset passwords' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pw = String((req.body || {}).password || '');
    if (pw.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    const pool = await getAppPool();
    // Don't let HR reset a full-access (admin/op-head/director) password.
    const cur = await pool.request().input('id', sql.Int, id)
      .query(`SELECT Role FROM [dbo].[User_Login] WHERE Id = @id;`);
    if (!cur.recordset.length) return res.status(404).json({ message: 'user not found' });
    if (FULL_ACCESS_SET.has(String(cur.recordset[0].Role || '').toLowerCase().trim()) && !isFullAccess(req.user))
      return res.status(403).json({ message: 'Only a full-access admin can reset an admin / operation-head / director password.' });
    await pool.request().input('id', sql.Int, id).input('p', sql.NVarChar(100), pw)
      .query(`UPDATE [dbo].[User_Login] SET Password = @p WHERE Id = @id;`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/hr/employees/:id/reset-password] failed:', err.message);
    return res.status(500).json({ message: 'Password reset failed', detail: err.message });
  }
});

module.exports = router;
