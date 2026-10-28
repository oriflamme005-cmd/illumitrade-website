// IllumiTrade® — conversion details for the Thank You page  →  GET /api/session?id=cs_…
// Uses STRIPE_SECRET_KEY (Vercel env). Returns only what tracking needs — never email or name.
const STRIPE_VERSION = '2026-08-26.dahlia';
const PLAN_BY_LINK = {
  'https://buy.stripe.com/bJe7sK0Jnd4t4uEfxK0Ba0b': 'monthly',
  'https://buy.stripe.com/5kQdR8dw9e8x8KU2KY0Ba01': 'm3',
  'https://buy.stripe.com/cNi28qeAd9She5e0CQ0Ba02': 'm6',
  'https://buy.stripe.com/8x214m63H5C1e5egBO0Ba03': 'y1',
  'https://buy.stripe.com/dRm4gyeAd7K95yIcly0Ba04': 'lifetime',
};

async function stripe(path) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_VERSION },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe HTTP ' + r.status);
  return j;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(id)) return res.status(400).json({ ok: false });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ ok: false, status: 'unconfigured' });
  try {
    const s = await stripe('/checkout/sessions/' + id);
    if (s.status !== 'complete') return res.status(200).json({ ok: false, status: s.status });
    if (Date.now() / 1000 - s.created > 3 * 86400) return res.status(200).json({ ok: false, status: 'stale' });
    let plan = (s.metadata && s.metadata.plan) || '';
    if (!plan && s.payment_link) {
      try { plan = PLAN_BY_LINK[(await stripe('/payment_links/' + s.payment_link)).url] || ''; } catch (e) {}
    }
    const conv = s.currency_conversion && s.currency_conversion.source_currency === 'usd' ? s.currency_conversion : null;
    const usdCents = conv ? conv.amount_total : (String(s.currency).toLowerCase() === 'usd' ? s.amount_total : null);
    return res.status(200).json({
      ok: true,
      kind: s.mode === 'subscription' && s.amount_total === 0 ? 'trial' : 'purchase',
      plan: plan || (s.mode === 'subscription' ? 'monthly' : 'unknown'),
      value: (usdCents != null ? usdCents : s.amount_total) / 100,
      currency: usdCents != null ? 'USD' : String(s.currency || 'usd').toUpperCase(),
    });
  } catch (e) {
    console.error('[session]', e.message);
    return res.status(200).json({ ok: false, status: 'error' });
  }
};
