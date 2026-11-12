// Who works in the room. Edit this file to rename people or change looks.
// Keep `height` between 0.8 and 1.1: outside that range a seated person's hands miss the keyboard.
//
// The relay picks the desk each Claude Code session sits at (relay/seats.js): the first free person,
// leaving `lead` for the session that is the Lead, and keeps them until it ends. There are nine
// desks, so nine sessions at a time. A desk is a look. The name a session shows comes from `names`:
// the least recently used name of the desk's `kind`, so it fits the look. Keep every name one word,
// so @mentions find it, and apart from the desks' own names. A desk's own name shows only while no
// session of the relay's sits there, and the Lead at the Lead's desk is always called by that desk's
// name, Paul, after Paul in Building 58. The role is still called the Lead. When the relay starts, it
// brings back the saved Lead or starts a new one, unless RELAY_LEAD=0. `skills` is only used by the "work" action, which sends a free
// person to work from outside a session. `startWith` people are always in the room. The rest come
// in for a session and leave when it ends. The relay reads this file when it starts, so restart it
// after you add, remove or rename someone.
(function () {
  const roster = {
    company: 'Building 58',
    neon: '#ff5fa2',
    startWith: 3,

    // The names sessions are called by, half for each kind of desk.
    names: {
      woman: ['Ada', 'Amara', 'Bea', 'Camila', 'Clara', 'Elena', 'Farah', 'Freya', 'Greta', 'Hana', 'Iris', 'Jade', 'Leila',
        'Lucia', 'Maya', 'Mei', 'Nadia', 'Olivia', 'Rosa', 'Sofia', 'Tara', 'Uma', 'Vera', 'Yara', 'Zoe'],
      man: ['Aaron', 'Arjun', 'Ben', 'Carlos', 'Diego', 'Eli', 'Felix', 'Hugo', 'Ivan', 'Jonas', 'Kenji', 'Leo', 'Malik',
        'Nico', 'Omar', 'Oscar', 'Pablo', 'Rafael', 'Ravi', 'Simon', 'Tomas', 'Victor', 'Wes', 'Yusuf', 'Zane']
    },

    // Walks through every so often, and anyone without real work sits down and looks busy until
    // the manager has gone. `everyMinutes` is the shortest and longest gap between visits. Take it
    // out and the manager only comes when sent with the "manager" action.
    manager: {
      everyMinutes: [6, 15],
      look: { skin: '#d9b08c', hair: '#8d8d8d', hairStyle: 'short', shirt: '#262a33', top: 'suit', lapel: '#1c1f27', dress: '#e8e4dc', tie: '#8c2f39', pants: '#262a33', shoes: '#15120f', height: 1.05 }
    },

    lead: {
      id: 'lead', name: 'Paul', kind: 'man', role: 'Coding agent',
      color: '#e3b26a',
      look: { skin: '#c58c64', hair: '#2b211c', hairStyle: 'short', shirt: '#3a3f47', top: 'hoodie', pants: '#2c3440', shoes: '#e8e4dc', mug: '#e3b26a', height: 1.0, extra: 'headphones' }
    },

    workers: [
      { id: 'priya', name: 'Priya', kind: 'woman', role: 'Debugging', color: '#f08c7e',
        skills: ['diagnose'],
        look: { skin: '#a8714f', hair: '#1a1412', hairStyle: 'bun', shirt: '#b5523b', pants: '#2f3542', shoes: '#1f1f1f', mug: '#f08c7e', height: 0.95, extra: 'glasses' } },
      { id: 'marcus', name: 'Marcus', kind: 'man', role: 'Tests', color: '#8fd19e',
        skills: ['tdd', 'migrate-to-shoehorn'],
        look: { skin: '#6b4430', hair: '#16110e', hairStyle: 'buzz', shirt: '#2f6b4f', pants: '#c9b79a', shoes: '#f2f2f2', mug: '#8fd19e', height: 1.04, extra: 'beard' } },
      { id: 'june', name: 'June', kind: 'woman', role: 'Product', color: '#c79be0',
        skills: ['to-prd', 'write-a-prd', 'grill-me', 'grill-with-docs'],
        look: { skin: '#f1c9a5', hair: '#d9a066', hairStyle: 'long', shirt: '#e9e2d0', pants: '#384b6b', shoes: '#8a5a3c', mug: '#c79be0', height: 0.93 } },
      { id: 'theo', name: 'Theo', kind: 'man', role: 'Issues', color: '#8fb0e3',
        skills: ['to-issues', 'prd-to-issues', 'triage'],
        look: { skin: '#e0b08a', hair: '#7a4a2a', hairStyle: 'curly', shirt: '#4d6fa8', pants: '#3b3b3b', shoes: '#d9d4c7', mug: '#8fb0e3', height: 1.0 } },
      { id: 'ines', name: 'Ines', kind: 'woman', role: 'Architecture', color: '#7fd8d0',
        skills: ['improve-codebase-architecture', 'zoom-out'],
        look: { skin: '#d6a27c', hair: '#2a1d17', hairStyle: 'bob', shirt: '#1f2a33', pants: '#6b5b4b', shoes: '#1f1f1f', mug: '#7fd8d0', height: 0.97, extra: 'glasses' } },
      { id: 'sam', name: 'Sam', kind: 'man', role: 'Tooling', color: '#f0c25e',
        skills: ['setup-pre-commit', 'git-guardrails-claude-code', 'setup-matt-pocock-skills', 'scaffold-exercises'],
        look: { skin: '#f3d2b5', hair: '#b8461f', hairStyle: 'beanie', beanie: '#d9822b', shirt: '#5b5f66', pants: '#2d3a4f', shoes: '#c43d3d', mug: '#f0c25e', height: 1.02, extra: 'beard' } },
      { id: 'kai', name: 'Kai', kind: 'man', role: 'Hot desk', color: '#9fd3ff', floater: true,
        skills: [],
        look: { skin: '#e8b98f', hair: '#111111', hairStyle: 'short', shirt: '#d8d2c4', pants: '#4a4a52', shoes: '#2a2a2a', mug: '#9fd3ff', height: 0.99 } },
      { id: 'noor', name: 'Noor', kind: 'woman', role: 'Hot desk', color: '#ffa8c5', floater: true,
        skills: ['write-a-skill', 'caveman'],
        look: { skin: '#9a6648', hair: '#140f0c', hairStyle: 'long', shirt: '#7a3b5c', pants: '#1f2430', shoes: '#e8e4dc', mug: '#ffa8c5', height: 0.95 } }
    ]
  };
  // The page reads it as window.OFFICE_ROSTER. The relay reads it too, named in world.json, to seat its sessions.
  if (typeof module !== 'undefined') module.exports = roster; else window.OFFICE_ROSTER = roster;
})();
