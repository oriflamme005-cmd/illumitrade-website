// IllumiTrade® — Stripe webhook
//   new sign-up            → (1) alert to you, (2) welcome email to the customer
//   trial becomes paid     → alert to you          (invoice.paid)
//   card declined          → alert to you + the invoice link to send   (invoice.payment_failed)
//   trial/plan cancelled   → alert to you + "remove TradingView access" (customer.subscription.deleted)
// Every alert ends with the trial scoreboard (started / paid / cancelled, by traffic source).
// Customers only ever receive the welcome email. Other products on the same Stripe account are ignored.
// ---------------------------------------------------------------------------------------------
// Stripe → Developers → Webhooks → endpoint  https://www.illumitrade.com/api/stripe-webhook
// Prepaid sale while a monthly free trial is open on the same email → that trial is closed automatically (no $80 charge).
// Events to send:  checkout.session.completed · invoice.paid · invoice.payment_failed · customer.subscription.deleted
//
// Vercel Environment Variables needed:
//   STRIPE_SECRET_KEY      sk_live_…   (already set for the on-site checkout)
//   STRIPE_WEBHOOK_SECRET  whsec_…     (shown by Stripe when you create the webhook)
//   GMAIL_USER             illumitrade.contact@gmail.com
//   GMAIL_APP_PASSWORD     16-letter Google "App password" (not your normal password)
// Optional:
//   ALERT_EMAIL            where the alert goes (default: GMAIL_USER)
//   WELCOME_EMAIL_OFF=1    pause the customer welcome email (alerts keep working)
// ---------------------------------------------------------------------------------------------

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const STRIPE_VERSION = '2026-08-26.dahlia';

const PLAN_BY_LINK = {
  'https://buy.stripe.com/bJe7sK0Jnd4t4uEfxK0Ba0b': 'monthly',
  'https://buy.stripe.com/5kQdR8dw9e8x8KU2KY0Ba01': 'm3',
  'https://buy.stripe.com/cNi28qeAd9She5e0CQ0Ba02': 'm6',
  'https://buy.stripe.com/8x214m63H5C1e5egBO0Ba03': 'y1',
  'https://buy.stripe.com/dRm4gyeAd7K95yIcly0Ba04': 'lifetime',
};
const PLAN_LABEL = {
  monthly: 'Monthly',
  m3: '3 months',
  m6: '6 months',
  y1: '1 year',
  lifetime: 'Lifetime',
};

const LINKS = {
  quick: 'https://www.illumitrade.com/guides/ILT-Guide-2026-Quick-Start.pdf',
  full: 'https://www.illumitrade.com/guides/ILT-Guide-2026-Full-Edition.pdf',
  telegram: 'https://t.me/+F0JSzA8w7rIzOTFk',
  portal: 'https://billing.stripe.com/p/login/cNidR877L6G56CM85i0Ba00',
  site: 'https://www.illumitrade.com',
  x: 'https://x.com/illumi_trade',
  chart: 'https://www.illumitrade.com/ilt-v1-first-signal.jpg',
};

// ---------- Stripe helpers ----------
async function stripe(path) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_VERSION },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe HTTP ' + r.status);
  return j;
}

async function stripePost(path, params) {
  const body = Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe HTTP ' + r.status);
  return j;
}

async function stripeDelete(path, params) {
  const body = Object.entries(params || {}).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
  const r = await fetch('https://api.stripe.com/v1' + path + (body ? '?' + body : ''), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_VERSION },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe HTTP ' + r.status);
  return j;
}

function readRaw(req) {
  // Raw bytes are needed for the signature. If the platform already buffered the body, use that.
  if (req.readableEnded) {
    const b = req.body;
    return Promise.resolve(Buffer.isBuffer(b) ? b : typeof b === 'string' ? Buffer.from(b) : Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks)), 8000);
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Stripe signature check (same algorithm as stripe.webhooks.constructEvent)
function verify(raw, header, secret, toleranceSec = 600) {
  if (!header || !secret) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    (parts[k] = parts[k] || []).push(v);
  }
  const t = parts.t && parts.t[0];
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + raw.toString('utf8')).digest('hex');
  return parts.v1.some((sig) => {
    const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ---------- data extraction ----------
function tradingViewUsername(s) {
  const meta = (s.metadata && s.metadata.tradingview_username) || '';
  if (meta) return String(meta).trim();
  for (const f of s.custom_fields || []) {
    const key = String(f.key || '').toLowerCase();
    const label = String((f.label && f.label.custom) || '').toLowerCase();
    if (/trading\s*view|tradingview|username/.test(key + ' ' + label)) {
      const v = (f.text && f.text.value) || (f.dropdown && f.dropdown.value) || (f.numeric && f.numeric.value) || '';
      if (v) return String(v).trim().replace(/^@/, '');
    }
  }
  return '';
}

// Blocking problems: the welcome email asks the customer for their username.
function usernameWarning(u) {
  if (!u) return 'MISSING: ask the customer for it';
  if (/@/.test(u)) return 'looks like an email, not a username: check it';
  if (/\s/.test(u)) return 'contains spaces: check it';
  return '';
}
// Unusual but often real (auto-generated Google/Apple usernames): alert only, welcome email unchanged.
function usernameNote(u) {
  if (u && /^[0-9a-f]{16,}$/i.test(u)) return 'unusual (auto-generated?): search it in Manage access before granting';
  return '';
}

function firstName(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2 || /^(na|n\/a|none|-+)$/i.test(n)) return '';
  const f = n.split(/\s+/)[0];
  if (f.length < 2) return '';
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}

function money(cents, cur) {
  if (cents == null) return '';
  const c = String(cur || 'usd').toUpperCase();
  const v = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return c === 'USD' ? '$' + v : v + ' ' + c;
}

function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function details(s) {
  let plan = (s.metadata && s.metadata.plan) || '';
  if (!plan && s.payment_link) {
    try { plan = PLAN_BY_LINK[(await stripe('/payment_links/' + s.payment_link)).url] || ''; } catch (e) {}
  }
  let product = '', unit = null, interval = '';
  try {
    const li = await stripe('/checkout/sessions/' + s.id + '/line_items?limit=5&expand[]=data.price.product');
    const it = li.data && li.data[0];
    if (it) {
      product = (it.price && it.price.product && it.price.product.name) || it.description || '';
      unit = it.price ? it.price.unit_amount : null;
      const r = it.price && it.price.recurring;
      interval = r ? (r.interval_count > 1 ? r.interval_count + ' ' + r.interval + 's' : r.interval) : 'one-time';
    }
  } catch (e) { console.error('[webhook] line_items', e.message); }

  let trialEnd = null;
  if (s.mode === 'subscription' && s.subscription) {
    try {
      const sub = await stripe('/subscriptions/' + s.subscription);
      if (sub.status === 'trialing' && sub.trial_end) trialEnd = sub.trial_end;
    } catch (e) { console.error('[webhook] subscription', e.message); }
  }
  return { plan, product, unit, interval, trialEnd };
}

// ---------- which subscriptions are IllumiTrade (the Stripe account is shared) ----------
let priceCache = null, priceCacheAt = 0;
async function illumiPrices() {
  if (priceCache && Date.now() - priceCacheAt < 30 * 60 * 1000) return priceCache;
  const map = {};
  for (const plan of Object.keys(PLAN_LABEL)) {
    const id = process.env['PRICE_' + plan.toUpperCase()];
    if (id) map[id] = plan;
  }
  let after = '';
  for (let page = 0; page < 10; page++) {
    const r = await stripe('/payment_links?limit=100' + (after ? '&starting_after=' + after : ''));
    for (const l of r.data || []) {
      const plan = PLAN_BY_LINK[l.url];
      if (!plan) continue;
      try {
        const li = await stripe('/payment_links/' + l.id + '/line_items?limit=5');
        const it = li.data && li.data[0];
        if (it && it.price) map[it.price.id] = plan;
      } catch (e) { console.error('[webhook] link items', e.message); }
    }
    if (!r.has_more || !(r.data || []).length) break;
    after = r.data[r.data.length - 1].id;
  }
  priceCache = map; priceCacheAt = Date.now();
  return map;
}

function subPriceId(sub) {
  const it = sub.items && sub.items.data && sub.items.data[0];
  return (it && it.price && it.price.id) || '';
}
function subPeriodStart(sub) {
  const it = sub.items && sub.items.data && sub.items.data[0];
  return sub.current_period_start || (it && it.current_period_start) || 0;
}
// → plan key ('monthly', …) when the subscription is IllumiTrade, '' otherwise
function illumiPlan(sub, prices) {
  const m = sub.metadata || {};
  if (/^ilt_oracle/i.test(m.product || '')) return '';
  if (m.source === 'site_checkout') return PLAN_LABEL[m.plan] ? m.plan : 'monthly';
  return prices[subPriceId(sub)] || '';
}

// ---------- a customer on a monthly free trial buys a prepaid plan → close the trial, so the $80 is never charged ----------
// Looks up every Stripe customer with the same email (the prepaid checkout often creates a new customer).
// Trials are cancelled immediately (no charge); a monthly plan that is already PAID is never touched, only reported.
// Returns one line for your alert email, or '' when there was nothing to do.
async function closeOpenTrials(email, newPlan) {
  if (!email) return '';
  const prices = await illumiPrices();
  const custs = await stripe('/customers?limit=20&email=' + encodeURIComponent(email));
  const closed = [], paid = [];
  for (const c of custs.data || []) {
    for (const status of ['trialing', 'active', 'past_due']) {
      const subs = await stripe('/subscriptions?limit=20&status=' + status + '&customer=' + c.id);
      for (const sub of subs.data || []) {
        if (illumiPlan(sub, prices) !== 'monthly') continue;
        if (status === 'trialing') {
          // tag first, so the "subscription deleted" alert knows it is NOT a lost customer
          await stripePost('/subscriptions/' + sub.id, { 'metadata[replaced_by]': newPlan });
          await stripeDelete('/subscriptions/' + sub.id, { 'cancellation_details[comment]': 'Auto: replaced by prepaid plan ' + newPlan + ' (no charge)' });
          closed.push(sub.id);
        } else if (!sub.cancel_at_period_end && !sub.cancel_at) {
          paid.push(sub.id);
        }
      }
    }
  }
  const out = [];
  if (closed.length) out.push(`closed automatically (${closed.join(', ')}), so the $80 will never be charged. Nothing to do.`);
  if (paid.length) out.push(`⚠ this customer ALSO has a PAID monthly subscription still renewing (${paid.join(', ')}). Cancel it in Stripe if they are switching.`);
  return out.join(' ');
}

function invoiceSubId(inv) {
  const p = inv.parent && inv.parent.subscription_details;
  const v = inv.subscription || (p && p.subscription) || '';
  return typeof v === 'object' && v ? v.id || '' : String(v || '');
}

// What happened to a trial: 'trial' | 'cancelling' | 'paid' | 'failed' | 'cancelled' | '' (never had a trial)
function trialOutcome(sub) {
  if (!sub.trial_end) return '';
  switch (sub.status) {
    case 'trialing': return sub.cancel_at_period_end || sub.cancel_at ? 'cancelling' : 'trial';
    case 'active': return 'paid';
    case 'past_due': case 'unpaid': case 'incomplete': return 'failed';
    case 'canceled':
      // Stripe gave up after declined cards → never paid, even if it ended days after the trial
      if (/payment_failed|payment_disputed/.test((sub.cancellation_details && sub.cancellation_details.reason) || '')) return 'failed';
      return (sub.ended_at || sub.canceled_at || 0) > sub.trial_end + 86400 ? 'paid' : 'cancelled';
    default: return 'cancelled';
  }
}

function sourceLabel(meta) {
  const m = meta || {};
  if (m.utm_source) return m.utm_source + (m.utm_campaign ? ' · ' + m.utm_campaign : '');
  return m.source === 'site_checkout' ? 'not recorded' : 'Stripe payment link';
}
function sourceDetail(meta) {
  const m = meta || {};
  if (!m.utm_source) return sourceLabel(m);
  const bits = [m.utm_source];
  if (m.utm_medium) bits.push(m.utm_medium);
  if (m.utm_campaign) bits.push('campaign ' + m.utm_campaign);
  if (m.utm_content) bits.push('ad ' + m.utm_content);
  if (m.landing) bits.push('landed on ' + m.landing);
  if (m.first_source && m.first_source !== m.utm_source) bits.push('first visit via ' + m.first_source);
  if (m.first_visit) bits.push('first seen ' + m.first_visit);
  if (m.attr_via === 'email_match') bits.push('matched by email to an earlier ad visit' + (m.last_source ? ' (signed up from: ' + m.last_source + ')' : ''));
  if (m.attr_via === 'payment_link') bits.push('paid on the Stripe payment link');
  return bits.join(' · ');
}

// ---------- where the customer came from, even when the cookie could not follow them ----------
// (1) Stripe Payment Links: /ilt-track.js appends ?client_reference_id=ilt1__s-X__m-paid__c-… to the link.
const REF_KEYS = { s: 'utm_source', m: 'utm_medium', c: 'utm_campaign', n: 'utm_content', p: 'landing', f: 'first_source', d: 'first_visit', b: 'promo' };
function parseRef(ref) {
  const out = {};
  const parts = String(ref || '').split('__');
  if (parts.shift() !== 'ilt1') return out;
  for (const part of parts) {
    const i = part.indexOf('-');
    const key = REF_KEYS[part.slice(0, i)], v = part.slice(i + 1, i + 61);
    if (i < 1 || !key || !v) continue;
    out[key] = key === 'landing' ? (v === 'home' ? '/' : '/' + v) : v;
  }
  return out;
}
const ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'landing', 'first_source', 'first_visit'];
// An ad = a paid medium, or any campaign link that is not one of our own organic tags (bio link, posts, e-mails, site cross-links…)
const ORGANIC_MEDIUM = /^(social|organic|profile|script|email|site|referral|direct)$/i;
const isAd = (m) => !!m && (/^(paid|cpc|ppc)/i.test(m.utm_medium || '') || (!!m.utm_campaign && !ORGANIC_MEDIUM.test(m.utm_medium || '')));
function sessionAttribution(cs) {
  const m = cs.metadata || {};
  return m.utm_source ? m : parseRef(cs.client_reference_id);
}
// (2) Same email seen earlier from an ad (typical: ad opened inside the X app, sign-up finished later in the
// phone's own browser, where the cookie does not exist) → credit the ad, keep what the last visit looked like.
const MATCH_DAYS = 30;
function mergeAttribution(current, earlier) {
  const cur = current || {};
  if (isAd(cur)) return { meta: cur, changed: false };
  const hit = (earlier || []).find(isAd);
  if (!hit) return { meta: cur, changed: false };
  const meta = { ...cur };
  for (const k of ATTR_KEYS) { if (hit[k]) meta[k] = hit[k]; else delete meta[k]; }
  meta.attr_via = 'email_match';
  if (cur.utm_source) meta.last_source = cur.utm_source;
  return { meta, changed: true };
}
// Returns the session metadata completed with its source, and saves it on the subscription / payment
// so the scoreboard and Stripe itself show it. Never throws: a sign-up alert must always go out.
async function attribute(s, email) {
  let meta = { ...(s.metadata || {}) }, changed = false;
  try {
    if (!meta.utm_source) {
      const fromRef = parseRef(s.client_reference_id);
      if (fromRef.utm_source) { meta = { ...meta, ...fromRef, attr_via: 'payment_link' }; changed = true; }
    }
    if (!isAd(meta) && email) {
      const since = Math.floor(Date.now() / 1000) - MATCH_DAYS * 86400;
      const r = await stripe('/checkout/sessions?limit=30&created%5Bgte%5D=' + since +
        '&customer_details%5Bemail%5D=' + encodeURIComponent(email));
      const earlier = (r.data || []).filter((cs) => cs.id !== s.id).map(sessionAttribution);
      const m = mergeAttribution(meta, earlier);
      if (m.changed) { meta = m.meta; changed = true; }
    }
    if (changed) {
      const params = {};
      for (const k of [...ATTR_KEYS, 'attr_via', 'last_source']) if (meta[k]) params['metadata[' + k + ']'] = meta[k];
      if (s.subscription) await stripePost('/subscriptions/' + s.subscription, params);
      else if (s.payment_intent) await stripePost('/payment_intents/' + s.payment_intent, params);
    }
  } catch (e) { console.error('[webhook] attribution', e.message); }
  return meta;
}

// Trial scoreboard, read live from Stripe: every monthly trial started in the last 45 days.
const BOARD_DAYS = 45;
function scoreboardText(subs, prices) {
  const blank = () => ({ started: 0, paid: 0, cancelled: 0, failed: 0, trial: 0, cancelling: 0 });
  const total = blank(), by = {};
  for (const sub of subs) {
    if (!illumiPlan(sub, prices)) continue;
    const o = trialOutcome(sub);
    if (!o) continue;
    const key = sourceLabel(sub.metadata);
    const row = by[key] || (by[key] = blank());
    for (const r of [total, row]) { r.started++; r[o]++; }
  }
  if (!total.started) return '';
  const line = (r) => {
    const open = r.trial + r.cancelling;
    return `started ${r.started} · paid ${r.paid} · cancelled ${r.cancelled}` +
      (r.failed ? ` · card declined ${r.failed}` : '') +
      (open ? ` · still in trial ${open}` + (r.cancelling ? ` (${r.cancelling} set to cancel)` : '') : '');
  };
  const decided = total.paid + total.cancelled + total.failed;
  const out = [
    `TRIAL SCOREBOARD · last ${BOARD_DAYS} days`,
    line(total),
    decided ? `Trial → paid: ${total.paid} of ${decided} finished trials (${Math.round((100 * total.paid) / decided)}%)` : 'Trial → paid: no trial has finished yet',
  ];
  const keys = Object.keys(by).sort((a, b) => by[b].started - by[a].started);
  if (keys.length > 1 || (keys[0] && keys[0] !== 'not recorded')) {
    out.push('', 'By source:');
    for (const k of keys) out.push(`  ${k}: ${line(by[k])}`);
  }
  return out.join('\n');
}

async function scoreboard() {
  const work = (async () => {
    const prices = await illumiPrices();
    const since = Math.floor(Date.now() / 1000) - BOARD_DAYS * 86400;
    const subs = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const r = await stripe('/subscriptions?status=all&limit=100&created%5Bgte%5D=' + since + (after ? '&starting_after=' + after : ''));
      subs.push(...(r.data || []));
      if (!r.has_more || !(r.data || []).length) break;
      after = r.data[r.data.length - 1].id;
    }
    return scoreboardText(subs, prices);
  })().catch((e) => { console.error('[webhook] scoreboard', e.message); return ''; });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(''), 5000));
  return Promise.race([work, timeout]);
}

// TradingView username + email for a subscription (metadata first, then its checkout session)
async function subContact(sub, fallbackEmail) {
  let username = String((sub.metadata && sub.metadata.tradingview_username) || '').trim();
  let email = fallbackEmail || '';
  if (!username || !email) {
    try {
      const r = await stripe('/checkout/sessions?limit=1&subscription=' + sub.id);
      const cs = r.data && r.data[0];
      if (cs) {
        username = username || tradingViewUsername(cs);
        email = email || (cs.customer_details && cs.customer_details.email) || cs.customer_email || '';
      }
    } catch (e) { console.error('[webhook] contact', e.message); }
  }
  return { username, email };
}

function lifecycleEmail({ type, sub, inv, plan, username, email, board }) {
  const who = username || email || '?';
  const dash = `https://dashboard.stripe.com/${sub.livemode === false ? 'test/' : ''}subscriptions/${sub.id}`;
  const head = [
    `TradingView username:  ${username || '(not found: see Stripe)'}`,
    `Email:                 ${email || '?'}`,
    `Plan:                  ${PLAN_LABEL[plan] || plan}`,
    `Came from:             ${sourceDetail(sub.metadata)}`,
  ];
  let subject, top, action = [];
  if (type === 'paid') {
    subject = `💰 Trial converted: ${who} paid ${money(inv.amount_paid, inv.currency)}`;
    top = `A free trial just became a paying customer: ${money(inv.amount_paid, inv.currency)} charged.`;
    action = ['→ Nothing to do: access stays on.'];
  } else if (type === 'failed') {
    const afterTrial = sub.trial_end && subPeriodStart(sub) <= sub.trial_end + 86400;
    subject = `⚠ Card declined: ${who} · ${money(inv.amount_due, inv.currency)}${afterTrial ? ' (first payment after trial)' : ''}`;
    top = `Stripe could not charge ${money(inv.amount_due, inv.currency)}${afterTrial ? ' at the end of the free trial' : ' for the renewal'} (attempt ${inv.attempt_count || 1}).`;
    action = [
      inv.next_payment_attempt ? `Stripe retries automatically on ${fmtDate(inv.next_payment_attempt)}.` : 'Stripe will not retry automatically.',
      inv.hosted_invoice_url ? `→ Invoice link to send the customer so they can pay or validate with their bank:\n${inv.hosted_invoice_url}` : '',
    ].filter(Boolean);
  } else {
    const o = trialOutcome(sub);
    const cd = sub.cancellation_details || {};
    const why = [cd.feedback, cd.comment].filter(Boolean).join(' · ');
    if (o === 'cancelled') {
      subject = `✖ Trial cancelled: ${who} (never paid)`;
      top = 'This free trial ended without a payment.';
    } else if (o === 'failed') {
      subject = `✖ Trial ended, card never went through: ${who}`;
      top = 'Stripe stopped retrying the card and closed this subscription. No payment was received.';
    } else {
      const from = sub.trial_end || sub.start_date || sub.created || 0;
      const months = from ? Math.max(1, Math.round(((sub.ended_at || Date.now() / 1000) - from) / (30 * 86400))) : 0;
      subject = `✖ Subscription ended: ${who}${months ? ` (after ~${months} month${months > 1 ? 's' : ''})` : ''}`;
      top = 'This paying subscription has ended.';
    }
    if (why) head.push(`Reason given:          ${why}`);
    action = [`→ Remove access on TradingView: Manage access → "${username || '?'}"`];
  }
  const lines = [top, '', ...head, '', ...action, '', `Stripe: ${dash}`];
  if (board) lines.push('', '— — —', board);
  return { subject, text: lines.join('\n') };
}

// ---------- Black Friday 2026: the 1-year plan is 15 months for the price of 12 ----------
const BF_PROMO = 'bf2026', BF_MONTHS = 15;
function addMonthsUTC(date, n) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(date.getUTCDate(), last));
  return d;
}
function fmtFull(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// → the end date (Date) of the 15-month access when this sale is a Black Friday 1-year plan, otherwise null.
// The flag comes from the on-site checkout (metadata.promo) or from the Payment Link fallback (client_reference_id …__b-bf2026).
function bfEnd(s, plan) {
  const promo = (s.metadata && s.metadata.promo) || parseRef(s.client_reference_id).promo || '';
  if (promo !== BF_PROMO || plan !== 'y1') return null;
  return addMonthsUTC(new Date(((s && s.created) || Date.now() / 1000) * 1000), BF_MONTHS);
}

// ---------- emails ----------
function welcomeEmail({ first, trialEnd, planLabel, username, bfUntil }) {
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const status = trialEnd
    ? `Welcome to IllumiTrade. Your free week is active: $0 today, and you can cancel in 1 click any time before ${fmtDate(trialEnd)}.`
    : bfUntil
      ? `Welcome to IllumiTrade. Your payment is confirmed and your 1 year plan is active. As a Black Friday bonus you get 3 extra months: your access runs for 15 months, until ${bfUntil}. Thank you for your trust.`
      : `Welcome to IllumiTrade. Your payment is confirmed${planLabel ? ` and your ${planLabel} plan is active` : ''}. Thank you for your trust.`;
  const access = username
    ? `Your access is being activated now on the TradingView account "${username}". You'll get a TradingView notification within a few hours. As soon as it arrives, take these 5 minutes:`
    : `To switch on your indicators, I just need your TradingView username. Reply to this email with it (you'll find it by clicking your profile picture in the top-right corner of TradingView) and I'll grant access within a few hours. As soon as it's on, take these 5 minutes:`;

  // ---- "First setup in 5 minutes" quickstart (same rules as the Quick Start Guide, pages 4-8) ----
  const step1Title = 'STEP 1 · Add the 3 indicators (2 min)';
  const step1 = [
    'Open any chart → Indicators (fx) → Invite-only scripts tab → add:',
    'ILT® V1 2026 · ILT® 2.0 2026 · ILT® Add-on 2026',
    'Then toolbar → Save indicator template (name it "ILT"): all 3 load in one click on any chart.',
  ];
  const step2Title = 'STEP 2 · Learn the one setup to watch, on ILT® V1 (2 min)';
  const rules = [
    ['GCL sloping down', 'sideways market. No trade, just wait.'],
    ['Aqua Diamonds on a low GCL', 'a move is loading. Get ready, don\'t act yet.'],
    ['Trigger', 'the GCL turns up and crosses above the Cross Line (the dots).'],
    ['Direction', 'Colored Line Aqua → long. Fuchsia → short.'],
    ['Exit', 'the Colored Line flips colour, or Fuchsia Diamonds appear (exhaustion).'],
  ];
  const step3Title = 'STEP 3 · Find a market where a setup is loading (1 min)';
  const step3 = 'Open your favourite chart and look at the V1 dashboard on the right: one column per timeframe. A setup loading on several timeframes at once is the strongest one. Trade in the direction of the higher-timeframe trend.';
  const step3Patience = 'Important: a clean setup does not appear every day. On a single market, a clean multi-timeframe setup can take several weeks to form, and that is exactly what makes it worth waiting for. If your market shows nothing clean today, don\'t force a trade: check other tickers (BTC, ETH, gold, silver, oil, indices, major stocks…) until you find one where the setup is loading.';
  const phoneTip = 'On your phone? If the dashboard covers your chart: open the indicator\'s Settings → Dashboard Settings → Layout → Vertical (1 column), then Text size → Tiny, and save your chart layout. The Quick Start Guide shows it step by step, right after the setup page.';
  const guideLine = 'When you have 15 more minutes: the Quick Start Guide walks you through a full trade, step by step. 79%+ of members who took the time to understand these conditions stayed with ILT®.';

  const text = [
    hi, '', status, '', access, '',
    step1Title, ...step1, '',
    step2Title, ...rules.map(([k, v]) => '• ' + k + ': ' + v),
    'What it looks like on a real chart: ' + LINKS.chart, '',
    step3Title, step3, '',
    step3Patience, '',
    phoneTip, '',
    guideLine, '',
    'Quick Start Guide:', LINKS.quick, '',
    'Full Edition Guide:', LINKS.full, '',
    'Private Telegram community:', LINKS.telegram, '',
    'Manage your subscription:', LINKS.portal, '',
    'If anything is unclear, just reply here. I read every message personally.', '',
    'Best regards,', '', 'ILT 💎', 'www.illumitrade.com', LINKS.x,
  ].join('\n');

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const a = (u) => `<a href="${u}">${u}</a>`;
  const block = (label, u) => `<p style="margin:0 0 14px"><b>${label}</b><br>${a(u)}</p>`;
  const h = (t) => `<p style="margin:22px 0 8px;font-weight:bold;color:#0b7f75">${esc(t)}</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:600px">
<p>${esc(hi)}</p>
<p>${esc(status)}</p>
<p>${esc(access)}</p>
${h(step1Title)}
<p style="margin:0 0 6px">${esc(step1[0])}</p>
<p style="margin:0 0 6px"><b>${esc(step1[1])}</b></p>
<p style="margin:0">${esc(step1[2])}</p>
${h(step2Title)}
<ul style="margin:0 0 12px;padding-left:20px">
${rules.map(([k, v]) => `<li style="margin:0 0 6px"><b>${esc(k)}:</b> ${esc(v)}</li>`).join('\n')}
</ul>
<p style="margin:0 0 6px"><a href="${LINKS.quick}"><img src="${LINKS.chart}" width="560" alt="ILT V1 on a real chart: GCL, Colored Line, Cross Line, Aqua Diamonds (setup loading), Fuchsia Diamonds (exhaustion)" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:6px"></a></p>
<p style="margin:0 0 4px;font-size:13px;color:#666">ILT® V1 on a real chart: Aqua Diamonds = setup loading · Fuchsia Diamonds = exhaustion.</p>
${h(step3Title)}
<p style="margin:0 0 10px">${esc(step3)}</p>
<p style="margin:0;padding:10px 12px;background:#eef8f7;border-left:3px solid #0b7f75">${esc(step3Patience)}</p>
<p style="margin:14px 0 0;padding:10px 12px;background:#eef8f7;border-left:3px solid #0b7f75">${esc(phoneTip)}</p>
<p style="margin:22px 0 14px">${esc(guideLine)}</p>
${block('Quick Start Guide:', LINKS.quick)}
${block('Full Edition Guide:', LINKS.full)}
${block('Private Telegram community:', LINKS.telegram)}
${block('Manage your subscription:', LINKS.portal)}
<p>If anything is unclear, just reply here. I read every message personally.</p>
<p>Best regards,</p>
<p>ILT 💎<br><a href="${LINKS.site}">www.illumitrade.com</a><br><a href="${LINKS.x}">${LINKS.x}</a></p>
</div>`;

  const subject = first ? `Your ILT® Trader Kit is ready, ${first}: first setup in 5 minutes` : 'Your ILT® Trader Kit is ready: first setup in 5 minutes';
  return { subject, text, html };
}

function alertEmail({ s, email, name, username, warn, d, planLabel, welcome, board, bfUntil, trialNote }) {
  const kind = d.trialEnd ? `FREE TRIAL (ends ${fmtDate(d.trialEnd)})` : `PAID ${money(s.amount_total, s.currency)}`;
  const price = d.unit != null ? money(d.unit, s.currency) + (d.interval ? ' / ' + d.interval : '') : '';
  const lines = [
    `New IllumiTrade sign-up: ${kind}`, '',
    `TradingView username:  ${username || '(none)'}${warn ? '   ⚠ ' + warn : (usernameNote(username) ? '   ℹ ' + usernameNote(username) : '')}`,
    `Plan:                  ${planLabel || d.product || '?'}${price ? '  (' + price + ')' : ''}`,
    ...(bfUntil ? [`🎁 BLACK FRIDAY:       15 MONTHS (12 paid + 3 free) → set the TradingView expiration to ${bfUntil}`] : []),
    `Email:                 ${email || '?'}`,
    `Name:                  ${name || '(not provided)'}`,
    `Country:               ${(s.customer_details && s.customer_details.address && s.customer_details.address.country) || '?'}`,
    `Source:                ${s.metadata && s.metadata.source === 'site_checkout' ? 'checkout on illumitrade.com' : 'Stripe payment link'}`,
    `Came from:             ${sourceDetail(s.metadata)}`, '',
    `Welcome email:         ${welcome}`, '',
    ...(trialNote ? [`Open monthly trial:    ${trialNote}`, ''] : []),
    `→ Grant access on TradingView: Manage access → add "${username || '?'}"${bfUntil ? ' · expires ' + bfUntil : ''}`, '',
    `Stripe: https://dashboard.stripe.com/${s.livemode ? '' : 'test/'}customers/${s.customer || ''}`,
  ];
  if (board) lines.push('', '— — —', board);
  const subject = `💎 New ${d.trialEnd ? 'trial' : 'sale'}: ${username || email || '?'} · ${planLabel || d.product || ''}${bfUntil ? ' 🎁 15 MONTHS' : ''}${/closed automatically/.test(trialNote || '') ? ' (trial closed)' : ''}${/ALSO has a PAID|could not check/.test(trialNote || '') ? ' ⚠ check monthly' : ''}${warn ? ' ⚠' : ''}`;
  return { subject, text: lines.join('\n') };
}

let transporter = null;
function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') },
    });
  }
  return transporter;
}

// ---------- Google Analytics 4: the money events the browser never sees (Measurement Protocol) ----------
// The browser reports visits, clicks, the free trial and prepaid purchases (see /ilt-track.js). Only the server knows
// when a trial really becomes a payment, when a renewal is paid and when someone cancels, so it reports those,
// tagged with the same source the customer arrived from (stored in the Stripe metadata at sign-up).
// Needs GA4_MEASUREMENT_ID + GA4_API_SECRET in Vercel; without them this does nothing.
// GA4_DEBUG=1 → events go to Google's validator and its verdict is written to the Vercel logs.
function ga4Params(meta) {
  const m = meta || {}, out = {};
  const map = { ilt_source: 'utm_source', ilt_medium: 'utm_medium', ilt_campaign: 'utm_campaign', ilt_content: 'utm_content', ilt_first_source: 'first_source', ilt_landing: 'landing' };
  for (const k of Object.keys(map)) if (m[map[k]]) out[k] = String(m[map[k]]).slice(0, 100);
  return out;
}
async function ga4(name, params, meta, fallbackId) {
  const id = process.env.GA4_MEASUREMENT_ID, secret = process.env.GA4_API_SECRET;
  if (!id || !secret) return 'off';
  try {
    const m = meta || {};
    const cid = m.ga_cid || ('stripe.' + String(fallbackId || 'unknown').replace(/[^\w]/g, '').slice(0, 50));
    const body = { client_id: cid, events: [{ name, params: { engagement_time_msec: 1, ...ga4Params(m), ...params } }] };
    const debug = process.env.GA4_DEBUG === '1';
    const url = (debug ? 'https://www.google-analytics.com/debug/mp/collect' : 'https://www.google-analytics.com/mp/collect') +
      '?measurement_id=' + encodeURIComponent(id) + '&api_secret=' + encodeURIComponent(secret);
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (debug) console.log('[webhook] ga4 debug', name, r.status, await r.text());
    return r.ok ? 'sent' : 'http ' + r.status;
  } catch (e) { console.error('[webhook] ga4', e.message); return 'error'; }   // never blocks the alert email
}
function ga4Lifecycle(type, sub, inv, plan) {
  const trialPaid = !!(sub.trial_end && subPeriodStart(sub) <= sub.trial_end + 86400);
  if (type === 'paid') {
    if (inv.billing_reason === 'subscription_create') return null;   // first invoice of a non-trial plan: the browser already reported that purchase
    const value = (inv.amount_paid || 0) / 100;
    return { name: 'purchase', params: { transaction_id: inv.id, value, currency: String(inv.currency || 'usd').toUpperCase(), ilt_plan: plan,
      ilt_kind: trialPaid ? 'after_trial' : 'renewal', items: [{ item_id: plan, item_name: plan, price: value, quantity: 1 }] } };
  }
  if (type === 'failed') return { name: 'payment_failed', params: { ilt_plan: plan, value: (inv.amount_due || 0) / 100, currency: String(inv.currency || 'usd').toUpperCase() } };
  return { name: trialOutcome(sub) === 'cancelled' ? 'trial_cancelled' : 'subscription_cancelled', params: { ilt_plan: plan } };
}

// ---------- after the sign-up: paid / card declined / cancelled (alerts to you only) ----------
const LIFECYCLE = { 'invoice.paid': 'paid', 'invoice.payment_failed': 'failed', 'customer.subscription.deleted': 'ended' };

async function lifecycle(event, res) {
  const type = LIFECYCLE[event.type];
  const o = event.data.object;
  const skip = (why) => res.status(200).json({ ignored: event.type, why });
  let sub, inv = null, plan = '';
  try {
    if (type === 'ended') sub = o;
    else {
      inv = o;
      const id = invoiceSubId(inv);
      if (!id) return skip('not a subscription invoice');
      if (type === 'paid' && !(inv.amount_paid > 0)) return skip('$0 invoice');
      sub = await stripe('/subscriptions/' + id);
    }
    plan = illumiPlan(sub, await illumiPrices());
  } catch (e) {
    console.error('[webhook] lifecycle', e.message);
    return res.status(500).send('Stripe lookup failed'); // let Stripe retry
  }
  if (!plan) return skip('not an IllumiTrade subscription');
  if (type === 'ended' && sub.metadata && sub.metadata.replaced_by) return skip('trial replaced by a prepaid plan (customer kept)');
  try {   // Google Analytics 4 (before the renewal skip below: renewals are revenue too)
    const g = ga4Lifecycle(type, sub, inv, plan);
    if (g) await ga4(g.name, g.params, sub.metadata, sub.customer || (inv && inv.customer));
  } catch (e) { console.error('[webhook] ga4 lifecycle', e.message); }
  // Only the first payment after a free trial is news; monthly renewals stay silent.
  if (type === 'paid' && !(sub.trial_end && subPeriodStart(sub) <= sub.trial_end + 86400)) return skip('renewal');

  const [{ username, email }, board] = await Promise.all([subContact(sub, inv && inv.customer_email), scoreboard()]);
  const m = lifecycleEmail({ type, sub, inv, plan, username, email, board });
  try {
    await mailer().sendMail({
      from: `"ILT 💎 IllumiTrade" <${process.env.GMAIL_USER}>`,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      replyTo: email || undefined, subject: m.subject, text: m.text,
    });
  } catch (e) {
    console.error('[webhook] lifecycle alert', e.message);
    return res.status(500).send('Email failed'); // let Stripe retry
  }
  return res.status(200).json({ ok: true, alert: type });
}

// ---------- handler ----------
async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).send('Method not allowed'); }
  const raw = req.rawBody ? Buffer.from(req.rawBody) : await readRaw(req);
  if (!verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('Bad signature');
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('Bad JSON'); }
  if (LIFECYCLE[event.type]) return lifecycle(event, res);
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ ignored: event.type });

  const s = event.data.object;
  const isIllumi = (s.metadata && s.metadata.source === 'site_checkout') || !!s.payment_link;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
  const name = (s.customer_details && s.customer_details.name) || '';
  const username = tradingViewUsername(s);
  const warn = usernameWarning(username);
  if (isIllumi) s.metadata = await attribute(s, email);   // before the alert + scoreboard, so both show the source

  let d = { plan: '', product: '', unit: null, interval: '', trialEnd: null };
  try { d = await details(s); } catch (e) { console.error('[webhook] details', e.message); }
  const planLabel = PLAN_LABEL[d.plan] || '';
  const bfDate = isIllumi ? bfEnd(s, d.plan) : null;
  const bfUntil = bfDate ? fmtFull(bfDate) : '';
  const from = `"ILT 💎 IllumiTrade" <${process.env.GMAIL_USER}>`;

  // 1) welcome email to the customer
  let welcome = 'not sent';
  // Only the 5 IllumiTrade plans (site checkout or their Payment Links) get the welcome email.
  // Anything else (other products, installment links, payment-method updates…) → alert only.
  const known = isIllumi && !!PLAN_LABEL[d.plan];
  if (process.env.WELCOME_EMAIL_OFF === '1') welcome = 'paused (WELCOME_EMAIL_OFF=1)';
  else if (!email) welcome = 'not sent: no customer email';
  else if (!known) welcome = 'not sent: not one of the 5 IllumiTrade plans (alert only)';
  else {
    try {
      const w = welcomeEmail({ first: firstName(name), trialEnd: d.trialEnd, planLabel, username: warn ? '' : username, bfUntil });
      await mailer().sendMail({ from, to: email, replyTo: process.env.GMAIL_USER, subject: w.subject, text: w.text, html: w.html });
      welcome = warn ? 'sent (asks the customer for the username)' : 'sent';
    } catch (e) {
      console.error('[webhook] welcome', e.message);
      welcome = 'FAILED: ' + e.message + ' (send it manually)';
    }
  }

  // 2) a prepaid plan replaces any monthly free trial still open on the same email
  let trialNote = '';
  if (known && d.plan !== 'monthly' && email) {
    try { trialNote = await closeOpenTrials(email, d.plan); }
    catch (e) {
      console.error('[webhook] closeOpenTrials', e.message);
      trialNote = '⚠ could not check for an open monthly trial (' + e.message + '). Check this email in Stripe → Subscriptions and cancel any trial by hand.';
    }
  }

  // 3) alert to you
  try {
    const board = known ? await scoreboard() : '';
    const a = alertEmail({ s, email, name, username, warn, d, planLabel, welcome, board, bfUntil, trialNote });
    await mailer().sendMail({ from, to: process.env.ALERT_EMAIL || process.env.GMAIL_USER, replyTo: email || undefined, subject: a.subject, text: a.text });
  } catch (e) {
    console.error('[webhook] alert', e.message);
    if (!/^sent/.test(welcome)) return res.status(500).send('Email failed'); // let Stripe retry
  }
  return res.status(200).json({ ok: true, welcome });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
// exported for tests
module.exports._t = { parseRef, mergeAttribution, sessionAttribution, verify, tradingViewUsername, usernameWarning, usernameNote, firstName, welcomeEmail, alertEmail, illumiPlan, trialOutcome, scoreboardText, sourceDetail, lifecycleEmail, invoiceSubId, closeOpenTrials, ga4, ga4Params, ga4Lifecycle };
