// =====================================================================
// shared/workflowEngine.js — generic approval workflow engine (PLACEHOLDER)
//
// Drives every cross-department approval flow:
//   Leave, Expense, Purchase Requisition, Sample Request, Credit Note,
//   Discount Approval, Customer Complaint, Vendor Payment, Material Issue,
//   Stock Adjustment, Resignation, NPI, Onboarding, Performance Review,
//   SO → Invoice Handoff
//
// Backed by tables BN_WF_Definition / BN_WF_Stage / BN_WF_Instance / BN_WF_History
// (created by SQL Files/00_Restructure_Migration.sql).
//
// API contract (target):
//   const wf = require('../../shared/workflowEngine');
//
//   // Submit a new request into a workflow
//   const instanceId = await wf.submit({
//     workflowKey: 'LEAVE_APPROVAL',
//     entityType:  'leave_request',
//     entityId:    leaveRequestRow.Id,
//     submittedBy: req.user.id,
//     payload:     { amount: 5000, leaveType: 'CL' }   // for ConditionExpr
//   });
//
//   // Approve / reject the current stage
//   await wf.action({ instanceId, userId, action: 'Approve', comment: 'OK' });
//
//   // Get pending approvals for a user (for Approval Inbox)
//   const inbox = await wf.getInbox(userId);
//
//   // Get full history of an instance (for detail view)
//   const history = await wf.getHistory(instanceId);
// =====================================================================

async function submit(opts) {
  throw new Error('workflowEngine.submit not yet implemented');
}

async function action(opts) {
  throw new Error('workflowEngine.action not yet implemented');
}

async function getInbox(userId) {
  return [];
}

async function getHistory(instanceId) {
  return [];
}

module.exports = { submit, action, getInbox, getHistory };
