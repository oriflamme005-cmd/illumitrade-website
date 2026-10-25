// IllumiTrade® — on-site checkout (Vercel serverless function)
// ---------------------------------------------------------------------------
// GET  /api/checkout          → { ready: true|false }   (is checkout configured?)
// POST /api/checkout          → { clientSecret, publishableKey, mode }
//      body: { plan, email, username }
//
// Prices, trial length and promo-code setting are read LIVE from your existing
// Stripe Payment Links (below), so the site always follows what you set in Stripe.
// Nothing to edit here — you only add two Environment Variables in Vercel:
//   STRIPE_SECRET_KEY       sk_live_…   (secret, never put it in the code)
//   STRIPE_PUBLISHABLE_KEY  pk_live_…
// Optional override per plan, if ever needed:  PRICE_MONTHLY, PRICE_M3, PRICE_M6,
// PRICE_Y1, PRICE_LIFETIME  (= a price_… ID; trial for MONTHLY then = TRIAL_DAYS_MONTHLY or 7)
// ---------------------------------------------------------------------------

const STRIPE_VERSION = '2026-08-26.dahlia';

const PLANS = {
  monthly:  'https://buy.stripe.com/bJe7sK0Jnd4t4uEfxK0Ba0b',
  m3:       'https://buy.stripe.com/5kQdR8dw9e8x8KU2KY0Ba01',
  m6:       'https://buy.stripe.com/cNi28qeAd9She5e0CQ0Ba02',
  y1:       'https://buy.stripe.com/8x214m63H5C1e5egBO0Ba03',
  lifetime: 'https://buy.stripe.com/dRm4gyeAd7K95yIcly0Ba04',
};

const ALLOWED_HOSTS = /(^|\.)illumitrade\.com$|\.vercel\.app$|^localhost(:\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_.\-]{2,40}$/;

// --- tiny Stripe REST client (no dependency needed) -------------------------
function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

async function stripe(method, path, params) {
  const url = 'https://api.stripe.com/v1' + path +
    (method === 'GET' && params ? '?' + formEncode(params) : '');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'Stripe-Version': STRIPE_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? formEncode(params || {}) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || ('Stripe HTTP ' + res.status);
    throw new Error(msg);
  }
  return json;
}

// --- resolve a plan from its Payment Link (cached per warm instance) ---------
let linkCache = null, linkCacheAt = 0;
const planCache = {};

async function allPaymentLinks() {
  if (linkCache && Date.now() - linkCacheAt < 10 * 60 * 1000) return linkCache;
  const links = [];
  let starting_after;
  for (let page = 0; page < 10; page++) {
    const r = await stripe('GET', '/payment_links', { limit: 100, starting_after });
    links.push(...r.data);
    if (!r.has_more || !r.data.length) break;
    starting_after = r.data[r.data.length - 1].id;
  }
  linkCache = links; linkCacheAt = Date.now();
  return links;
}

async function resolvePlan(plan) {
  if (planCache[plan] && Date.now() - planCache[plan].at < 10 * 60 * 1000) return planCache[plan];

  const override = process.env['PRICE_' + plan.toUpperCase()];
  let priceId, quantity = 1, trialDays = null, promo = false, recurring;

  if (override) {
    priceId = override;
    const price = await stripe('GET', '/prices/' + priceId);
    recurring = price.type === 'recurring';
    if (recurring && plan === 'monthly') trialDays = Number(process.env.TRIAL_DAYS_MONTHLY || 7);
  } else {
    const url = PLANS[plan];
    const link = (await allPaymentLinks()).find((l) => l.url === url);
    if (!link) throw new Error('Payment Link not found for plan ' + plan);
    const items = await stripe('GET', `/payment_links/${link.id}/line_items`, { limit: 10 });
    const item = items.data && items.data[0];
    if (!item || !item.price) throw new Error('No line item on Payment Link for plan ' + plan);
    priceId = item.price.id;
    quantity = item.quantity || 1;
    recurring = item.price.type === 'recurring';
    trialDays = (link.subscription_data && link.subscription_data.trial_period_days) || null;
    promo = !!link.allow_promotion_codes;
  }

  const resolved = { priceId, quantity, trialDays, promo, mode: recurring ? 'subscription' : 'payment', at: Date.now() };
  planCache[plan] = resolved;
  return resolved;
}

// --- handler ----------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const configured = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);

  if (req.method === 'GET') {
    return res.status(200).json({ ready: configured });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!configured) return res.status(503).json({ error: 'Checkout not configured', fallback: true });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const plan = String(body.plan || '');
  const email = String(body.email || '').trim().slice(0, 200);
  const username = String(body.username || '').trim().replace(/^@/, '').slice(0, 40);

  if (!PLANS[plan]) return res.status(400).json({ error: 'Unknown plan' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.', field: 'email' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Please enter your TradingView username (letters, numbers, _ . -).', field: 'username' });

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const origin = ALLOWED_HOSTS.test(host)
    ? (host.startsWith('localhost') ? 'http://' : 'https://') + host
    : 'https://www.illumitrade.com';

  try {
    const p = await resolvePlan(plan);
    const meta = { tradingview_username: username, plan, source: 'site_checkout' };
    const label = 'TradingView: ' + username;

    const params = {
      ui_mode: 'elements',
      mode: p.mode,
      line_items: { 0: { price: p.priceId, quantity: p.quantity } },
      customer_email: email,
      return_url: origin + '/thankyou?session_id={CHECKOUT_SESSION_ID}',
      metadata: meta,
      allow_promotion_codes: p.promo ? 'true' : undefined,
    };
    if (p.mode === 'subscription') {
      params.subscription_data = { metadata: meta, description: label };
      if (p.trialDays) params.subscription_data.trial_period_days = p.trialDays;
    } else {
      params.customer_creation = 'always';
      params.payment_intent_data = { metadata: meta, description: label };
    }

    const session = await stripe('POST', '/checkout/sessions', params);
    return res.status(200).json({
      clientSecret: session.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      mode: p.mode,
      trialDays: p.trialDays,
    });
  } catch (err) {
    console.error('[checkout]', plan, err.message);
    return res.status(502).json({ error: 'Checkout temporarily unavailable', fallback: true });
  }
};
