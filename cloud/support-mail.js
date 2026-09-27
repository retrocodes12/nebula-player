// Nebula Cloud — the receipt e-mail a paid order earns (2026-09-27). One
// message per order, to the address the payment service reported with it:
// the key (plus the thank-you page, whose button installs it in one tap) and,
// for a buyer who was not signed in, the one-time Nebula Player code. Nothing
// else is ever sent from here: the sending account is for transactional mail
// only, and a buyer never opted in to anything more.
//
// Sent through Resend's HTTP API — the `mail` block in support-config.json
// ({apiKey, from, replyTo?, api?}) or RESEND_API_KEY / SUPPORT_MAIL_FROM.
// The webhook marks a new order `mailWant` and asks for a send; a send waits
// up to KEY_WAIT_MS for the key (the mint may still be retrying — each try
// here asks it again), then goes with or without it. Resend's Idempotency-Key
// is the order id, so a retry after a lost answer is not a second e-mail. A
// failed send is retried by the sweep, further apart each time.
//
// Orders from before this existed carry no `mailWant` and are never mailed by
// themselves: the Founder sends those by hand (POST /v1/support/mail, or
// `support-admin.js mail send <order>`).

'use strict';

const KEY_WAIT_MS = 10 * 60_000;                 // how long a receipt waits for a key that is still being made
const MAX_TRIES = 6;                             // failed sends, then the order is left for a hand send
const SEND_TIMEOUT_MS = 10_000;
const SWEEP_MS = Number(process.env.SUPPORT_MAIL_SWEEP_MS ?? 60_000);   // the tests shorten both
const RETRY_MS = Number(process.env.SUPPORT_MAIL_RETRY_MS ?? 60_000);   // the first retry; each later one waits twice as long

module.exports = function attach(deps) {
  const { store, persistStore, TIERS, ensureSportsKey, codeUsedBy, config } = deps;
  const busy = new Set();                        // order ids with a send in flight

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /** "kim@example.org" → "k***@e***" — what the logs and the admin list show. */
  function mask(e) { return String(e || '').replace(/^(.)[^@]*(@.).*$/, '$1***$2***') || '(none)'; }

  /** The order's e-mail: {subject, text, html}. `sid` is the thank-you page's id (null when the order came with no session). */
  function compose(rec, sid, site) {
    const name = (TIERS[rec.tier] || TIERS.supporter).name;
    const page = sid && /^[0-9a-f]{24}$/.test(sid) ? site.replace(/\/$/, '') + '/support.html?thanks=' + sid : null;
    const used = rec.state === 'granted' ? (rec.handle || 'your profile') : (rec.code ? codeUsedBy(rec.code) : null);
    const hasKey = !!(rec.sportsKey && rec.sportsManifest);
    const T = [], H = [];
    const p = (t, h) => { T.push(t, ''); H.push(h === undefined ? '<p style="margin:0 0 14px">' + esc(t) + '</p>' : h); };
    const head = (t) => { T.push(t.toUpperCase()); H.push('<h2 style="margin:26px 0 10px;font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#6b6b73">' + esc(t) + '</h2>'); };
    const mono = (t) => { T.push(t, ''); H.push('<p style="margin:0 0 14px;padding:12px 14px;background:#f3f3f5;border-radius:10px;font:15px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all">' + esc(t) + '</p>'); };
    const button = (label, url) => { T.push(label + ': ' + url, ''); H.push('<p style="margin:0 0 14px"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#e50914;color:#fff;text-decoration:none;font-weight:600">' + esc(label) + '</a></p>'); };

    p("You're a " + name + ' — thank you for supporting Nebula.', '<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3">' + esc("You're a " + name + ' — thank you for supporting Nebula.') + '</h1>');
    if (hasKey) {
      head('Your key');
      p('No sponsor prompt, on every device you add it to.');
      if (page) button('Install it', page);
      p(page ? 'Or paste this link into your add-ons list on any device:' : 'Paste this link into your add-ons list on any device:');
      mono(rec.sportsManifest);
      p('Then remove the free add-on, so you do not see two of everything.');
    } else if (rec.order && (rec.sportsError || rec.sportsTriedAt)) {
      head('Your key');
      p(page ? 'Your key is still being made. Your thank-you page shows it the moment it is ready:' : 'Your key is still being made — reply to this e-mail and it will be sent to you.');
      if (page) button('Open your thank-you page', page);
    }
    if (rec.state === 'granted' || rec.code) {
      head('In Nebula Player');
      if (used) {
        p('The ' + name + ' thank-you is already on your Nebula Player profile' + (used === 'your profile' ? '' : ' (@' + used + ')') + '.');
      } else if (rec.code) {
        mono(rec.code);
        p('Use Nebula Player too? Type this code into Settings › Support on any device you are signed in to. It puts the ' + name + ' thank-you on your profile.');
      }
    }
    p('Keep this e-mail: it is your copy of ' + (hasKey && rec.code && !used ? 'the key and the code' : hasKey ? 'the key' : 'the code') + '.');
    p('Order ' + rec.order + ' · Something wrong? Reply to this e-mail.', '<p style="margin:22px 0 0;color:#6b6b73;font-size:13px">' + esc('Order ' + rec.order + ' · Something wrong? Reply to this e-mail.') + '</p>');

    const subject = hasKey ? 'Your Nebula key' + (rec.code && !used ? ' and code' : '') : 'Your Nebula ' + name + ' thank-you';
    const html = '<!doctype html><html><body style="margin:0;padding:24px 16px;background:#fff;color:#111114;font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">' +
      '<div style="max-width:560px;margin:0 auto">' + H.join('') + '</div></body></html>';
    return { subject, text: T.join('\n').replace(/\n+$/, '') + '\n', html };
  }

  /** One POST to the mail service. Resolves the message id; throws with the service's answer. */
  async function deliver(msg, to, mail, idem) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    let r, body;
    try {
      r = await fetch(mail.api + '/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + mail.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': idem,
          'User-Agent': 'nebula-cloud' },            // the service refuses some default agents outright
        body: JSON.stringify({ from: mail.from, to: [to], subject: msg.subject, text: msg.text, html: msg.html,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
        signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    if (!r.ok || !body || typeof body.id !== 'string') throw new Error('mail ' + r.status + ' ' + JSON.stringify(body || '').slice(0, 160));
    return body.id;
  }

  /** Send this order's receipt. opts: {to} = a test address (the record is not marked), {again} = send even though it went. */
  async function send(rec, sid, opts = {}) {
    const c = config();
    if (!c.mail) return { skipped: 'mail off' };
    const to = opts.to || rec.email;
    if (!to) return { skipped: 'no address' };
    if (rec.mailedAt && !opts.again && !opts.to) return { skipped: 'already sent' };
    if (busy.has(rec.order)) return { skipped: 'sending' };
    busy.add(rec.order);
    try {
      if (c.sports && !rec.sportsKey) await ensureSportsKey(rec, c.sports);
      const paidAt = rec.paidAt || (store.orders[rec.order] && store.orders[rec.order].at) || rec.at || 0;
      if (c.sports && !rec.sportsKey && !opts.to && !opts.again && Date.now() - paidAt < KEY_WAIT_MS) return { deferred: 'waiting for the key' };
      const msg = compose(rec, sid, c.site);
      const idem = 'nebula-order-' + rec.order + (opts.to ? '-test-' + Date.now() : opts.again ? '-again-' + Date.now() : '');
      try {
        const id = await deliver(msg, to, c.mail, idem);
        if (!opts.to) {
          rec.mailedAt = Date.now(); rec.mailId = id;
          delete rec.mailError; delete rec.mailTriedAt;
          persistStore();
        }
        console.log('support: order ' + rec.order + ' → receipt e-mailed to ' + mask(to) + (opts.to ? ' (test)' : ''));
        return { sent: id, to: mask(to) };
      } catch (e) {
        if (!opts.to) {
          rec.mailTries = (rec.mailTries || 0) + 1;
          rec.mailTriedAt = Date.now();
          rec.mailError = String(e.message || e).slice(0, 160);
          persistStore();
        }
        console.error('support: receipt for order ' + rec.order + ' failed — ' + String(e.message || e).slice(0, 160));
        return { failed: String(e.message || e).slice(0, 160) };
      }
    } finally { busy.delete(rec.order); }
  }

  /** The store key (the thank-you page's sid, or `order:<id>`) and record of one paid order. */
  function find(orderId) {
    for (const k of Object.keys(store.pending)) {
      const rec = store.pending[k];
      if (rec && rec.order === orderId && rec.state !== 'waiting') return { sid: k.startsWith('order:') ? null : k, rec };
    }
    return null;
  }
  /** What the admin list shows: every paid order, the address masked. */
  function list() {
    const out = [];
    for (const k of Object.keys(store.pending)) {
      const r = store.pending[k];
      if (!r || !r.order || r.state === 'waiting') continue;
      out.push({ order: r.order, tier: r.tier, at: r.paidAt || (store.orders[r.order] && store.orders[r.order].at) || r.at,
        to: mask(r.email), key: !!r.sportsKey, code: r.code ? (codeUsedBy(r.code) ? 'used' : 'open') : null,
        auto: !!r.mailWant, mailed: r.mailedAt || null, error: r.mailError || null, tries: r.mailTries || 0 });
    }
    return out.sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  /** New orders whose receipt has not gone: send the due ones, each try further apart (1, 2, 4… minutes). */
  function sweep() {
    if (!config().mail) return;
    const now = Date.now();
    for (const k of Object.keys(store.pending)) {
      const rec = store.pending[k];
      if (!rec || !rec.mailWant || rec.mailedAt || !rec.email || rec.state === 'waiting') continue;
      const tries = rec.mailTries || 0;
      if (tries >= MAX_TRIES || now - (rec.mailTriedAt || 0) < RETRY_MS * Math.pow(2, Math.max(0, tries - 1))) continue;
      send(rec, k.startsWith('order:') ? null : k).catch((e) => console.error('support mail sweep', e.message));
    }
  }
  if (SWEEP_MS > 0) setInterval(sweep, SWEEP_MS).unref();

  return { compose, send, find, list, sweep, mask };
};
