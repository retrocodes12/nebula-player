#!/usr/bin/env node
// Nebula Cloud — the Founder's supporter desk. Runs beside the server (it reads
// the admin token from <DATA_DIR>/support-config.json) and talks to it over
// loopback, so nothing here needs a restart:
//
//   node support-admin.js init                    make support-config.json (admin token) if missing
//   node support-admin.js url [https://…]         show or set the support link the apps open
//   node support-admin.js issue [n] [note…]       mint n one-time codes (default 1) — send one to each supporter
//   node support-admin.js list                    open + used codes, and every supporter
//   node support-admin.js grant @handle [note…]   make a profile a supporter without a code
//   node support-admin.js revoke @handle          take it back (their wall entry goes too)
//   node support-admin.js drop NEB-XXXX-XXXX      void an unused code
//
// Env: DATA_DIR (default ./data), CLOUD_BASE (default http://127.0.0.1:3342).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE = (process.env.CLOUD_BASE || 'http://127.0.0.1:3342').replace(/\/$/, '');
const CONFIG_PATH = path.join(DATA_DIR, 'support-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return null; }
}
function writeConfig(c) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}
function need() {
  const c = readConfig();
  if (!c || !c.admin) { console.error('No admin token yet — run: node support-admin.js init'); process.exit(2); }
  return c;
}
async function call(method, p, body) {
  const c = need();
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': c.admin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.error('HTTP ' + r.status + ' ' + (j && j.error ? j.error : '')); process.exit(1); }
  return j;
}
function when(t) { return t ? new Date(t).toISOString().slice(0, 10) : ''; }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') {
    const c = readConfig() || {};
    if (c.admin) { console.log('support-config.json already has an admin token (' + CONFIG_PATH + ')'); return; }
    c.admin = crypto.randomBytes(24).toString('hex');
    if (!('url' in c)) c.url = '';
    writeConfig(c);
    console.log('Wrote ' + CONFIG_PATH + ' — set the link with: node support-admin.js url https://…');
    return;
  }
  if (cmd === 'url') {
    const c = readConfig() || {};
    if (!rest[0]) { console.log(c.url || '(no support link set — the apps hide the section)'); return; }
    if (!/^https:\/\/\S{4,}$/.test(rest[0])) { console.error('The link must start with https://'); process.exit(2); }
    c.url = rest[0];
    writeConfig(c);
    console.log('Support link is now ' + c.url + ' (live within 5 s, no restart)');
    return;
  }
  if (cmd === 'issue') {
    const n = /^\d+$/.test(rest[0] || '') ? Number(rest.shift()) : 1;
    const r = await call('POST', '/v1/support/codes', { n, note: rest.join(' ') });
    r.codes.forEach((c) => console.log(c));
    return;
  }
  if (cmd === 'list') {
    const r = await call('GET', '/v1/support/codes');
    const open = r.codes.filter((c) => !c.used), used = r.codes.filter((c) => c.used);
    console.log('Open codes (' + open.length + ')');
    open.forEach((c) => console.log('  ' + c.code + '  ' + when(c.at) + (c.note ? '  ' + c.note : '')));
    console.log('Used codes (' + used.length + ')');
    used.forEach((c) => console.log('  ' + c.code + '  @' + c.used.handle + '  ' + when(c.used.at) + (c.note ? '  ' + c.note : '')));
    console.log('Supporters (' + r.supporters.length + ')');
    r.supporters.forEach((s) => console.log('  @' + (s.handle || '?') + '  since ' + when(s.since) + (s.wall ? '  on the wall' : '') +
      '  via ' + s.via + (s.note ? '  ' + s.note : '')));
    return;
  }
  if (cmd === 'grant' || cmd === 'revoke') {
    const handle = rest.shift();
    if (!handle) { console.error('Which @handle?'); process.exit(2); }
    const r = await call('POST', '/v1/support/' + cmd, { handle, note: rest.join(' ') });
    console.log(cmd === 'grant' ? '@' + r.handle + ' is a supporter since ' + when(r.supporter.since) : 'Revoked ' + handle);
    return;
  }
  if (cmd === 'drop') {
    if (!rest[0]) { console.error('Which code?'); process.exit(2); }
    await call('DELETE', '/v1/support/codes/' + encodeURIComponent(rest[0]));
    console.log('Dropped ' + rest[0]);
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^\/\/ {2,}node|^\/\/ Env/.test(l)).map((l) => l.slice(3)).join('\n'));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
