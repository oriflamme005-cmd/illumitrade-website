/* IllumiTrade® — measurement layer. One file, loaded on every page:
 *   <script src="/ilt-track.js" defer></script>
 *
 * ── CONFIG: the only part you ever edit ──────────────────────────────────── */
var ILT_TRACK_CONFIG = {
  // X Ads → Tools → Events Manager → your pixel omn00 → "Add events" → copy each event ID (tw-omn00-xxxxx)
  X_PIXEL: 'omn00',
  X_EVENTS: {
    trial:    'tw-omn00-ri3rd',   // "Signup Illumitrade" — free trial started (value 0)
    purchase: 'tw-omn00-riseo',   // "Purchase Illumitrade" — paid plan (value = real amount)
    checkout: 'tw-omn00-risev',   // "Checkout Illumitrade" (Add to cart) — fires once per visit on the first click on any plan button
    lead:     ''    // optional "Lead"  — fires when someone opens the free-guide form (blog)
  },
  // Google Ads (kept for the day you run it; harmless otherwise)
  AW_CONVERSION: 'AW-11355613809/Ad_7CLP5qcwcEPHU46Yq',
  // Google Analytics 4 — paste the Measurement ID of the IllumiTrade property (G-XXXXXXXXXX). Empty = GA4 off.
  GA4_ID: 'G-V0H194GPVJ',
  // Only the live site reports: previews (*.vercel.app) and localhost never pollute the numbers.
  GA4_HOSTS: /(^|\.)illumitrade\.com$/,
  // Microsoft Clarity (free session recordings + heatmaps). Paste the project ID (short code from clarity.microsoft.com → Settings). Empty = off.
  // Loads only where GA4 loads, i.e. after "Accept" for visitors in Europe, and never on /members or /thankyou.
  CLARITY_ID: ''
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

  // ── Google Analytics 4 (consent-aware) ──
  // Visitors whose browser time zone is in Europe (UK included) get a small Accept / Decline notice and GA4 loads
  // only after "Accept". Everyone else is measured straight away. We never use Google's advertising features.
  var GA = { on: false };
  function gt() { (w.dataLayer = w.dataLayer || []).push(arguments); }   // own helper: window.gtag stays undefined, so the Google Ads line further down stays inert
  function inEurope() {
    try { return /^(Europe\/|Atlantic\/(Canary|Madeira|Azores|Faroe|Reykjavik))/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { return false; }
  }
  function consentState() {
    var v = LS.get('ilt_consent'); if (!v) return '';
    var p = v.split('|');
    return (Date.now() - Number(p[1] || 0) > 365 * 864e5) ? '' : p[0];   // the choice is asked again after a year
  }
  function loadClarity() {
    if (!C.CLARITY_ID || w.clarity || /^\/(members|thankyou)/.test(location.pathname)) return;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(w, d, 'clarity', 'script', C.CLARITY_ID);
    // Clarity requires an explicit consent signal for EEA / UK / CH visitors. We only get here after "Accept" (or outside Europe).
    try { w.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }); } catch (e) {}
    // Tag every recording with the visitor's source, so recordings can be filtered by "X ad bf1" vs "profile" etc.
    setTimeout(function () {
      try {
        var u = (w.ILT && w.ILT.utm && w.ILT.utm()) || {};
        w.clarity('set', 'source', u.utm_source || 'direct');
        w.clarity('set', 'medium', u.utm_medium || '');
        w.clarity('set', 'campaign', u.utm_campaign || '');
        w.clarity('set', 'content', u.utm_content || '');
        w.clarity('set', 'page', location.pathname.slice(0, 40));
      } catch (e) {}
    }, 800);
  }
  function loadGA() {
    if (GA.on) return; GA.on = true;
    loadClarity();
    gt('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gt('js', new Date());
    var cfg = { cookie_flags: 'SameSite=Lax;Secure', allow_google_signals: false, allow_ad_personalization_signals: false };
    if (/[?&]ga_debug=1/.test(location.search)) cfg.debug_mode = true;   // add ?ga_debug=1 to a link to watch it live in GA4 → Admin → DebugView
    gt('config', C.GA4_ID, cfg);
    var s = d.createElement('script'); s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(C.GA4_ID);
    d.head.appendChild(s);
    // The visitor's GA4 id is kept in a first-party cookie, so /api/checkout can store it in Stripe and
    // the webhook can report "paid after trial" / "cancelled" to the SAME visitor (and therefore the same source).
    var cid = '', sid = '';
    function save() {
      if (!cid) return;
      d.cookie = 'ilt_ga=' + encodeURIComponent(cid + '~' + sid) + '; path=/; max-age=' + 90 * 86400 + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    }
    try {
      gt('get', C.GA4_ID, 'client_id', function (v) { cid = String(v || ''); save(); });
      gt('get', C.GA4_ID, 'session_id', function (v) { sid = String(v || ''); save(); });
    } catch (e) {}
  }
  function askConsent() {
    function build() {
      if (d.getElementById('ilt-consent')) return;
      var b = d.createElement('div');
      b.id = 'ilt-consent'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', 'Cookie notice');
      b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;background:#0c0c10;color:#c7ccd2;' +
        'border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:12px 14px;font:13px/1.45 "Hanken Grotesk",system-ui,sans-serif;' +
        'display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 8px 30px rgba(0,0,0,.5)';
      var t = d.createElement('span'); t.style.cssText = 'flex:1 1 220px';
      t.textContent = 'We use analytics cookies to see which pages help visitors. No ads, nothing sold.';
      b.appendChild(t);
      function btn(label, grant) {
        var e = d.createElement('button'); e.type = 'button'; e.textContent = label;
        e.style.cssText = 'cursor:pointer;font:600 12px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;padding:9px 14px;border-radius:3px;' +
          (grant ? 'background:#f4f5f6;color:#050506;border:1px solid #f4f5f6' : 'background:transparent;color:#c7ccd2;border:1px solid rgba(255,255,255,.28)');
        e.addEventListener('click', function () {
          LS.set('ilt_consent', (grant ? 'granted' : 'denied') + '|' + Date.now());
          if (b.parentNode) b.parentNode.removeChild(b);
          if (grant) loadGA();
        });
        return e;
      }
      b.appendChild(btn('Decline', false)); b.appendChild(btn('Accept', true));
      d.body.appendChild(b);
    }
    if (d.body) build(); else d.addEventListener('DOMContentLoaded', build);
  }
  if (C.GA4_ID && C.GA4_HOSTS && C.GA4_HOSTS.test(location.hostname)) {
    var cs = consentState();
    if (!inEurope() || cs === 'granted') loadGA();
    else if (!cs) askConsent();
  }

  var refId = '';
  // ── attribution: first touch + last campaign touch + landing page (kept 90 days) ──
  // Stored in localStorage and mirrored in a first-party cookie (ilt_src) that /api/checkout reads,
  // so every trial and sale in Stripe carries where the customer came from.
  try {
    var qs = new URLSearchParams(location.search), utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(function (k) { if (qs.get(k)) utm[k] = qs.get(k).slice(0, 60); });
    if (qs.get('twclid')) { if (!utm.utm_source) utm.utm_source = 'x_ads'; if (!utm.utm_medium) utm.utm_medium = 'paid'; }
    var hasUtm = Object.keys(utm).length > 0, now = Date.now(), DAYS90 = 90 * 864e5;
    var page = location.pathname.slice(0, 60);
    var old = JSON.parse(LS.get('ilt_utm') || 'null');
    if (old && now - old.t > DAYS90) old = null;
    if (!old) {
      var first = hasUtm ? utm : null;
      if (!first && d.referrer && d.referrer.indexOf(location.hostname) < 0) {
        first = { utm_source: d.referrer.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].slice(0, 60), utm_medium: 'referral' };
      }
      if (!first) first = { utm_source: 'direct' };
      old = { t: now, v: first, p: page };
      LS.set('ilt_utm', JSON.stringify(old));
    }
    var last = JSON.parse(LS.get('ilt_last') || 'null');
    if (last && now - last.t > DAYS90) last = null;
    if (hasUtm) { last = { t: now, v: utm, p: page }; LS.set('ilt_last', JSON.stringify(last)); }
    var use = last || old, src = {
      s: use.v.utm_source || '', m: use.v.utm_medium || '', c: use.v.utm_campaign || '', n: use.v.utm_content || '',
      p: use.p || old.p || '', f: old.v.utm_source || '', d: new Date(old.t).toISOString().slice(0, 10)
    };
    d.cookie = 'ilt_src=' + encodeURIComponent(JSON.stringify(src)) + '; path=/; max-age=' + 90 * 86400 + '; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
    // Same attribution, packed for Stripe Payment Links (?client_reference_id=…): letters, digits, - and _ only.
    // Read back by /api/stripe-webhook.js, so a sale that goes through a plain Stripe link still carries its source.
    var enc = function (v) { return String(v || '').replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/_{2,}/g, '_').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40); };
    var parts = ['ilt1'];
    [['s', src.s], ['m', src.m], ['c', src.c], ['n', src.n], ['p', src.p === '/' ? 'home' : src.p], ['f', src.f], ['d', src.d]]
      .forEach(function (kv) { var v = enc(kv[1]); if (v) parts.push(kv[0] + '-' + v); });
    refId = parts.join('__').slice(0, 200);
  } catch (e) {}
  // ── X Ads click id (?twclid=… on every ad click), kept 30 days = X's attribution window ──
  // /api/checkout stores it in Stripe, and the webhook sends the trial / sale to X server-side (Conversion API),
  // so X matches it to the ad click even when the browser pixel is blocked.
  try {
    var tw = new URLSearchParams(location.search).get('twclid') || '';
    if (/^[\w-]{5,120}$/.test(tw)) {
      d.cookie = 'ilt_tw=' + encodeURIComponent(tw) + '; path=/; max-age=' + 30 * 86400 + '; SameSite=Lax' +
        (location.protocol === 'https:' ? '; Secure' : '');
    }
  } catch (e) {}

  function x(key, params) {
    var id = C.X_EVENTS[key] || (key === 'purchase' ? C.X_EVENTS.trial : ''); if (!id || !w.twq) return;
    if (key === 'checkout') { if (w.__iltCheckoutSent) return; w.__iltCheckoutSent = 1; } // once per page view
    try { w.twq('event', id, params || {}); } catch (e) {}
  }

  var ILT = w.ILT = w.ILT || {};
  ILT.track = function (name, data, xKey, xParams) {
    data = data || {};
    try { if (w.va && /(^|\.)illumitrade\.com$/.test(location.hostname)) w.va('event', { name: name, data: data }); } catch (e) {}  // Vercel custom events (recorded on plans that support them)
    if (GA.on) {
      try {
        var gp = {}; Object.keys(data).forEach(function (k) { if (data[k] !== undefined && data[k] !== null) gp[k] = typeof data[k] === 'string' ? data[k].slice(0, 100) : data[k]; });
        gt('event', name, gp);
        if (xKey === 'checkout' && !w.__iltGaCheckout) { w.__iltGaCheckout = 1; gt('event', 'begin_checkout', { currency: 'USD', plan: gp.plan || '' }); }  // once per page view, like the X event
      } catch (e) {}
    }
    if (xKey) x(xKey, xParams);
    if (w.ILT_DEBUG) console.log('[ILT track]', name, data, xKey || '');
  };
  ILT.ref = function () { return refId; };
  ILT.consent = function () { LS.set('ilt_consent', ''); if (C.GA4_ID && !GA.on) askConsent(); };   // re-opens the cookie notice
  // Adds the visitor's source to a Stripe Payment Link (never touches a link that already has one).
  function tagStripeLink(a) {
    try {
      var h = a.getAttribute('href') || '';
      if (!refId || !/^https:\/\/buy\.stripe\.com\//.test(h) || /[?&]client_reference_id=/.test(h)) return;
      a.setAttribute('href', h + (h.indexOf('?') < 0 ? '?' : '&') + 'client_reference_id=' + encodeURIComponent(refId));
    } catch (e) {}
  }
  ILT.utm = function () { try { var o = JSON.parse(LS.get('ilt_last') || LS.get('ilt_utm') || 'null'); return (o && o.v) || {}; } catch (e) { return {}; } };

  // ── automatic events (no page edits needed) ──
  function where(el) {
    var s = el.closest && el.closest('section[id],nav,header,footer,[data-where]');
    return s ? (s.getAttribute('data-where') || s.id || s.tagName.toLowerCase()) : 'page';
  }
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var h = a.getAttribute('href') || '';
    if (/buy\.stripe\.com/.test(h)) tagStripeLink(a);   // runs before the on-site checkout reads the link as its fallback
    if (/^https?:\/\/(www\.)?iltoracle\.com/.test(h) && !/[?&]utm_source=/.test(h)) {   // IllumiTrade → ILT Oracle keeps its source
      var hi = h.indexOf('#'), base = hi < 0 ? h : h.slice(0, hi), hash = hi < 0 ? '' : h.slice(hi);
      a.setAttribute('href', base + (base.indexOf('?') < 0 ? '?' : '&') + 'utm_source=illumitrade&utm_medium=site&utm_campaign=crosslink&utm_content=' + encodeURIComponent(where(a)) + hash);
    }
    if (a.hasAttribute('data-plan')) ILT.track('cta_click', { plan: a.getAttribute('data-plan'), where: where(a) }, 'checkout', {});
    else if (/buy\.stripe\.com/.test(h)) ILT.track('cta_click', { plan: 'link', where: where(a) }, 'checkout', {});
    else if (/t\.me\//.test(h)) ILT.track('telegram_click', { where: where(a) });
    else if (/sibforms\.com/.test(h)) ILT.track('lead_form_open', { where: where(a) }, 'lead');
    else if (/billing\.stripe\.com/.test(h)) ILT.track('manage_click', { where: where(a) });
    else if (/\.pdf($|\?)/i.test(h)) ILT.track('guide_download', { file: h.split('/').pop().slice(0, 60) });
    else if (/x\.com\/illumi_trade\/status/.test(h)) ILT.track('proof_x_click', { where: where(a) });
    else if (/iltoracle\.com/.test(h)) ILT.track('oracle_click', { where: where(a) });
    else if (/(x|twitter)\.com\/illumi_trade\/?($|[?#])/i.test(h)) ILT.track('x_profile_click', { where: where(a) });
    else if (/tradingview\.com\/(u|script)\//.test(h)) ILT.track('tradingview_click', { where: where(a) });
    else if (/#pricing$/.test(h)) ILT.track('pricing_link', { where: where(a) });
  }, true);

  ['auxclick', 'contextmenu', 'touchstart'].forEach(function (ev) {
    d.addEventListener(ev, function (e) {
      var a = e.target.closest && e.target.closest('a[href*="buy.stripe.com"]'); if (a) tagStripeLink(a);
    }, { capture: true, passive: true });
  });

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

  // scroll depth + real reading time, sent to GA4 only (named events, so they show up in Events and funnels with no extra setup)
  function engagement() {
    if (/^\/(members|thankyou|api)/.test(location.pathname)) return;
    var sent = {};
    function once(name) { if (sent[name] || !GA.on) return; sent[name] = 1; gt('event', name, {}); }
    var tick = 0;
    function onScroll() {
      if (tick) return; tick = 1;
      setTimeout(function () {
        tick = 0;
        var el = d.documentElement, h = Math.max(el.scrollHeight - w.innerHeight, 1), p = (w.pageYOffset || el.scrollTop || 0) / h * 100;
        [25, 50, 75, 90].forEach(function (m) { if (p >= m) once('scroll_' + m); });
      }, 200);
    }
    w.addEventListener('scroll', onScroll, { passive: true });
    var secs = 0;
    var iv = setInterval(function () {
      if (d.visibilityState !== 'visible') return;
      secs++;
      if (secs === 30) once('time_30s'); else if (secs === 60) once('time_60s'); else if (secs === 120) { once('time_120s'); clearInterval(iv); }
    }, 1000);
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
      ILT.track(name, { plan: info.plan || 'unknown', value: value, currency: cur, transaction_id: sid || undefined }, kind === 'purchase' ? 'purchase' : 'trial', params);
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

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', function () { watch(); engagement(); conversion(); });
  else { watch(); engagement(); conversion(); }
})();
