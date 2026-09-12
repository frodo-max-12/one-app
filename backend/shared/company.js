// =====================================================================
// shared/company.js — single source of truth for COMPANYA vs CompanyB config
//
// Every route that reads NAV must call getCompany(req) instead of
// hardcoding a table prefix or currency. This is what makes COMPANYA + CompanyB
// share one route file instead of two.
// =====================================================================

const COMPANIES = {
  COMPANYA: {
    code:     'COMPANYA',
    label:    'Company A Pvt. Ltd.',
    prefix:   '[dbo].[Company A Pvt_ Ltd_$',
    currency: 'INR',
    locale:   'en-IN',
    symbol:   '₹',                       // ₹
    fromName: 'Company A - ONE App',
  },
  COMPANYB: {
    code:     'COMPANYB',
    label:    'Company B Pte Ltd.',
    prefix:   '[dbo].[Company B Pte Ltd_$',
    currency: 'USD',
    locale:   'en-US',
    symbol:   '$',
    fromName: 'Company B - ONE App',
  },
};

// Resolve company from request — checks ?company=, then x-company header, else COMPANYA default.
// Defensive: if ?company= is supplied multiple times in the URL, Express returns an
// array. Use the first element instead of stringifying the whole array (which would
// produce "COMPANYA,COMPANYA" → "Unknown company"). 2026-05-25 fix.
function getCompany(req) {
  let rawQuery = req && req.query && req.query.company;
  if (Array.isArray(rawQuery)) rawQuery = rawQuery[0];
  const raw = (
    rawQuery ||
    (req && req.headers && req.headers['x-company']) ||
    'COMPANYA'
  ).toString().toUpperCase().trim();
  const c = COMPANIES[raw];
  if (!c) {
    const err = new Error(`Unknown company: ${raw}`);
    err.status = 400;
    throw err;
  }
  return c;
}

// Resolve company by code (used by services/cron that don't have a request)
function getCompanyByCode(code) {
  const c = COMPANIES[(code || '').toString().toUpperCase().trim()];
  if (!c) throw new Error(`Unknown company code: ${code}`);
  return c;
}

module.exports = { COMPANIES, getCompany, getCompanyByCode };
