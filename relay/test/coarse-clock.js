// Loaded with --require into a test relay: Date.now() counts in whole seconds, as a coarse clock does,
// so two things that happen one after the other read the same time (relay/test/coo.test.js, T-163).
'use strict';
const now = Date.now;
Date.now = () => Math.floor(now() / 1000) * 1000;
