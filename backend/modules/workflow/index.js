// =====================================================================
// modules/workflow — Cross-department Approval Workflow Engine (PLACEHOLDER)
//
// Drives 15 cross-department workflows configurable via DB tables:
//   W1  Leave Approval         W9  Material Issue
//   W2  Expense Reimbursement  W10 Stock Adjustment
//   W3  Purchase Requisition   W11 Resignation / Exit
//   W4  Sample Request         W12 NPI Approval
//   W5  Credit Note Request    W13 Onboarding Checklist
//   W6  Discount Approval      W14 Performance Review
//   W7  Customer Complaint     W15 SO → Invoice Handoff
//   W8  Vendor Payment
//
// Backed by BN_WF_Definition / BN_WF_Stage / BN_WF_Instance / BN_WF_History.
//
// Endpoints (target):
//   GET  /api/workflow/inbox            — pending approvals owed by current user
//   GET  /api/workflow/submitted        — requests I have submitted
//   GET  /api/workflow/instance/:id     — full history of one request
//   POST /api/workflow/instance/:id/action  — Approve/Reject/Forward
//   GET  /api/workflow/definitions      — admin: list configured workflows
//   POST /api/workflow/definitions      — admin: create new workflow type
// =====================================================================

const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({ module: 'workflow', status: 'placeholder', message: 'Workflow Engine routes will be added here.' });
});

module.exports = router;
