// Three pretend Claude Code sessions, written as the hook events they would send, about two
// and a half minutes long, each with its own person. The "Run a demo" button plays it in the page, and relay/office.js --demo
// (npm run office:demo) sends the same events through the relay, the way the real hook does.
// Each step is [seconds from the start, hook payload].
(function (root) {
  'use strict';
  function build(S, project) {
    const ev = (name, o) => Object.assign({ hook_event_name: name, session_id: S, project }, o || {});
    const tool = (name, input, agent) => ev('PreToolUse', Object.assign({ tool_name: name, tool_input: input || {} }, agent ? { agent_id: agent.id, agent_type: agent.type } : {}));
    const EXPLORE = { id: S + '-explore', type: 'Explore' }, PLAN = { id: S + '-plan', type: 'Plan' };
    return [
      [0, ev('SessionStart', { source: 'startup' })],
      [1.5, ev('UserPromptSubmit')],
      [3, tool('Skill', { skill: 'grill-me' })],
      [5, tool('Read', { file: 'docs/checkout.md' })],
      [8, tool('Grep', { pattern: 'applyDiscount' })],
      [11, tool('Read', { file: 'src/cart/discount.ts' })],
      [15, tool('Skill', { skill: 'to-prd' })],
      [18, tool('Write', { file: 'docs/prd/discount-codes.md' })],
      [23, tool('Skill', { skill: 'to-issues' })],
      [26, tool('Bash', { command: 'gh issue create' })],
      [29, tool('Bash', { command: 'gh issue create' })],
      [32, tool('Bash', { command: 'gh issue create' })],
      [35, tool('Agent', { subagent_type: 'Explore', description: 'Find discount code paths' })],
      [36, ev('SubagentStart', { agent_id: EXPLORE.id, agent_type: 'Explore' })],
      [38, tool('Grep', { pattern: 'discount' }, EXPLORE)],
      [39, tool('Skill', { skill: 'tdd' })],
      [41, tool('Write', { file: 'src/cart/discount.test.ts' })],
      [43, tool('Read', { file: 'src/cart/pricing.ts' }, EXPLORE)],
      [45, tool('Bash', { command: 'npm test' })],
      [47, ev('PostToolUseFailure', { tool_name: 'Bash' })],
      [48, tool('Glob', { pattern: 'src/**/*.ts' }, EXPLORE)],
      [50, tool('Edit', { file: 'src/cart/discount.ts' })],
      [53, tool('Bash', { command: 'npm test' })],
      [55, ev('SubagentStop', { agent_id: EXPLORE.id, agent_type: 'Explore' })],
      [58, ev('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })],
      [67, tool('Bash', { command: 'git commit' })],
      [69, tool('Skill', { skill: 'diagnose' })],
      [71, tool('Bash', { command: 'npm run bench' })],
      [75, tool('Read', { file: 'src/cart/pricing.ts' })],
      [79, tool('Edit', { file: 'src/cart/pricing.ts' })],
      [83, tool('Bash', { command: 'npm test' })],
      [86, tool('Agent', { subagent_type: 'Plan', description: 'Plan the pricing refactor' })],
      [87, ev('SubagentStart', { agent_id: PLAN.id, agent_type: 'Plan' })],
      [90, tool('Read', { file: 'src/cart/index.ts' }, PLAN)],
      [95, tool('Read', { file: 'docs/adr/0004-pricing.md' }, PLAN)],
      [101, ev('SubagentStop', { agent_id: PLAN.id, agent_type: 'Plan' })],
      [103, tool('Skill', { skill: 'setup-pre-commit' })],
      [105, tool('Bash', { command: 'npm install' })],
      [109, tool('Write', { file: '.husky/pre-commit' })],
      [113, tool('Bash', { command: 'npx lint-staged' })],
      [118, ev('Stop')],
      [125, ev('SessionEnd', { reason: 'other' })]
    ];
  }
  function demo() {
    return [[0, 'acme-store', 'Discount codes at checkout'], [12, 'billing-api', 'Retrying failed invoices'], [27, 'docs-site', 'Search for the docs']]
      // Claude Code names a session shortly after its first prompt
      .flatMap(([start, project, title]) => build('demo' + Math.floor(Math.random() * 9000 + 1000), project).map(([at, payload]) => [at + start, at >= 3 ? Object.assign({ title }, payload) : payload]))
      .sort((a, b) => a[0] - b[0]);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = demo;
  else root.OFFICE_DEMO = demo;
})(this);
