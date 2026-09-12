// =====================================================================
// services/taxEngine.js — Indian Income Tax computation (Phase 6A)
//
// Pure module — no DB calls, no Express. Unit-testable in isolation.
// Implements FY 2026-27 rates for both Old and New regimes:
//   - Slab tax
//   - Section 87A rebate (full rebate up to ₹5L Old / ₹7L New)
//   - Surcharge: 10/15/25/37% above 50L/1Cr/2Cr/5Cr (New regime caps at 25%)
//   - Marginal relief at surcharge thresholds
//   - 4% Health & Education Cess on (tax + surcharge − rebate)
//   - HRA exemption (Section 10(13A)) — min of: actual HRA, rent paid − 10% of basic,
//                                              50% (metro) / 40% (non-metro) of basic
//
// Public API:
//   computeTax({ taxableIncome, regime, age=30 })        → tax breakdown
//   computeHraExemption({ rentPaid, basic, hraComponent, isMetro })  → exemption amount
//   recommendRegime({ grossSalary, stdDed, ptDeducted, chapterVIA, hraExempt, age })
//                                                       → which regime saves more
// =====================================================================

const STANDARD_DEDUCTION = 50000;

// ── Slab definitions (FY 2026-27) ────────────────────────────────────────────
// Each slab: { upTo: amount (Infinity = no cap), rate: percent }
const SLABS_NEW = [
  { upTo:  300000, rate:  0 },
  { upTo:  600000, rate:  5 },
  { upTo:  900000, rate: 10 },
  { upTo: 1200000, rate: 15 },
  { upTo: 1500000, rate: 20 },
  { upTo: Infinity, rate: 30 },
];

// Old regime depends on age for the first slab (₹2.5L / ₹3L / ₹5L)
function slabsOld(age) {
  let basicExempt = 250000;                       // < 60
  if (age >= 60 && age < 80) basicExempt = 300000;
  if (age >= 80)              basicExempt = 500000;
  return [
    { upTo: basicExempt, rate:  0 },
    { upTo:      500000, rate:  5 },
    { upTo:     1000000, rate: 20 },
    { upTo:     Infinity, rate: 30 },
  ];
}

// ── Apply slabs ──────────────────────────────────────────────────────────────
function applySlabs(taxable, slabs) {
  let tax = 0, prev = 0;
  const breakdown = [];
  for (const s of slabs) {
    if (taxable <= prev) { breakdown.push({ from: prev, to: prev, rate: s.rate, tax: 0 }); continue; }
    const upper = Math.min(taxable, s.upTo);
    const inSlab = Math.max(0, upper - prev);
    const t = inSlab * s.rate / 100;
    tax += t;
    breakdown.push({ from: prev, to: upper, rate: s.rate, tax: round2(t) });
    if (taxable <= s.upTo) break;
    prev = s.upTo;
  }
  return { tax: round2(tax), breakdown };
}

// ── Section 87A rebate ───────────────────────────────────────────────────────
// Old regime: full rebate up to ₹12,500 if taxable income ≤ ₹5L
// New regime: full rebate up to ₹25,000 if taxable income ≤ ₹7L (+ marginal relief above 7L)
function compute87ARebate(taxable, baseTax, regime) {
  if (regime === 'Old') {
    return taxable <= 500000 ? Math.min(baseTax, 12500) : 0;
  }
  // New
  if (taxable <= 700000) return Math.min(baseTax, 25000);
  // Marginal relief: if (taxable - 7L) < baseTax, rebate brings tax down to (taxable - 7L)
  if (taxable > 700000) {
    const excess = taxable - 700000;
    if (baseTax > excess) return round2(baseTax - excess);
  }
  return 0;
}

// ── Surcharge ────────────────────────────────────────────────────────────────
// Old regime bands: 10/15/25/37% above 50L/1Cr/2Cr/5Cr taxable income
// New regime: same 50L/1Cr/2Cr but 5Cr+ capped at 25% (no 37% in New)
function computeSurcharge(taxable, baseTaxAfterRebate, regime) {
  let rate = 0;
  if      (taxable >  50000000) rate = (regime === 'New') ? 25 : 37;
  else if (taxable >  20000000) rate = 25;
  else if (taxable >  10000000) rate = 15;
  else if (taxable >   5000000) rate = 10;
  return round2(baseTaxAfterRebate * rate / 100);
}

// ── Marginal relief at surcharge boundaries ──────────────────────────────────
// If (income just above threshold) - (income at threshold) < (surcharge increment),
// reduce the surcharge so net tax doesn't exceed the threshold's value + the income increment.
function applyMarginalRelief(taxable, baseTaxAfterRebate, surcharge, regime) {
  const THRESHOLDS = (regime === 'New')
    ? [5000000, 10000000, 20000000, 50000000]
    : [5000000, 10000000, 20000000, 50000000];
  // For each threshold the income just barely crosses, compare the post-surcharge tax
  // to what it would be at the threshold + the income increment.
  for (const T of THRESHOLDS) {
    if (taxable <= T) continue;
    // Tax at exactly T (using same regime)
    const slabs = (regime === 'New') ? SLABS_NEW : slabsOld(30);
    const { tax: taxAtT } = applySlabs(T, slabs);
    const rebateAtT       = compute87ARebate(T, taxAtT, regime);
    const surchargeAtT    = computeSurcharge(T, taxAtT - rebateAtT, regime);
    const totalAtT        = taxAtT - rebateAtT + surchargeAtT;
    const incomeIncrement = taxable - T;
    const proposedTotal   = baseTaxAfterRebate + surcharge;
    if (proposedTotal - totalAtT > incomeIncrement) {
      // Cap surcharge so total = totalAtT + incomeIncrement
      const reliefSurcharge = Math.max(0, totalAtT + incomeIncrement - baseTaxAfterRebate);
      return round2(reliefSurcharge);
    }
  }
  return surcharge;
}

// ── Main: computeTax ─────────────────────────────────────────────────────────
function computeTax({ taxableIncome, regime, age = 30 }) {
  const taxable = Math.max(0, Number(taxableIncome) || 0);
  const slabs = (regime === 'New') ? SLABS_NEW : slabsOld(Number(age) || 30);
  const { tax: baseTax, breakdown: slabBreakdown } = applySlabs(taxable, slabs);
  const rebate = compute87ARebate(taxable, baseTax, regime);
  const taxAfterRebate = round2(Math.max(0, baseTax - rebate));
  let surcharge = computeSurcharge(taxable, taxAfterRebate, regime);
  surcharge = applyMarginalRelief(taxable, taxAfterRebate, surcharge, regime);
  const subTotal = round2(taxAfterRebate + surcharge);
  const cess = round2(subTotal * 4 / 100);
  const totalTax = round2(subTotal + cess);
  return {
    regime,
    taxableIncome: round2(taxable),
    baseTax:       round2(baseTax),
    rebate87A:     round2(rebate),
    taxAfterRebate,
    surcharge,
    cess,
    totalTax,
    slabBreakdown,
  };
}

// ── HRA exemption u/s 10(13A) ────────────────────────────────────────────────
// Min of: actual HRA received, (rent paid − 10% of basic), 50%/40% of basic
// All amounts are ANNUAL.
function computeHraExemption({ rentPaid = 0, basic = 0, hraComponent = 0, isMetro = false }) {
  const rentExcess  = Math.max(0, Number(rentPaid)  || 0) - 0.10 * (Number(basic) || 0);
  const cap         = (isMetro ? 0.50 : 0.40) * (Number(basic) || 0);
  const actualHra   = Math.max(0, Number(hraComponent) || 0);
  const candidates  = [actualHra, Math.max(0, rentExcess), cap];
  const exempt      = Math.max(0, Math.min(...candidates));
  return {
    exempt: round2(exempt),
    formula: {
      actualHra:    round2(actualHra),
      rentExcess:   round2(Math.max(0, rentExcess)),
      pctCap:       round2(cap),
      pctRate:      isMetro ? 50 : 40,
      isMetro,
      winningRule:  exempt === actualHra ? 'actualHra' :
                    exempt === Math.max(0, rentExcess) ? 'rentMinus10PctBasic' : 'pctCap',
    },
  };
}

// ── Regime recommendation ────────────────────────────────────────────────────
// Compute total tax for both regimes given the same gross + section flags.
// Old regime gets standard deduction, PT, Chapter VI-A, HRA exemption.
// New regime gets standard deduction + PT only (Chapter VI-A and HRA blocked).
function recommendRegime({ grossSalary, stdDed = STANDARD_DEDUCTION, ptDeducted = 0, chapterVIA = 0, hraExempt = 0, age = 30 }) {
  const gross = Number(grossSalary) || 0;
  const sd = Math.min(STANDARD_DEDUCTION, stdDed || STANDARD_DEDUCTION);
  const pt = Number(ptDeducted) || 0;
  const c6 = Number(chapterVIA) || 0;
  const hra = Number(hraExempt) || 0;

  const taxableOld = Math.max(0, gross - sd - pt - c6 - hra);
  const taxableNew = Math.max(0, gross - sd - pt);   // C6 and HRA blocked

  const oldR = computeTax({ taxableIncome: taxableOld, regime: 'Old', age });
  const newR = computeTax({ taxableIncome: taxableNew, regime: 'New', age });

  const recommendedRegime = oldR.totalTax <= newR.totalTax ? 'Old' : 'New';
  const annualSaving = round2(Math.abs(oldR.totalTax - newR.totalTax));
  const monthlySaving = round2(annualSaving / 12);
  return {
    recommendedRegime,
    old: { ...oldR, taxableIncome: round2(taxableOld) },
    new: { ...newR, taxableIncome: round2(taxableNew) },
    annualSaving,
    monthlySaving,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = {
  STANDARD_DEDUCTION,
  computeTax,
  computeHraExemption,
  recommendRegime,
};
