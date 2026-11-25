// IllumiTrade® — automatic "+3 free days" bonus for monthly free trials
// ---------------------------------------------------------------------------------------------
// Runs once a day (Vercel Cron, see vercel.json). For every monthly trial that is about 2 days old,
// still active (not cancelled) and not already extended, it:
//   1) extends the trial by TRIAL_BONUS_DAYS (default 3) in Stripe,
//   2) emails the customer: "3 extra free days, your trial now ends on <date>",
//      (the email also points to the prepaid plans, from $58/month)
//   3) tags the subscription (metadata.trial_bonus = 1) so it can never be extended twice.
// Nothing is charged earlier than announced: the customer only ever gets MORE time, and the email
// states the new date of the first $80 charge.
//
// Same daily run: TRIAL-END REMINDER (promised in the checkout: "We email you a reminder 2 days before it ends").
// Every monthly trial that ends in 12 to 60 hours and is not set to cancel gets ONE plain reminder:
// the end date, "$80/month from then unless you cancel", the 1-click cancel link. No sales pitch.
// Tagged metadata.trial_reminder = 1 (before sending) so it is never sent twice.
// TRIAL_REMINDER_OFF=1 pauses it (then also remove the promise from the checkout text).
// If Stripe refuses the extension (key without write permission) nothing is emailed.
// ---------------------------------------------------------------------------------------------
// Vercel Environment Variables:
//   CRON_SECRET            any long random string. REQUIRED. Vercel sends it to the cron automatically.
//   STRIPE_SECRET_KEY      sk_live_…  (already set). Needs permission: Subscriptions → Write
//   GMAIL_USER / GMAIL_APP_PASSWORD   (already set for the webhook)
// Optional:
//   TRIAL_BONUS_OFF=1        pause the bonus
//   TRIAL_BONUS_DAYS=3       days added
//   TRIAL_BONUS_AFTER_HOURS=36   how old a trial must be before the bonus is sent
//   MONTHLY_PRICE_ID         the monthly $80 price (default: price_1SdQjvBt72v6u5uxukHaTtTh)
//   ALERT_EMAIL              where the daily summary goes (default: GMAIL_USER)
// Test without changing anything:  open  /api/trial-bonus?dry=1  with header  Authorization: Bearer <CRON_SECRET>
// ---------------------------------------------------------------------------------------------

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const STRIPE_VERSION = '2026-08-26.dahlia';
const DEFAULT_MONTHLY_PRICE = 'price_1SdQjvBt72v6u5uxukHaTtTh';
const HOUR = 3600;

const LINKS = {
  quick: 'https://www.illumitrade.com/guides/ILT-Guide-2026-Quick-Start.pdf',
  full: 'https://www.illumitrade.com/guides/ILT-Guide-2026-Full-Edition.pdf',
  telegram: 'https://t.me/+F0JSzA8w7rIzOTFk',
  portal: 'https://billing.stripe.com/p/login/cNidR877L6G56CM85i0Ba00',
  site: 'https://www.illumitrade.com',
  x: 'https://x.com/illumi_trade',
  prepaid: 'https://www.illumitrade.com/lp?utm_source=email&utm_medium=trial_email&utm_campaign=prepaid#pricing',
};

// ---------- Stripe helpers ----------
async function stripeGet(path) {
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

async function listTrialing() {
  const out = [];
  let after = '';
  for (let i = 0; i < 10; i++) {
    const j = await stripeGet('/subscriptions?status=trialing&limit=100&expand[]=data.customer' + (after ? '&starting_after=' + after : ''));
    out.push(...(j.data || []));
    if (!j.has_more || !j.data.length) break;
    after = j.data[j.data.length - 1].id;
  }
  return out;
}

// ---------- selection ----------
function pick(sub, now, cfg) {
  if (!sub || sub.status !== 'trialing') return 'not trialing';
  if (!sub.trial_start || !sub.trial_end) return 'no trial dates';
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item || !item.price || item.price.id !== cfg.priceId) return 'not the monthly plan';
  if (sub.metadata && sub.metadata.trial_bonus) return 'bonus already given';
  if (sub.cancel_at_period_end || sub.cancel_at || sub.canceled_at) return 'cancelled / cancellation scheduled';
  if (sub.pause_collection) return 'paused';
  if (sub.trial_end - sub.trial_start > 8 * 24 * HOUR) return 'trial already longer than 8 days';
  const age = now - sub.trial_start;
  if (age < cfg.afterHours * HOUR) return 'too early';
  if (age > (cfg.afterHours + 60) * HOUR) return 'too late for the bonus';
  if (sub.trial_end - now < 12 * HOUR) return 'trial ends within 12h';
  return '';
}

// Trial-end reminder: monthly trial, still on, ends in 12-60 h, not reminded yet
function pickReminder(sub, now, cfg) {
  if (!sub || sub.status !== 'trialing' || !sub.trial_end) return 'not trialing';
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item || !item.price || item.price.id !== cfg.priceId) return 'not the monthly plan';
  if (sub.metadata && sub.metadata.trial_reminder) return 'reminder already sent';
  if (sub.cancel_at_period_end || sub.cancel_at || sub.canceled_at) return 'cancelled / cancellation scheduled';
  if (sub.pause_collection) return 'paused';
  const left = sub.trial_end - now;
  if (left > 60 * HOUR) return 'more than 60h left';
  if (left < 12 * HOUR) return 'less than 12h left';
  return '';
}

function reminderEmail({ first, end }) {
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const date = fmtDate(end);
  const intro = `A quick reminder, as promised when you started: your ILT® free trial ends on ${date} (same time of day you started).`;
  const keep = 'If ILT® is for you, there is nothing to do: your membership continues at $80/month and your TradingView access stays on.';
  const stop = `If it is not for you, cancel in 1 click before ${date} and you pay nothing:`;
  const help = 'Questions, or stuck with the setup? Just reply to this message. I read every one personally.';
  const text = [hi, '', intro, '', keep, '', stop, LINKS.portal, '', help, '', 'Best regards,', '', 'ILT 💎', 'www.illumitrade.com', LINKS.x].join('\n');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">
<p>${esc(hi)}</p>
<p><b>${esc(intro)}</b></p>
<p>${esc(keep)}</p>
<p>${esc(stop)}<br><a href="${LINKS.portal}">${LINKS.portal}</a></p>
<p>${esc(help)}</p>
<p>Best regards,</p>
<p>ILT 💎<br><a href="${LINKS.site}">www.illumitrade.com</a><br><a href="${LINKS.x}">${LINKS.x}</a></p>
</div>`;
  return { subject: `Reminder: your ILT® free trial ends on ${date}`, text, html };
}

function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  if (!n || /@/.test(n)) return '';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ---------- email ----------
function bonusEmail({ first, newEnd, days }) {
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const date = fmtDate(newEnd);
  const intro = `Quick update on your ILT® free trial: I've just added ${days} extra free days, so you have more time to read the guide and test the indicator on your own charts.`;
  const when = `Your trial now runs until ${date} (same time of day you started). Nothing is charged before then, and you can cancel in 1 click any time before it ends.`;
  const how = 'Where to start (about 10 minutes):';
  const prepaid = 'Prefer to pay less per month? Prepaid plans start at $58/month: pay once, no auto-renew, with a 14-day money-back guarantee. If you switch, your free trial closes automatically, so you are never charged twice:';

  const text = [
    hi, '', intro, '', when, '',
    how,
    '1. Quick Start Guide (5 min read): ' + LINKS.quick,
    '2. Full Edition Guide, for the details: ' + LINKS.full,
    '3. Stuck on the setup? Reply to this email, or ask in the private Telegram: ' + LINKS.telegram, '',
    prepaid + ' ' + LINKS.prepaid, '',
    'Manage or cancel your subscription: ' + LINKS.portal, '',
    'Best regards,', '', 'ILT 💎', 'www.illumitrade.com', LINKS.x,
  ].join('\n');

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const a = (u) => `<a href="${u}">${u}</a>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">
<p>${esc(hi)}</p>
<p>${esc(intro)}</p>
<p><b>${esc(when)}</b></p>
<p>${esc(how)}</p>
<ol style="margin:0 0 14px;padding-left:20px">
<li>Quick Start Guide (5 min read): ${a(LINKS.quick)}</li>
<li>Full Edition Guide, for the details: ${a(LINKS.full)}</li>
<li>Stuck on the setup? Reply to this email, or ask in the private Telegram: ${a(LINKS.telegram)}</li>
</ol>
<p>${esc(prepaid)} <a href="${LINKS.prepaid}">See the prepaid plans</a></p>
<p>Manage or cancel your subscription: ${a(LINKS.portal)}</p>
<p>Best regards,</p>
<p>ILT 💎<br><a href="${LINKS.site}">www.illumitrade.com</a><br><a href="${LINKS.x}">${LINKS.x}</a></p>
</div>`;

  return { subject: `A small gift from ILT®: +${days} free days`, text, html };
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

// ---------- main job ----------
async function run({ dry = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const cfg = {
    priceId: process.env.MONTHLY_PRICE_ID || DEFAULT_MONTHLY_PRICE,
    days: Math.max(1, Number(process.env.TRIAL_BONUS_DAYS || 3)),
    afterHours: Math.max(1, Number(process.env.TRIAL_BONUS_AFTER_HOURS || 36)),
  };
  const subs = await listTrialing();
  const result = { checked: subs.length, extended: [], skipped: {}, failed: [], dry };
  const from = `"ILT 💎 IllumiTrade" <${process.env.GMAIL_USER}>`;

  for (const sub of subs) {
    const why = pick(sub, now, cfg);
    if (why) { result.skipped[why] = (result.skipped[why] || 0) + 1; continue; }

    const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : {};
    const email = cust.email || '';
    const username = (sub.metadata && sub.metadata.tradingview_username) || String(sub.description || '').replace(/^TradingView:\s*/i, '') || '';
    const newEnd = sub.trial_end + cfg.days * 24 * HOUR;
    const row = { id: sub.id, user: username, email: email || '(no email)', newEnd: fmtDate(newEnd) };

    if (!email) { result.skipped['no customer email'] = (result.skipped['no customer email'] || 0) + 1; continue; }
    if (dry) { result.extended.push({ ...row, dry: true }); continue; }

    // 1) extend first: the customer must never be promised days that Stripe did not grant
    try {
      await stripePost('/subscriptions/' + sub.id, {
        trial_end: newEnd,
        proration_behavior: 'none',
        'metadata[trial_bonus]': '1',
        'metadata[trial_bonus_days]': String(cfg.days),
      });
    } catch (e) {
      console.error('[trial-bonus] stripe', sub.id, e.message);
      result.failed.push({ ...row, error: 'Stripe: ' + e.message });
      continue;
    }

    // 2) tell the customer
    try {
      const m = bonusEmail({ first: firstName(cust.name), newEnd, days: cfg.days });
      await mailer().sendMail({ from, to: email, replyTo: process.env.GMAIL_USER, subject: m.subject, text: m.text, html: m.html });
      result.extended.push(row);
    } catch (e) {
      console.error('[trial-bonus] email', sub.id, e.message);
      result.failed.push({ ...row, error: 'Trial WAS extended in Stripe but the email failed: ' + e.message + ' (tell the customer manually)' });
    }
  }

  // ---- trial-end reminders (2 days before) ----
  result.reminded = [];
  if (process.env.TRIAL_REMINDER_OFF !== '1') {
    const extendedNow = new Set(result.extended.map((x) => x.id));
    for (const sub of subs) {
      if (extendedNow.has(sub.id)) continue;   // its trial_end just moved: picked up on a later run
      const why = pickReminder(sub, now, cfg);
      if (why) continue;
      const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : {};
      const to = cust.email || '';
      const username = (sub.metadata && sub.metadata.tradingview_username) || '';
      const row = { id: sub.id, user: username, email: to || '(no email)', end: fmtDate(sub.trial_end) };
      if (!to) { result.skipped['reminder: no customer email'] = (result.skipped['reminder: no customer email'] || 0) + 1; continue; }
      if (dry) { result.reminded.push({ ...row, dry: true }); continue; }
      // tag first: a customer must never get the reminder twice
      try {
        await stripePost('/subscriptions/' + sub.id, { 'metadata[trial_reminder]': '1' });
      } catch (e) {
        console.error('[trial-bonus] reminder tag', sub.id, e.message);
        result.failed.push({ ...row, error: 'Reminder not sent (Stripe tag failed): ' + e.message });
        continue;
      }
      try {
        const m = reminderEmail({ first: firstName(cust.name), end: sub.trial_end });
        await mailer().sendMail({ from, to, replyTo: process.env.GMAIL_USER, subject: m.subject, text: m.text, html: m.html });
        result.reminded.push(row);
      } catch (e) {
        console.error('[trial-bonus] reminder', sub.id, e.message);
        result.failed.push({ ...row, error: 'Trial-end reminder FAILED: ' + e.message + ' (send it manually)' });
      }
    }
  }
  return result;
}

function summary(r) {
  const lines = [`Trial bonus run: ${r.checked} trial(s) checked · ${r.extended.length} extended · ${r.failed.length} failed${r.dry ? ' (DRY RUN, nothing changed)' : ''}`, ''];
  r.extended.forEach((x) => lines.push(`✓ ${x.user || '?'} · ${x.email} · trial now ends ${x.newEnd}`));
  (r.reminded || []).forEach((x) => lines.push(`⏰ reminder sent · ${x.user || '?'} · ${x.email} · trial ends ${x.end}`));
  r.failed.forEach((x) => lines.push(`✗ ${x.user || '?'} · ${x.email} · ${x.error}`));
  const sk = Object.entries(r.skipped);
  if (sk.length) lines.push('', 'Skipped: ' + sk.map(([k, v]) => `${v}× ${k}`).join(' · '));
  return lines.join('\n');
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured → nobody can trigger it
  const got = String(req.headers.authorization || '');
  const want = 'Bearer ' + secret;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (process.env.TRIAL_BONUS_OFF === '1') return res.status(200).json({ paused: true });
  const dry = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));
  try {
    const r = await run({ dry });
    // Daily summary to you, only when something happened (or failed)
    const nRem = (r.reminded || []).length;
    if (!dry && (r.extended.length || r.failed.length || nRem)) {
      try {
        await mailer().sendMail({
          from: `"ILT 💎 IllumiTrade" <${process.env.GMAIL_USER}>`,
          to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
          subject: `🎁 Trials: ${r.extended.length} extended${nRem ? ` · ${nRem} reminder${nRem > 1 ? 's' : ''} sent` : ''}${r.failed.length ? ` · ⚠ ${r.failed.length} failed` : ''}`,
          text: summary(r),
        });
      } catch (e) { console.error('[trial-bonus] summary', e.message); }
    }
    return res.status(200).json(r);
  } catch (e) {
    console.error('[trial-bonus]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = handler;
module.exports._t = { pick, pickReminder, bonusEmail, reminderEmail, run, summary, fmtDate, firstName };
