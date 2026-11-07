// IllumiTrade® — Stripe webhook: new sign-up → (1) alert to you, (2) welcome email to the customer
// ---------------------------------------------------------------------------------------------
// Stripe → Developers → Webhooks → endpoint  https://www.illumitrade.com/api/stripe-webhook
// Event to send:  checkout.session.completed
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

function usernameWarning(u) {
  if (!u) return 'MISSING: ask the customer for it';
  if (/^[0-9a-f]{20,}$/i.test(u)) return 'looks like a random code, not a username: check it';
  if (/@/.test(u)) return 'looks like an email, not a username: check it';
  if (/\s/.test(u)) return 'contains spaces: check it';
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

// ---------- emails ----------
function welcomeEmail({ first, trialEnd, planLabel, username }) {
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const status = trialEnd
    ? `Welcome to IllumiTrade. Your free week is active: $0 today, and you can cancel in 1 click any time before ${fmtDate(trialEnd)}.`
    : `Welcome to IllumiTrade. Your payment is confirmed${planLabel ? ` and your ${planLabel} plan is active` : ''}. Thank you for your trust.`;
  const access = username
    ? `Your access is being activated now on the TradingView account "${username}". You'll get a TradingView notification within a few hours. Then open any chart → click Indicators → Invite-only scripts tab → select the ILT® indicators. Tip: click the ☆ next to each one to add it to your favorites, so it's one click away next time.`
    : `To switch on your indicators, I just need your TradingView username. Reply to this email with it (you'll find it by clicking your profile picture in the top-right corner of TradingView) and I'll grant access within a few hours.`;

  const text = [
    hi, '', status, '', access, '',
    'Everything you need to get started:', '',
    'Quick Start Guide (5 min read):', LINKS.quick, '',
    'Full Edition Guide:', LINKS.full, '',
    'Private Telegram community:', LINKS.telegram, '',
    'Manage your subscription:', LINKS.portal, '',
    'If anything is unclear, just reply here. I read every message personally.', '',
    'Best regards,', '', 'ILT 💎', 'www.illumitrade.com', LINKS.x,
  ].join('\n');

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const a = (u) => `<a href="${u}">${u}</a>`;
  const block = (label, u) => `<p style="margin:0 0 14px"><b>${label}</b><br>${a(u)}</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">
<p>${esc(hi)}</p>
<p>${esc(status)}</p>
<p>${esc(access)}</p>
<p>Everything you need to get started:</p>
${block('Quick Start Guide (5 min read):', LINKS.quick)}
${block('Full Edition Guide:', LINKS.full)}
${block('Private Telegram community:', LINKS.telegram)}
${block('Manage your subscription:', LINKS.portal)}
<p>If anything is unclear, just reply here. I read every message personally.</p>
<p>Best regards,</p>
<p>ILT 💎<br><a href="${LINKS.site}">www.illumitrade.com</a><br><a href="${LINKS.x}">${LINKS.x}</a></p>
</div>`;

  const subject = first ? `Your ILT® Trader Kit is ready, ${first}` : 'Your ILT® Trader Kit is ready';
  return { subject, text, html };
}

function alertEmail({ s, email, name, username, warn, d, planLabel, welcome }) {
  const kind = d.trialEnd ? `FREE TRIAL (ends ${fmtDate(d.trialEnd)})` : `PAID ${money(s.amount_total, s.currency)}`;
  const price = d.unit != null ? money(d.unit, s.currency) + (d.interval ? ' / ' + d.interval : '') : '';
  const lines = [
    `New IllumiTrade sign-up: ${kind}`, '',
    `TradingView username:  ${username || '(none)'}${warn ? '   ⚠ ' + warn : ''}`,
    `Plan:                  ${planLabel || d.product || '?'}${price ? '  (' + price + ')' : ''}`,
    `Email:                 ${email || '?'}`,
    `Name:                  ${name || '(not provided)'}`,
    `Country:               ${(s.customer_details && s.customer_details.address && s.customer_details.address.country) || '?'}`,
    `Source:                ${s.metadata && s.metadata.source === 'site_checkout' ? 'checkout on illumitrade.com' : 'Stripe payment link'}`, '',
    `Welcome email:         ${welcome}`, '',
    `→ Grant access on TradingView: Manage access → add "${username || '?'}"`, '',
    `Stripe: https://dashboard.stripe.com/${s.livemode ? '' : 'test/'}customers/${s.customer || ''}`,
  ];
  const subject = `💎 New ${d.trialEnd ? 'trial' : 'sale'}: ${username || email || '?'} · ${planLabel || d.product || ''}${warn ? ' ⚠' : ''}`;
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

// ---------- handler ----------
async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).send('Method not allowed'); }
  const raw = req.rawBody ? Buffer.from(req.rawBody) : await readRaw(req);
  if (!verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('Bad signature');
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('Bad JSON'); }
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ ignored: event.type });

  const s = event.data.object;
  const isIllumi = (s.metadata && s.metadata.source === 'site_checkout') || !!s.payment_link;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
  const name = (s.customer_details && s.customer_details.name) || '';
  const username = tradingViewUsername(s);
  const warn = usernameWarning(username);

  let d = { plan: '', product: '', unit: null, interval: '', trialEnd: null };
  try { d = await details(s); } catch (e) { console.error('[webhook] details', e.message); }
  const planLabel = PLAN_LABEL[d.plan] || '';
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
      const w = welcomeEmail({ first: firstName(name), trialEnd: d.trialEnd, planLabel, username: warn ? '' : username });
      await mailer().sendMail({ from, to: email, replyTo: process.env.GMAIL_USER, subject: w.subject, text: w.text, html: w.html });
      welcome = warn ? 'sent (asks the customer for the username)' : 'sent';
    } catch (e) {
      console.error('[webhook] welcome', e.message);
      welcome = 'FAILED: ' + e.message + ' (send it manually)';
    }
  }

  // 2) alert to you
  try {
    const a = alertEmail({ s, email, name, username, warn, d, planLabel, welcome });
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
module.exports._t = { verify, tradingViewUsername, usernameWarning, firstName, welcomeEmail, alertEmail };
