/* IllumiTrade® — measurement layer. One file, loaded on every page:
 *   <script src="/ilt-track.js" defer></script>
 *
 * ── CONFIG: the only part you ever edit ──────────────────────────────────── */
var ILT_TRACK_CONFIG = {
  // Umami Cloud (free, cookieless) → Settings → Websites → Add website → copy the "Website ID"
  UMAMI_ID: '',
  UMAMI_SRC: 'https://cloud.umami.is/script.js',
  // X Ads → Tools → Events Manager → your pixel omn00 → "Add events" → copy each event ID (tw-omn00-xxxxx)
  X_PIXEL: 'omn00',
  X_EVENTS: {
    trial:    'tw-omn00-ri3rd',   // "Signup Illumitrade" — free trial started (value 0)
    purchase: 'tw-omn00-ri3rd',   // "Signup Illumitrade" — paid plan (value = real amount)
    checkout: '',   // "Checkout initiated" — fires once per visit on the first click on any plan button
    lead:     ''    // optional "Lead"  — fires when someone opens the free-guide form (blog)
  },
  // Google Ads (kept for the day you run it; harmless otherwise)
  AW_CONVERSION: 'AW-11355613809/Ad_7CLP5qcwcEPHU46Yq'
};
/* ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var C = ILT_TRACK_CONFIG, w = window, d = document;
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ── X pixel base (pages that already have it inline keep theirs) ──
  if (!w.twq && C.X_PIXEL) {
    !function (e, t, n, s, u, a) { e.twq || (s = e.twq = function () { s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments); },
      s.version = '1.1', s.queue = [], u = t.createElement(n), u.async = !0, u.src = 'https://static.ads-twitter.com/uwt.js',
      a = t.getElementsByTagName(n)[0], a.parentNode.insertBefore(u, a)); }(w, d, 'script');
    w.twq('config', C.X_PIXEL);
  }

  // ── Vercel Web Analytics (visits, pages, countries, referrers) ──
  // Turn it on once in Vercel → project → Analytics → Enable. Until then this request is a harmless 404.
  if (/(^|\.)illumitrade\.com$/.test(location.hostname)) {
    w.va = w.va || function () { (w.vaq = w.vaq || []).push(arguments); };
    var va = d.createElement('script');
    va.defer = true; va.src = '/_vercel/insights/script.js';
    d.head.appendChild(va);
  }

  // ── Umami (production domains only, so previews don't pollute the numbers) ──
  if (C.UMAMI_ID) {
    var u = d.createElement('script');
    u.defer = true; u.src = C.UMAMI_SRC;
    u.setAttribute('data-website-id', C.UMAMI_ID);
    u.setAttribute('data-domains', 'illumitrade.com,www.illumitrade.com');
    d.head.appendChild(u);
  }

  // ── first-touch attribution (kept 90 days, sent with the checkout) ──
  try {
    var qs = new URLSearchParams(location.search), utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(function (k) { if (qs.get(k)) utm[k] = qs.get(k).slice(0, 60); });
    if (!utm.utm_source && qs.get('twclid')) utm.utm_source = 'x_ads';
    var old = JSON.parse(LS.get('ilt_utm') || 'null');
    if (Object.keys(utm).length && (!old || Date.now() - old.t > 90 * 864e5)) LS.set('ilt_utm', JSON.stringify({ t: Date.now(), v: utm }));
    if (!old && !Object.keys(utm).length && d.referrer && d.referrer.indexOf(location.hostname) < 0) {
      var ref = d.referrer.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      LS.set('ilt_utm', JSON.stringify({ t: Date.now(), v: { utm_source: ref.slice(0, 60), utm_medium: 'referral' } }));
    }
  } catch (e) {}

  // ── queue until Umami is ready ──
  var q = [];
  function flush() { if (w.umami && w.umami.track) { while (q.length) { var a = q.shift(); try { w.umami.track(a[0], a[1]); } catch (e) {} } return true; } return false; }
  var tries = 0, timer = setInterval(function () { if (flush() || ++tries > 40) clearInterval(timer); }, 250);

  function x(key, params) {
    var id = C.X_EVENTS[key]; if (!id || !w.twq) return;
    if (key === 'checkout') { if (w.__iltCheckoutSent) return; w.__iltCheckoutSent = 1; } // once per page view
    try { w.twq('event', id, params || {}); } catch (e) {}
  }

  var ILT = w.ILT = w.ILT || {};
  ILT.track = function (name, data, xKey, xParams) {
    data = data || {};
    if (C.UMAMI_ID) { q.push([name, data]); flush(); }
    if (xKey) x(xKey, xParams);
    if (w.ILT_DEBUG) console.log('[ILT track]', name, data, xKey || '');
  };
  ILT.utm = function () { try { var o = JSON.parse(LS.get('ilt_utm') || 'null'); return (o && o.v) || {}; } catch (e) { return {}; } };

  // ── automatic events (no page edits needed) ──
  function where(el) {
    var s = el.closest && el.closest('section[id],nav,header,footer,[data-where]');
    return s ? (s.getAttribute('data-where') || s.id || s.tagName.toLowerCase()) : 'page';
  }
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var h = a.getAttribute('href') || '';
    if (a.hasAttribute('data-plan')) ILT.track('cta_click', { plan: a.getAttribute('data-plan'), where: where(a) }, 'checkout', {});
    else if (/buy\.stripe\.com/.test(h)) ILT.track('cta_click', { plan: 'link', where: where(a) }, 'checkout', {});
    else if (/t\.me\//.test(h)) ILT.track('telegram_click', { where: where(a) });
    else if (/sibforms\.com/.test(h)) ILT.track('lead_form_open', { where: where(a) }, 'lead');
    else if (/billing\.stripe\.com/.test(h)) ILT.track('manage_click', { where: where(a) });
    else if (/\.pdf($|\?)/i.test(h)) ILT.track('guide_download', { file: h.split('/').pop().slice(0, 60) });
    else if (/x\.com\/illumi_trade\/status/.test(h)) ILT.track('proof_x_click', { where: where(a) });
    else if (/iltoracle\.com/.test(h)) ILT.track('oracle_click', { where: where(a) });
    else if (/#pricing$/.test(h)) ILT.track('pricing_link', { where: where(a) });
  }, true);

  // section views, once per page load
  function watch() {
    if (!('IntersectionObserver' in w)) return;
    var seen = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        var id = en.target.id;
        if (en.isIntersecting && !seen[id]) { seen[id] = 1; ILT.track('view_' + id); io.unobserve(en.target); }
      });
    }, { threshold: 0.25 });
    ['proof', 'testimonials', 'how-it-works', 'pricing', 'faq'].forEach(function (id) { var el = d.getElementById(id); if (el) io.observe(el); });
  }

  // ── conversion on /thankyou ──
  // Counts ONLY a real checkout: the page must come from a Stripe redirect.
  // A bookmarked/revisited thank-you page (or /members) never counts.
  function conversion() {
    if (!/^\/thankyou/.test(location.pathname)) return;
    var sid = new URLSearchParams(location.search).get('session_id') || '';
    var fromStripe = /stripe\.com/.test(d.referrer || '');
    if (!sid && !fromStripe) return;
    var key = 'ilt_conv_' + (sid || ('nosid_' + new Date().toISOString().slice(0, 10)));
    if (LS.get(key)) return;                         // reload / back button → never counted twice
    function fire(info) {
      LS.set(key, '1');
      var kind = info.kind || 'unknown', value = Number(info.value || 0), cur = info.currency || 'USD';
      var params = kind === 'unknown' ? { conversion_id: sid || undefined } : { value: value, currency: cur, conversion_id: sid || undefined };
      var name = kind === 'trial' ? 'trial_started' : kind === 'purchase' ? 'purchase' : 'checkout_complete';
      ILT.track(name, { plan: info.plan || 'unknown', value: value }, kind === 'purchase' ? 'purchase' : 'trial', params);
      if (w.gtag && C.AW_CONVERSION) {
        try { w.gtag('event', 'conversion', { send_to: C.AW_CONVERSION, value: value, currency: cur, transaction_id: sid || '' }); } catch (e) {}
      }
      var ev; try { ev = new CustomEvent('ilt:conversion', { detail: info }); } catch (e) {}
      if (ev) d.dispatchEvent(ev);
    }
    var unknown = { kind: 'unknown', plan: 'unknown', value: 0 };
    if (!sid) return fire(unknown);
    fetch('/api/session?id=' + encodeURIComponent(sid), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) return fire(j);
        if (j && (j.status === 'stale' || j.status === 'open' || j.status === 'expired')) return; // old link or unpaid → not a sale
        fire(unknown);                                // API not configured → still count it, without value
      })
      .catch(function () { fire(unknown); });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', function () { watch(); conversion(); });
  else { watch(); conversion(); }
})();
