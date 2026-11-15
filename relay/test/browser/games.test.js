// The Games panel in a browser (relay/test/browser/page.js), with WebGL off. The relay gets a
// temporary GAMES_REPO with made-up games whose entry loads relay/test/game.fixture.js, as in
// relay/test/games.test.js. The panel lists the games, starts a round, shows its seats, answers the
// trust question, says when every seat is done, shows what each seat did (its steps, from a made-up
// Claude Code transcript), and shows the score and the reveal after Finish.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { office, pageTest, errorsBut } = require('./page.js');
const { until } = require('../helpers.js');
const { writeTranscript } = require('../transcript.fixture.js');

const FIXTURE = path.join(__dirname, '..', 'game.fixture.js');
// Seats run inside sandbox-exec on macOS. Elsewhere, such as Linux CI, rounds run with the boundary off.
const BOUNDARY = process.platform === 'darwin' ? {} : { RELAY_SEAT_ISOLATION: 'off' };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'games-page-')));
const game = (folder, manifest) => {
  fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, folder, 'game.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, folder, 'game.js'), 'require(' + JSON.stringify(FIXTURE) + ');\n');
};
game('coin', { name: 'Coin toss', version: '0.1.0', api: 1, entry: 'game.js', players: { min: 2, max: 3 }, needs: ['privateBriefs', 'ask'],
  about: 'ABOUT-MARK: two seats toss a coin.', metrics: { caught: 'MEANING-MARK: paid seats found.' } });
game('later', { name: 'Needs more', version: '0.1.0', api: 1, entry: 'game.js', players: { min: 1, max: 2 }, needs: ['voice'] });

let o;
test.before(async () => { o = await office({ env: { ...BOUNDARY, GAMES_REPO: root, FAKE_CLAUDE_TRUST: 'arrow', RELAY_SEAT_SPEND_MS: '200' } }); });
test.after(async () => { if (o) await o.stop(); fs.rmSync(root, { recursive: true, force: true }); });
const get = () => o;

async function openPanel(p) {
  await o.R.call('POST', '/rounds/current/stop', {});  // a round an earlier test left running
  await p.open();
  const page = p.page;
  if (await page.locator('#games').evaluate((s) => s.hasAttribute('data-folded'))) await page.locator('#games > header h2 .fold').click();
  await page.locator('#game-list li', { hasText: 'Coin toss' }).waitFor();
  return page;
}

// With GAMES_PANEL_SHOTS set to a folder, the round test saves pictures of the panel there, to look at.
const shot = (page, name) => (process.env.GAMES_PANEL_SHOTS ? page.locator('#games').screenshot({ path: path.join(process.env.GAMES_PANEL_SHOTS, 'games-' + name + '.png') }) : null);
// A seat's row, by its seat name, with what it waits on: 'trust', or '' for nothing.
const seatRow = (page, seat, waiting) => page.locator('#game-seats li[data-waiting="' + waiting + '"]').filter({ has: page.locator('b', { hasText: new RegExp('^' + seat + '$') }) });

pageTest('the Games panel lists the games, and says why one cannot run', get, async (p) => {
  const page = await openPanel(p);
  assert.match(await page.innerText('#game-list li[data-ok="1"]'), /Coin toss[\s\S]*coin · version 0\.1\.0 · 2 to 3 seats/);
  assert.match(await page.innerText('#game-list li[data-ok="0"]'), /Needs more[\s\S]*Cannot run: .*voice/);
  assert.deepStrictEqual(await page.locator('#game-pick option').allInnerTexts(), ['Coin toss'], 'only a game that can run is offered');
  assert.strictEqual(await page.inputValue('#game-seats-n'), '2', 'the seat count starts at the game\'s fewest');
  assert.strictEqual(await page.innerText('#game-about'), 'ABOUT-MARK: two seats toss a coin.', 'the game says what it is before a round starts');
  assert.strictEqual(await page.locator('#game-round').isVisible(), false);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a round starts from the panel, shows its seats, takes the trust answer, and Finish shows the score and the reveal', get, async (p) => {
  const page = await openPanel(p);
  await page.fill('#game-seed', 'page-seed');
  await page.click('#game-form [type=submit]');
  await page.locator('#game-round').waitFor();
  const round = (await o.R.call('GET', '/rounds/current')).body.round;
  assert.strictEqual(round.seats.length, 2);
  assert.match(await page.innerText('#game-round-about'), BOUNDARY.RELAY_SEAT_ISOLATION ? /no boundary/ : /each seat in its own sandbox/);
  assert.strictEqual(await page.locator('#game-form [type=submit]').isDisabled(), true, 'one round at a time');
  // Each seat waits on the trust question. Its first choice is No, so the panel sends Down, then Enter.
  for (const s of round.seats) await seatRow(page, s.seat, 'trust').waitFor();
  assert.match(await page.innerText('#game-trust-note'), /first choice is No, exit/);
  await seatRow(page, 'S1', 'trust').getByRole('button', { name: 'Trust this seat\'s folder' }).click();
  await until(async () => (await o.R.screen(round.seats[0].terminal)).includes('folder accepted'), 'S1 trusted');
  await page.click('#game-trust-all');
  await until(async () => (await o.R.screen(round.seats[1].terminal)).includes('folder accepted'), 'S2 trusted');
  // The fake claude sends no hooks, so the test sends the one a real session sends once it is past the question.
  const terms = (await o.R.call('GET', '/terminals')).body.terminals;
  for (const s of round.seats) {
    await o.R.hook({ hook_event_name: 'SessionStart', session_id: terms.find((x) => x.id === s.terminal).sessionId.slice(0, 12) });
    await seatRow(page, s.seat, '').waitFor();
  }
  assert.strictEqual(await page.locator('#game-trust-all').isVisible(), false, 'no seat waits now');
  assert.match(await page.innerText('#game-round-about'), /\$0\.00 at API prices/);
  assert.strictEqual(await page.locator('#game-done').isVisible(), false, 'no seat has worked yet');
  // Under Watch all a seat's screen opens in the Claude Code panel, and says it is read-only.
  await seatRow(page, 'S1', '').getByRole('button', { name: 'Show its screen' }).click();
  await page.locator('#cc-term .xterm-rows', { hasText: 'BRIEF-MARK-S1' }).waitFor();
  await page.locator('#cc-status', { hasText: 'read-only' }).waitFor();
  // Each seat works, as its transcript shows, and is idle again: the panel says to press Finish.
  for (const s of round.seats) {
    const x = terms.find((y) => y.id === s.terminal);
    writeTranscript(o.R.home, x.cwd, x.sessionId, { brief: 'STEP-BRIEF-' + s.seat, requests: 2 });
  }
  await page.locator('#game-done', { hasText: 'All seats are done. Press Finish' }).waitFor();
  assert.match(await page.innerText('#game-round-about'), /\$0\.13 at API prices/, 'two seats of two requests at 0.032 dollars each');
  assert.match(await seatRow(page, 'S1', '').innerText(), /done · 26k in, 1k out, \$0\.06/);
  // Steps shows what a seat did, one folded row a step, with none of Claude Code's own notes.
  await seatRow(page, 'S1', '').getByRole('button', { name: 'Steps' }).click();
  await page.locator('#game-step-rows li').first().waitFor();
  assert.match(await page.innerText('#game-steps-title'), new RegExp('Round ' + round.id + ' · seat S1'));
  assert.match(await page.innerText('#game-steps-about'), /8 steps · 26k in, 1k out · \$0\.06 at API prices/);
  assert.deepStrictEqual(await page.locator('#game-step-rows li').evaluateAll((ls) => ls.map((l) => l.dataset.kind)), ['brief', 'says', 'runs', 'result', 'says', 'runs', 'result', 'says']);
  assert.strictEqual(await page.locator('#game-step-rows pre').first().isVisible(), false, 'each step starts folded');
  await page.locator('#game-step-rows li[data-kind="runs"] summary').first().click();
  assert.match(await page.locator('#game-step-rows li[data-kind="runs"] pre').first().innerText(), /OFFICE_PLAY/);
  assert.match(await page.innerText('#game-step-rows'), /brief\s*STEP-BRIEF-S1[\s\S]*runs Bash/);
  assert.ok(!/REMINDER-MARK|example\.com/.test(await page.innerText('#game-steps')), 'no system reminder');
  await shot(page, 'steps');
  await page.click('#game-finish');
  await page.locator('#game-result').waitFor();
  const result = await page.innerText('#game-result');
  assert.match(result, /Score[\s\S]*Metrics[\s\S]*caught\s+1\s+MEANING-MARK: paid seats found\.[\s\S]*falseAccusations\s+0[\s\S]*Seats[\s\S]*S1\s+caught/);
  assert.match(result, /Reveal[\s\S]*member\s+S1[\s\S]*note\s+TRUTH-MARK/);
  assert.strictEqual(await page.locator('#game-round').isVisible(), false, 'the round is over');
  await page.locator('#game-past-box summary').click();
  await page.locator('#game-past li', { hasText: 'round ' + round.id }).waitFor();
  assert.match(await page.innerText('#game-past'), /\$0\.13[\s\S]*caught 1, falseAccusations 0/);
  // After the round, the steps still open, from the result and from Past rounds.
  await page.locator('#game-result').getByRole('button', { name: 'Steps S2' }).click();
  await page.locator('#game-step-rows li', { hasText: 'STEP-BRIEF-S2' }).waitFor();
  await page.locator('#game-past li', { hasText: 'round ' + round.id }).getByRole('button', { name: 'Steps S1' }).click();
  await page.locator('#game-step-rows li', { hasText: 'STEP-BRIEF-S1' }).waitFor();
  await shot(page, 'after');
  assert.strictEqual((await o.R.call('GET', '/rounds/current')).body.round, null);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the panel shows the relay\'s reason when a round cannot start, and Stop ends one with no score', get, async (p) => {
  const page = await openPanel(p);
  await page.fill('#game-seats-n', '9');
  await page.click('#game-form [type=submit]');
  await page.locator('#game-note[data-bad="1"]', { hasText: 'Coin toss takes 2 to 3 seats.' }).waitFor();
  await page.fill('#game-seats-n', '2');
  await page.fill('#game-settings', '{not json');
  await page.click('#game-form [type=submit]');
  await page.locator('#game-note[data-bad="1"]', { hasText: 'The settings are not valid JSON.' }).waitFor();
  await page.fill('#game-settings', '');
  await page.selectOption('#game-watch', 'none');
  await page.click('#game-form [type=submit]');
  await page.locator('#game-round').waitFor();
  assert.match(await page.innerText('#game-round-about'), /watch none/);
  assert.strictEqual(await page.locator('#game-seats button', { hasText: 'Show its screen' }).count(), 0, 'no screen to open under Watch none');
  await page.click('#game-stop');
  await page.locator('#game-note', { hasText: 'Stopped. The round keeps no score.' }).waitFor();
  await page.locator('#game-round').waitFor({ state: 'hidden' });
  assert.strictEqual(await page.locator('#game-result').isVisible(), false);
  assert.deepStrictEqual(errorsBut(p, 400, '/channels/t/rounds'), []);
});
