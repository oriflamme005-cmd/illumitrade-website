// /api/contact — the on-site chat widget sends visitor questions here; they arrive in your Gmail.
// Uses the same Vercel env vars as api/stripe-webhook.js (nothing new to set):
//   GMAIL_USER           illumitrade.contact@gmail.com
//   GMAIL_APP_PASSWORD   16-letter Google "App password"
//   ALERT_EMAIL          where the message goes (default: GMAIL_USER)
// Hit "Reply" in Gmail and your answer goes straight to the visitor (Reply-To = their email).
// Nothing is ever sent to the address the visitor typed, so the form can't be abused to spam people.

const nodemailer = require('nodemailer');

const ALLOWED_HOSTS = /(^|\.)illumitrade\.com$|\.vercel\.app$|^localhost(:\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// best-effort anti-flood (per warm instance): 5 messages / 10 min / IP
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now); hits.set(ip, list);
  if (hits.size > 500) hits.clear();
  return list.length > 5;
}

let transporter;
function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') },
    });
  }
  return transporter;
}

const clean = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\n\t]+/g, ' ');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  // only accept posts coming from the site itself
  let originHost = '';
  try { originHost = new URL(req.headers.origin || req.headers.referer || '').host; } catch (e) {}
  if (!ALLOWED_HOSTS.test(originHost)) return res.status(403).json({ error: 'Forbidden' });

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(503).json({ error: 'not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // silent traps for bots: hidden field filled, or form sent too fast → pretend it worked
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });
  const openedFor = Number(body.elapsed) || 0;
  if (openedFor > 0 && openedFor < 2500) return res.status(200).json({ ok: true });

  const email = oneLine(body.email, 160).toLowerCase();
  const message = clean(body.message, 4000);
  const page = oneLine(body.page, 200);
  const ref = oneLine(body.ref, 300);

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email so we can reply.', field: 'email' });
  if (message.length < 2) return res.status(400).json({ error: 'Please type your question.', field: 'message' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many messages. Please email us directly.' });

  const country = oneLine(req.headers['x-vercel-ip-country'] || '', 8);
  const preview = message.replace(/\s+/g, ' ').slice(0, 60);
  const text = [
    message,
    '',
    '———',
    'From: ' + email,
    'Page: ' + (page || '—'),
    'Source: ' + (ref || '—'),
    country ? 'Country: ' + country : null,
    '',
    'Hit Reply to answer the visitor directly.',
  ].filter(l => l !== null).join('\n');

  try {
    await mailer().sendMail({
      from: `"ILT 💎 Site chat" <${process.env.GMAIL_USER}>`,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      replyTo: email,
      subject: `💬 Site question from ${email}: ${preview}${message.length > 60 ? '…' : ''}`,
      text,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('contact: send failed', e && e.message);
    return res.status(502).json({ error: 'send_failed' });
  }
};
