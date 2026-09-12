const sql = require('mssql');
require('dotenv').config();

// ─── Shared base config (same server, same credentials) ──────────────────────
const baseConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT) || 1433,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    connectTimeout: 30000,
    requestTimeout: 30000,
    // SQL Server's GETDATE() returns the server's LOCAL time (IST on this box),
    // not UTC. Tell the driver NOT to reinterpret DATETIME values as UTC —
    // otherwise SentAt='11:03 IST' would be returned as '11:03 UTC' → browser
    // re-adds the +5:30 offset → Reminder Log shows '4:33 PM' for a send that
    // actually happened at 11:03 AM. (Default useUTC:true.)
    useUTC: false,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// ─── NAV-safe request wrapper ────────────────────────────────────────────────
// Prepends `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` to every query
// so the NAV live DB (NAV_Live) is read in "NOLOCK" mode. This prevents:
//   1. Our app from being blocked by NAV users posting (G/L Entry, Cust Ledger, etc.)
//   2. Our long-running SELECTs from blocking NAV users.
// Safe because this pool is READ ONLY — all writes go through getAppPool().
const NAV_ISOLATION = 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n';

const wrapNavPoolReadUncommitted = (pool) => {
  const originalRequest = pool.request.bind(pool);
  pool.request = function () {
    const req = originalRequest();
    const originalQuery = req.query.bind(req);
    const originalBatch = req.batch.bind(req);

    req.query = function (strings, ...values) {
      if (typeof strings === 'string') {
        return originalQuery(NAV_ISOLATION + strings);
      }
      // Tagged template literal form: prepend to the first literal segment
      if (Array.isArray(strings) && strings.raw) {
        const cooked = [NAV_ISOLATION + strings[0], ...strings.slice(1)];
        Object.defineProperty(cooked, 'raw', {
          value: [NAV_ISOLATION + strings.raw[0], ...strings.raw.slice(1)],
        });
        return originalQuery(cooked, ...values);
      }
      return originalQuery(strings, ...values);
    };

    req.batch = function (sqlStr) {
      if (typeof sqlStr === 'string') return originalBatch(NAV_ISOLATION + sqlStr);
      return originalBatch(sqlStr);
    };

    return req;
  };
  return pool;
};

// ─── Pool 1: NAV database — READ ONLY (NOLOCK via READ UNCOMMITTED) ──────────
// NAV_Live (or NAV_UAT for testing)
// Used by: all existing Sales, Billing, Customers, Inventory, Outstanding, SO Backlog routes
let navPoolPromise;

const getPool = () => {
  if (!navPoolPromise) {
    navPoolPromise = new sql.ConnectionPool({ ...baseConfig, database: process.env.DB_NAME })
      .connect()
      .then((pool) => {
        console.log(`✅ NAV pool connected → ${process.env.DB_NAME} (READ UNCOMMITTED)`);
        return wrapNavPoolReadUncommitted(pool);
      })
      .catch((err) => {
        console.error('❌ NAV DB connection failed:', err.message);
        navPoolPromise = null;
        throw err;
      });
  }
  return navPoolPromise;
};

// ─── Pool 2: App database — READ + WRITE ─────────────────────────────────────
// BizNAV_App
// Used by: User_Login (auth), BN_VisitPlan, BN_MOM, BN_Expenses, and all future app tables
let appPoolPromise;

const getAppPool = () => {
  if (!appPoolPromise) {
    appPoolPromise = new sql.ConnectionPool({ ...baseConfig, database: process.env.APP_DB_NAME })
      .connect()
      .then((pool) => {
        console.log(`✅ App pool connected → ${process.env.APP_DB_NAME}`);
        return pool;
      })
      .catch((err) => {
        console.error('❌ App DB connection failed:', err.message);
        appPoolPromise = null;
        throw err;
      });
  }
  return appPoolPromise;
};

// ─── Pool 3: SmartSys database — READ ONLY (NOLOCK via READ UNCOMMITTED) ─────
// SMARTSYS = the Supermatic MOM/Project ERP. It lives on the SAME SQL Server and
// uses the SAME credentials as NAV + App (all three on 10.0.0.10), so this is
// just a third database on the existing connection — no cross-server hop.
// Used read-only by the Sales → MOM module to surface each salesperson's Minutes
// of Meeting. Wrapped READ UNCOMMITTED exactly like the NAV pool so our SELECTs
// never block SmartSys users (and their posting never blocks us). NO writes ever —
// MOM authoring stays inside the SmartSys app.
let smartSysPoolPromise;

const getSmartSysPool = () => {
  if (!smartSysPoolPromise) {
    const dbName = process.env.SMARTSYS_DB_NAME || 'SMARTSYS';
    smartSysPoolPromise = new sql.ConnectionPool({ ...baseConfig, database: dbName })
      .connect()
      .then((pool) => {
        console.log(`✅ SmartSys pool connected → ${dbName} (READ UNCOMMITTED)`);
        return wrapNavPoolReadUncommitted(pool);
      })
      .catch((err) => {
        console.error('❌ SmartSys DB connection failed:', err.message);
        smartSysPoolPromise = null;
        throw err;
      });
  }
  return smartSysPoolPromise;
};

module.exports = { sql, getPool, getAppPool, getSmartSysPool };