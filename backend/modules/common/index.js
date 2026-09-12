// =====================================================================
// modules/common — Cross-department / employee-wide routes (PLACEHOLDER)
//
// Planned: 24 employee-facing modules (used by every user regardless of dept):
//   My Dashboard, My Profile, My Leave Balance, Apply Leave, My Salary Slip,
//   My Attendance, My Expense (submit + history), My Approval Inbox,
//   My Submitted Requests, My Visit Plan/MOM, My Targets, My Documents,
//   My IT Assets, Holiday Calendar, Org Directory, Help Desk,
//   Notifications, Announcements, Suggestion Box, Org Chart,
//   Birthday Board, Polls, Document Repository
// See BRD section 6.9 for full list.
// =====================================================================

const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({ module: 'common', status: 'placeholder', message: 'Common employee routes will be added here.' });
});

module.exports = router;
