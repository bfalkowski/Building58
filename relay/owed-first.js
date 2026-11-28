// A Dev owed fixes (task.bringBack) comes back before a review of new work takes the free desk.
// oldest names the Dev owed longest. canStart names the one that can start once a desk is free: not one
// the WIP limit holds, since a review of new work may be what frees that slot.
// The owed task's own follow-up review is not new work, so it never waits here.
'use strict';

const owedTasks = (list) => list.filter((t) => t.bringBack && t.state !== 'done').sort((a, b) => a.bringBack.at - b.bringBack.at);
const oldest = (list) => owedTasks(list)[0] || null;
const canStart = (list) => owedTasks(list).find((t) => t.bringBack.error !== 'wip_limit') || null;

module.exports = { owedTasks, oldest, canStart };
