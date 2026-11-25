#!/usr/bin/env node
// One command for the PM-brief eval, on the computer that holds the model key (docs/manual/roles.html#pm-brief-eval).
//   npm run pm-brief-eval -- [--branch NAME] [--kit DIR] [--edd DIR] [--start CMD] [--api URL] [--push]
// It starts the edd-platform API with CMD in DIR, waits for it to answer, runs relay/pm-brief-eval.js on the
// branch (the branch checked out here, or NAME in a temporary checkout), and stops the API after. The model key
// comes from your own shell and goes only to the API: the eval gets an environment with no key, token or secret
// in it, and the API's output goes to a file only you can read, never to the screen. With --branch, a run that
// did not get worse commits relay/pm-brief-eval.json on a temporary checkout, and --push pushes it to NAME.
// Settings can come from PM_BRIEF_KIT, EDD_DIR, EDD_START and EDD_API. The exit code is the eval's: 0 did not
// get worse, 1 got worse, 2 could not run.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { oneLine } = require('./clean.js');

const HIDDEN = /key|token|secret|password|credential/i;
const FLAGS = { '--branch': 'branch', '--kit': 'kit', '--edd': 'edd', '--start': 'start', '--api': 'api' };
const KIT_HOME = path.join(__dirname, '..', 'docs', 'pm-brief-eval-kit');

class Stop extends Error {}

function options(argv, env) {
  const o = { api: env.EDD_API || 'http://127.0.0.1:8021/api', kit: env.PM_BRIEF_KIT || (fs.existsSync(KIT_HOME) ? KIT_HOME : null), edd: env.EDD_DIR, start: env.EDD_START, branch: null, push: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--push') { o.push = true; continue; }
    const key = FLAGS[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Stop('Usage: npm run pm-brief-eval -- [--branch NAME] [--kit DIR] [--edd DIR] [--start CMD] [--api URL] [--push]');
    o[key] = argv[++i];
  }
  if (o.kit) o.kit = path.resolve(o.kit);
  if (o.edd) o.edd = path.resolve(o.edd);
  if (!o.kit) throw new Stop('Name the eval kit with --kit DIR or PM_BRIEF_KIT.');
  if (!o.start || !o.edd) throw new Stop('Say how to start edd-platform with --edd DIR and --start CMD, or EDD_DIR and EDD_START.');
  if (o.push && !o.branch) throw new Stop('--push needs --branch NAME.');
  if (o.branch && !/^[\w./-]+$/.test(o.branch)) throw new Stop('That is not a branch name: ' + oneLine(o.branch, 80));
  return o;
}

function withoutSecrets(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !HIDDEN.test(k)));
}

function waitForPort(url, child) {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((done, fail) => {
    let gone = false;
    child.once('error', (e) => { gone = true; fail(new Stop('edd-platform did not start: ' + e.message)); });
    child.once('exit', (code) => { gone = true; fail(new Stop('edd-platform stopped with ' + code + ' before it answered.')); });
    const knock = () => {
      if (gone) return;
      const s = net.connect({ host: hostname, port: Number(port) || (protocol === 'https:' ? 443 : 80) });
      s.once('connect', () => { s.destroy(); done(); });
      s.once('error', () => { s.destroy(); setTimeout(knock, 500); });
    };
    knock();
  });
}

function waitForDown(url) {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((done) => {
    const knock = () => {
      const s = net.connect({ host: hostname, port: Number(port) || (protocol === 'https:' ? 443 : 80) });
      s.once('connect', () => { s.destroy(); setTimeout(knock, 100); });
      s.once('error', () => { s.destroy(); done(); });
    };
    knock();
  });
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Stop('git ' + args[0] + ' failed: ' + oneLine(r.stderr, 300));
  return r.stdout.trim();
}

function checkout(o, here) {
  if (!o.branch) return { dir: here, drop() {} };
  git(['fetch', 'origin', o.branch], here);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-brief-eval-'));
  git(['worktree', 'add', '--detach', dir, 'FETCH_HEAD'], here);
  return { dir, drop: () => spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: here }) };
}

function runEval(o, dir, env) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [path.join(dir, 'relay', 'pm-brief-eval.js'), '--kit', o.kit, '--api', o.api], { cwd: dir, env: withoutSecrets(env), stdio: 'inherit' });
    p.on('error', () => done(2));
    p.on('exit', (code) => done(code === null ? 2 : code));
  });
}

function isUp(url) {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((done) => {
    const s = net.connect({ host: hostname, port: Number(port) || (protocol === 'https:' ? 443 : 80) });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => { s.destroy(); done(false); });
  });
}

async function main(argv, env, here) {
  const o = options(argv, env);
  if (!fs.existsSync(o.edd) || !fs.statSync(o.edd).isDirectory()) throw new Stop('The edd-platform folder ' + o.edd + ' does not exist.');
  if (await isUp(o.api)) throw new Stop('Something already answers at ' + o.api + '. Stop it, or give another --api.');
  const work = checkout(o, here);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'edd-platform-'));
  const logFile = path.join(folder, 'output.log');
  const log = fs.openSync(logFile, 'wx', 0o600);
  let api = null, ended = null;
  const stopApi = () => {
    if (!api || api.exitCode !== null || api.signalCode !== null) return Promise.resolve();
    try { process.kill(-api.pid); } catch (e) { api.kill(); }
    return ended.then(() => waitForDown(o.api));
  };
  let keep = false;
  try {
    api = spawn(o.start, { cwd: o.edd, env, shell: true, stdio: ['ignore', log, log], detached: true });
    ended = new Promise((done) => api.once('exit', done));
    await waitForPort(o.api, api).catch((e) => { keep = true; throw new Stop(e.message + ' Its output is in ' + logFile + ', which may hold more than you want to share.'); });
    const code = await runEval(o, work.dir, env);
    if (code === 0 && o.branch) {
      const file = 'relay/pm-brief-eval.json';
      if (git(['status', '--porcelain', file], work.dir)) {
        git(['add', file], work.dir);
        git(['commit', '-m', 'Rerun the PM-brief eval'], work.dir);
        if (o.push) { git(['push', 'origin', 'HEAD:' + o.branch], work.dir); console.log('Pushed the new ' + file + ' to ' + o.branch + '.'); }
        else { console.log('Committed the new ' + file + ' in ' + work.dir + '. Push it with: git -C ' + work.dir + ' push origin HEAD:' + o.branch); work.drop = () => {}; }
      }
    }
    return code;
  } finally {
    await stopApi();
    fs.closeSync(log);
    if (!keep) fs.rmSync(folder, { recursive: true, force: true });
    work.drop();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, process.cwd()).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof Stop ? e.message : e.stack);
    process.exitCode = 2;
  });
}

module.exports = { options, withoutSecrets, waitForPort, main };
