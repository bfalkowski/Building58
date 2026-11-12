// People sit on the couch and the armchair, not in them (seatOn in office/poses.js). Measured here from
// the rig in buildPerson (office/office.js), not from poses.js, so a wrong number there cannot hide a
// hit: the pelvis ball is 0.16 * 0.55 from its centre to its bottom, the hip 0.02 under the pelvis,
// the thigh 0.43 long and 0.07 thick, and the shoe's sole 0.49 from the knee. The couch's cushions
// are 0.47 high and end 0.29 in front of a sitter's hips; the armchair's seat is 0.39 high and ends
// 0.33 in front.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { POSE, seatOn } = require('../../office/poses.js');

const PELVIS = 0.16 * 0.55, HIP = 0.02, THIGH = 0.43, THIGH_R = 0.07, SHIN = 0.49;
const SEATS = { couch: { top: 0.47, edge: 0.29 }, armchair: { top: 0.39, edge: 0.33 } };
// office/roster.js asks for heights from 0.8 to 1.1.
const HEIGHTS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1];
const cm = (x) => (x * 100).toFixed(1) + ' cm';

for (const [seatName, s] of Object.entries(SEATS)) {
  for (const poseName of ['couch', 'couchBack']) {
    test(poseName + ' on the ' + seatName + ': on the seat, not in it, and feet not through the floor', () => {
      for (const height of HEIGHTS) {
        const p = Object.assign({}, POSE[poseName], seatOn(POSE[poseName], s.top, height));
        const at = poseName + ', height ' + height + ': ';
        const bottom = (p.py - PELVIS) * height;
        assert.ok(bottom >= s.top - 0.005, at + 'the pelvis is ' + cm(s.top - bottom) + ' into the seat');
        assert.ok(bottom <= s.top + 0.01, at + 'the pelvis floats ' + cm(bottom - s.top) + ' over the seat');
        for (const [hip, knee] of [['hipL', 'kL'], ['hipR', 'kR']]) {
          const hipY = (p.py - HIP) * height;
          // Where the thigh crosses the seat's front edge. Below the horizontal is down.
          const down = Math.PI / 2 + p[hip];
          const thighBottom = hipY - s.edge * Math.tan(down) - THIGH_R * height / Math.cos(down);
          assert.ok(thighBottom >= s.top - 0.04, at + hip + ': the thigh is ' + cm(s.top - thighBottom) + ' into the seat\'s front edge');
          const kneeY = hipY - THIGH * height * Math.cos(p[hip]);
          const footY = kneeY - SHIN * height * Math.cos(p[hip] + p[knee]);
          assert.ok(footY >= -0.005, at + knee + ': the shoe is ' + cm(-footY) + ' through the floor');
        }
      }
    });
  }
}
