// A Dev owed fixes (task.bringBack) comes back before a review of new work takes the free desk.
// oldest names the Dev owed longest. A review of new work waits for it while a desk is free.
// The owed task's own follow-up review is not new work, so it never waits here.
'use strict';

const owedTasks = (list) => list.filter((t) => t.bringBack && t.state !== 'done').sort((a, b) => a.bringBack.at - b.bringBack.at);
const oldest = (list) => owedTasks(list)[0] || null;

module.exports = { owedTasks, oldest };
