// Which routes a session's own token reaches, as a pure function: relay/server.js asks it for each
// request with a token, and relay/openapi.js asks it for each operation, so docs/openapi.json says which
// tokens reach a route from the same rule the relay keeps. A route a token reaches may still refuse it,
// such as a priority without its switch. rest is the path under /channels/{channel}, and seat is true
// for a session that is a seat in a game round. See docs/manual/relay.html#tokens.
'use strict';

function tokenReaches(agent, method, rest, seat) {
  const proposer = agent.role === 'coo' || agent.role === 'security';
  const plays = method === 'POST' && rest === '/play';
  return !!((plays || (seat ? method === 'POST' && (rest === '/commands' || rest === '/terminals/context') : ((rest === '/tickets' && !(proposer && method !== 'GET')) || (!proposer && /^\/chat(\/[\w-]{1,64})?$/.test(rest)) || (agent.lead && method === 'GET' && rest === '/floor') || (method === 'GET' && rest === '/rules') ||
    (agent.board && ((method === 'GET' && rest === '/tasks') || (method === 'POST' && (rest === '/floor/stop' || /^\/(tasks|tickets)\/[^/]+\/move$/.test(rest))))) ||
    (agent.lead && agent.starts > 0 && method === 'POST' && /^\/tickets\/[^/]+\/start$/.test(rest)) ||
    (agent.lead && method === 'POST' && rest === '/ready') ||
    (agent.role === 'coo' && ((method === 'GET' && rest === '/officers/coo/measures') || (method === 'POST' && rest === '/officers/coo/report'))) ||
    (agent.role === 'security' && ((method === 'GET' && rest === '/officers/security/measures') || (method === 'POST' && rest === '/officers/security/report'))) ||
    ((agent.role === 'reviewer' || !!agent.reviewOf) && method === 'POST' && rest === '/autopilot/verdict') ||
    ((agent.role === 'pm' || agent.lead) && method === 'POST' && /^\/tickets\/[\w-]{1,64}\/order$/.test(rest)) ||
    ((agent.role === 'pm' || agent.lead) && method === 'POST' && /^\/tickets\/[\w-]{1,64}\/(edit|propose)$/.test(rest)) ||
    (agent.role === 'pm' && method === 'POST' && /^\/tickets\/[\w-]{1,64}\/advice$/.test(rest)) ||
    (!proposer && method === 'POST' && /^\/tickets\/[\w-]{1,64}\/note$/.test(rest)) ||
    (agent.lead && method === 'POST' && rest === '/reviews/lead') ||
    (agent.lead && method === 'POST' && rest === '/autopilot/fix') ||
    (method === 'POST' && rest === '/terminals/context') ||
    (method === 'POST' && rest === '/commands')))));
}

module.exports = { tokenReaches };
