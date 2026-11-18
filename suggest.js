/* Vercel serverless function: /api/suggest
   - Verifies the Firebase ID token (only the two allowed emails)
   - POST { lat, lng, message?, cats?, radiusKm?, mood?, history? }  -> { reply, places, links, cats, source }
   - GET  ?photo=places/xxx/photos/yyy                              -> image bytes (Google photo proxy)
   Data: Google Places (New) if GOOGLE_PLACES_KEY is set, else OpenStreetMap (Overpass).
   AI:   any of Gemini (GEMINI_API_KEY), Claude (ANTHROPIC_API_KEY), ChatGPT (OPENAI_API_KEY); first one that answers is used.
   GET /api/suggest?health=1 -> shows which keys are configured (no secrets).
   Nothing is invented: showtimes are never returned, only links to BookMyShow / District. */
const crypto = require('crypto');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'akkabava';
const ALLOWED = (process.env.ALLOWED_EMAILS || 'pranaya.samala15@gmail.com,spranaya04@gmail.com')
  .split(',').map(s => s.trim().toLowerCase());
const GKEY = process.env.GOOGLE_PLACES_KEY || '';
const GEMINI = process.env.GEMINI_API_KEY || '';
const MODELS = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean);
const ANTH = process.env.ANTHROPIC_API_KEY || '', OPENAI = process.env.OPENAI_API_KEY || '';
const HAS_LLM = !!(GEMINI || ANTH || OPENAI);

/* ---------- Firebase ID token verification ---------- */
let certCache = { t: 0, certs: null };
async function getCerts() {
  if (certCache.certs && Date.now() - certCache.t < 3600e3) return certCache.certs;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Error('certs ' + r.status);
  certCache = { t: Date.now(), certs: await r.json() };
  return certCache.certs;
}
const b64j = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
async function verify(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const parts = tok.split('.');
  if (parts.length !== 3) throw new Error('no token');
  const head = b64j(parts[0]), pay = b64j(parts[1]);
  if (head.alg !== 'RS256') throw new Error('alg');
  const pem = (await getCerts())[head.kid];
  if (!pem) throw new Error('kid');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(pem, Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || pay.aud !== PROJECT || pay.iss !== 'https://securetoken.google.com/' + PROJECT ||
      pay.exp < now || pay.iat > now + 300 || !pay.sub) throw new Error('bad token');
  if (!pay.email || !ALLOWED.includes(String(pay.email).toLowerCase())) throw new Error('not allowed');
  return pay;
}

/* ---------- helpers ---------- */
const rad = d => d * Math.PI / 180;
function km(a, b, c, d) {
  const x = rad(c - a), y = rad(d - b);
  const h = Math.sin(x / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(y / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const r1 = n => Math.round(n * 10) / 10;
async function timed(url, opt, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 15000);
  try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(t); }
}
const CAT_LIST = ['Movies', 'Restaurants', 'Cafes', 'Parks & nature', 'Attractions', 'Malls', 'Day trips'];
const TYPE_LABEL = { Movies: 'Cinema', Restaurants: 'Restaurant', Cafes: 'Cafe', 'Parks & nature': 'Park', Attractions: 'Attraction', Malls: 'Mall', 'Day trips': 'Day trip' };

/* ---------- Google Places (New) ---------- */
const G_TYPES = {
  Movies: ['movie_theater'], Restaurants: ['restaurant'], Cafes: ['cafe', 'coffee_shop'],
  'Parks & nature': ['park', 'national_park', 'botanical_garden'],
  Attractions: ['tourist_attraction', 'museum', 'art_gallery'], Malls: ['shopping_mall'],
  'Day trips': ['tourist_attraction', 'amusement_park', 'zoo', 'park']
};
const PRICE = { PRICE_LEVEL_FREE: 'Free', PRICE_LEVEL_INEXPENSIVE: '₹', PRICE_LEVEL_MODERATE: '₹₹', PRICE_LEVEL_EXPENSIVE: '₹₹₹', PRICE_LEVEL_VERY_EXPENSIVE: '₹₹₹₹' };
async function googlePlaces(cat, lat, lng, radiusKm, withReviews) {
  const fields = ['places.id', 'places.displayName', 'places.location', 'places.rating', 'places.userRatingCount',
    'places.priceLevel', 'places.primaryTypeDisplayName', 'places.formattedAddress', 'places.googleMapsUri',
    'places.regularOpeningHours.openNow', 'places.photos'];
  if (withReviews) fields.push('places.reviews');
  const r = await timed('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': GKEY, 'X-Goog-FieldMask': fields.join(',') },
    body: JSON.stringify({
      includedTypes: G_TYPES[cat], maxResultCount: 20, rankPreference: 'POPULARITY',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, radiusKm * 1000) } }
    })
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  return (j.places || []).filter(p => p.location && p.displayName).map(p => ({
    id: p.id, name: p.displayName.text, type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || TYPE_LABEL[cat],
    cat, lat: p.location.latitude, lng: p.location.longitude,
    km: r1(km(lat, lng, p.location.latitude, p.location.longitude)),
    rating: p.rating || null, reviews: p.userRatingCount || 0, budget: PRICE[p.priceLevel] || '',
    address: p.formattedAddress || '', openNow: p.regularOpeningHours ? p.regularOpeningHours.openNow : null,
    url: p.googleMapsUri || '', photo: p.photos && p.photos[0] ? p.photos[0].name : '',
    photoBy: p.photos && p.photos[0] && p.photos[0].authorAttributions && p.photos[0].authorAttributions[0] ? p.photos[0].authorAttributions[0].displayName : '',
    revs: (p.reviews || []).slice(0, 5).map(v => ({ by: v.authorAttribution && v.authorAttribution.displayName || '', r: v.rating, t: v.text && v.text.text || '' })).filter(v => v.t),
    src: 'google'
  }));
}

/* ---------- OpenStreetMap (free fallback) ---------- */
const OSM = {
  Movies: ['["amenity"="cinema"]'], Restaurants: ['["amenity"="restaurant"]'], Cafes: ['["amenity"="cafe"]'],
  'Parks & nature': ['["leisure"~"^(park|garden|nature_reserve)$"]'],
  Attractions: ['["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery)$"]', '["historic"~"^(monument|fort|castle|temple)$"]'],
  Malls: ['["shop"="mall"]'],
  'Day trips': ['["tourism"~"^(attraction|viewpoint|zoo|theme_park)$"]', '["leisure"="water_park"]']
};
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function overpass(cat, lat, lng, radiusKm) {
  const R = Math.round(radiusKm * 1000);
  const q = '[out:json][timeout:20];(' + OSM[cat].map(t => `nwr${t}(around:${R},${lat},${lng});`).join('') + ');out center 80;';
  let last = 'none';
  for (const base of OVERPASS) {
    try {
      const r = await timed(base, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'pranaya-shiva-app/1.0' }, body: 'data=' + encodeURIComponent(q) }, 22000);
      if (!r.ok) { last = r.status; continue; }
      const j = await r.json();
      const seen = new Set();
      return (j.elements || []).map(e => {
        const t = e.tags || {}, la = e.lat ?? (e.center && e.center.lat), ln = e.lon ?? (e.center && e.center.lon);
        if (!t.name || la == null || ln == null) return null;
        const key = t.name.toLowerCase() + '|' + la.toFixed(3) + '|' + ln.toFixed(3);
        if (seen.has(key)) return null; seen.add(key);
        return { id: e.type + e.id, name: t.name, type: TYPE_LABEL[cat], cat, lat: la, lng: ln, km: r1(km(lat, lng, la, ln)),
          rating: null, reviews: 0, budget: '', address: [t['addr:street'], t['addr:city']].filter(Boolean).join(', '),
          openNow: null, url: '', photo: '', revs: [], hours: t.opening_hours || '', src: 'osm' };
      }).filter(Boolean).sort((a, b) => a.km - b.km);
    } catch (e) { last = e.name === 'AbortError' ? 'timeout' : String(e.message || e); }
  }
  throw new Error('overpass ' + last);
}

/* ---------- Nominatim (second free fallback if Overpass is down) ---------- */
const NOM_Q = { Movies: 'cinema', Restaurants: 'restaurant', Cafes: 'cafe', 'Parks & nature': 'park', Attractions: 'tourist attraction', Malls: 'shopping mall', 'Day trips': 'tourist attraction' };
async function nominatim(cat, lat, lng, radiusKm) {
  const dy = radiusKm / 111, dx = radiusKm / (111 * Math.max(0.2, Math.cos(rad(lat))));
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&viewbox=' + [lng - dx, lat + dy, lng + dx, lat - dy].join(',') + '&q=' + encodeURIComponent(NOM_Q[cat]);
  const r = await timed(url, { headers: { 'user-agent': 'pranaya-shiva-app/1.0', 'accept-language': 'en' } }, 15000);
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const seen = new Set();
  return (await r.json()).map(e => {
    const la = +e.lat, ln = +e.lon, name = e.name || (e.display_name || '').split(',')[0];
    if (!name || !isFinite(la) || !isFinite(ln)) return null;
    const key = name.toLowerCase() + '|' + la.toFixed(3); if (seen.has(key)) return null; seen.add(key);
    return { id: 'n' + e.place_id, name, type: TYPE_LABEL[cat], cat, lat: la, lng: ln, km: r1(km(lat, lng, la, ln)), rating: null, reviews: 0, budget: '',
      address: (e.display_name || '').split(',').slice(1, 3).join(',').trim(), openNow: null, url: '', photo: '', revs: [], src: 'osm' };
  }).filter(Boolean).sort((a, b) => a.km - b.km);
}

/* ---------- LLMs: Gemini, Claude, ChatGPT (each optional; first that answers wins) ---------- */
function parseJson(txt) {
  if (!txt) return null;
  const t = String(txt).replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (e) { }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { } }
  return null;
}
async function viaGemini(prompt) {
  for (const m of MODELS) {
    try {
      const r = await timed(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } })
      }, 20000);
      if (!r.ok) continue;
      const j = await r.json();
      const out = parseJson(j.candidates && j.candidates[0] && j.candidates[0].content.parts.map(p => p.text || '').join(''));
      if (out) return out;
    } catch (e) { /* next model */ }
  }
  return null;
}
async function viaClaude(prompt) {
  try {
    const r = await timed('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTH, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt + '\n\nReply with the JSON object only.' }] })
    }, 25000);
    if (!r.ok) return null;
    const j = await r.json();
    return parseJson(j.content && j.content.map(c => c.text || '').join(''));
  } catch (e) { return null; }
}
async function viaOpenAI(prompt) {
  try {
    const r = await timed('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + OPENAI },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.3, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt + '\n\nReply with a JSON object only.' }] })
    }, 25000);
    if (!r.ok) return null;
    const j = await r.json();
    return parseJson(j.choices && j.choices[0] && j.choices[0].message.content);
  } catch (e) { return null; }
}
async function gemini(prompt) {   /* name kept: runs every configured LLM in turn */
  const chain = [];
  if (GEMINI) chain.push(viaGemini); if (ANTH) chain.push(viaClaude); if (OPENAI) chain.push(viaOpenAI);
  for (const f of chain) { const out = await f(prompt); if (out) return out; }
  return null;
}

/* ---------- understanding the chat message ---------- */
function ruleIntent(msg) {
  const s = msg.toLowerCase(), cats = [];
  const has = re => re.test(s);
  if (has(/movie|film|cinema|theat(er|re)|watch/)) cats.push('Movies');
  if (has(/dinner|lunch|brunch|breakfast|restaurant|eat|food|biryani|hungry|meal/)) cats.push('Restaurants');
  if (has(/cafe|café|coffee|tea|dessert|bakery/)) cats.push('Cafes');
  if (has(/park|nature|garden|walk|lake|picnic|sunset/)) cats.push('Parks & nature');
  if (has(/mall|shopping|shop/)) cats.push('Malls');
  if (has(/trip|drive|getaway|weekend|day out/)) cats.push('Day trips');
  if (has(/visit|attraction|places|sightsee|temple|museum|fort|explore|date/) && !cats.length) cats.push('Attractions');
  let budget = null, m = s.match(/(?:under|below|within|budget(?: of)?|upto|up to|less than)\s*(?:rs\.?|inr|₹)?\s*(\d[\d,]*)/);
  if (m) budget = parseInt(m[1].replace(/,/g, ''), 10);
  let rk = null; m = s.match(/(\d{1,3})\s*(?:km|kms|kilomet)/); if (m) rk = Math.min(100, +m[1]);
  return { cats, budget, radiusKm: rk, mood: msg.slice(0, 120) };
}
async function understand(msg, history) {
  const base = ruleIntent(msg);
  const ai = await gemini(
    'You help a couple plan outings in India. Read the latest message (and short history) and answer ONLY JSON: ' +
    '{"cats":[any of ' + JSON.stringify(CAT_LIST) + '],"budget":number|null (INR for two, if stated),"radiusKm":number|null,' +
    '"mood":"short phrase","chatOnly":boolean (true if they are just chatting and want no place search),"reply":"one friendly sentence"}.\n' +
    'History: ' + JSON.stringify((history || []).slice(-6)) + '\nLatest: ' + JSON.stringify(msg));
  if (ai && Array.isArray(ai.cats)) {
    return {
      cats: ai.cats.filter(c => CAT_LIST.includes(c)).length ? ai.cats.filter(c => CAT_LIST.includes(c)) : base.cats,
      budget: typeof ai.budget === 'number' ? ai.budget : base.budget,
      radiusKm: typeof ai.radiusKm === 'number' ? Math.min(100, ai.radiusKm) : base.radiusKm,
      mood: String(ai.mood || base.mood).slice(0, 120), chatOnly: !!ai.chatOnly, reply: String(ai.reply || '').slice(0, 300)
    };
  }
  return { ...base, chatOnly: false, reply: '' };
}

/* ---------- ranking / summaries ---------- */
async function enrich(places, ctx) {
  const rows = places.map((p, i) => ({ i, name: p.name, type: p.type, km: p.km, rating: p.rating, ratingCount: p.reviews, price: p.budget || null, openNow: p.openNow, hours: p.hours || null, reviews: p.revs.map(v => v.t.slice(0, 300)) }));
  const ai = await gemini(
    'Rank these REAL nearby places for a couple. Use ONLY the facts given (distance, rating, price, hours, review text). Never invent menu items, prices, showtimes or facts. ' +
    (ctx.budget ? 'Budget for two is about INR ' + ctx.budget + '; prefer places whose price level fits, and say nothing about exact prices. ' : '') +
    'Mood/request: ' + JSON.stringify(ctx.mood || '') + '. Return ONLY JSON: {"items":[{"i":number,"why":"one short fact-based sentence","summary":"1-2 sentence summary of the review texts, or empty if none"}]} best first, at most ' + ctx.max + ' items.\nPLACES: ' + JSON.stringify(rows));
  if (!ai || !Array.isArray(ai.items)) return null;
  const out = [], used = new Set();
  for (const it of ai.items) {
    if (!Number.isInteger(it.i) || !places[it.i] || used.has(it.i)) continue;
    used.add(it.i);
    out.push({ ...places[it.i], why: String(it.why || '').slice(0, 220), summary: String(it.summary || '').slice(0, 320) });
  }
  return out.length ? out : null;
}
const plain = (p, max) => p.slice(0, max).map(x => ({ ...x, why: x.rating ? `Rated ${x.rating}/5 by ${x.reviews} people on Google, ${x.km} km away.` : `${x.km} km away.`, summary: '' }));

/* ---------- main ---------- */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.health) {
    return res.json({ ok: true, googlePlaces: !!GKEY, gemini: !!GEMINI, claude: !!ANTH, chatgpt: !!OPENAI, project: PROJECT });
  }
  try { await verify(req); } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }

  /* Google photo proxy (keeps the API key on the server) */
  if (req.method === 'GET') {
    const name = String((req.query && req.query.photo) || '');
    if (!GKEY || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) return res.status(404).end();
    try {
      const r = await timed(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=480&key=${GKEY}`, { redirect: 'follow' }, 15000);
      if (!r.ok) return res.status(502).end();
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { return res.status(502).end(); }
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, GET'); return res.status(405).json({ error: 'POST only' }); }

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  const lat = +b.lat, lng = +b.lng;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'location' });
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 500) : '';
  let ctx;
  if (message) ctx = await understand(message, Array.isArray(b.history) ? b.history : []);
  else ctx = { cats: (b.cats || []).filter(c => CAT_LIST.includes(c)), budget: null, radiusKm: null, mood: String(b.mood || '').slice(0, 120), chatOnly: false, reply: '' };
  const radiusKm = Math.max(1, Math.min(100, +(ctx.radiusKm || b.radiusKm) || 10));

  if (message && ctx.chatOnly && !ctx.cats.length) {
    return res.json({ reply: ctx.reply || 'Tell me what you feel like doing: a movie, dinner, a cafe, a park…', places: [], links: [], cats: [], radiusKm });
  }
  if (!ctx.cats.length) {
    return res.json({ reply: 'What kind of outing? For example: a movie, a romantic dinner, a cosy cafe, a park or a day trip.', places: [], links: [], cats: [], radiusKm });
  }

  const cats = ctx.cats.slice(0, 3);
  const links = [];
  if (cats.includes('Movies')) {
    links.push({ label: 'BookMyShow', url: 'https://in.bookmyshow.com/' }, { label: 'District', url: 'https://www.district.in/movies' });
  }
  const perCat = cats.length === 1 ? 8 : cats.length === 2 ? 5 : 4;
  let source = GKEY ? 'google' : 'osm', note = '';
  const all = [];
  await Promise.all(cats.map(async cat => {
    let list = null;
    if (GKEY) { try { list = await googlePlaces(cat, lat, lng, radiusKm, cat === 'Cafes' || cat === 'Restaurants'); } catch (e) { note = 'google'; } }
    if (!list) { try { list = await overpass(cat, lat, lng, radiusKm); source = 'osm'; } catch (e) { list = null; note = 'osm'; } }
    if (!list || !list.length) { try { const l2 = await nominatim(cat, lat, lng, radiusKm); if (l2.length || !list) { list = l2; source = 'osm'; } } catch (e) { if (!list) note = 'osm'; } }
    if (list == null) return;
    list = list.filter(p => p.km <= radiusKm + 0.5);
    if (cat === 'Cafes' || cat === 'Restaurants') list = list.filter(p => p.rating == null || p.rating >= 3.5 || p.reviews < 10);
    list = list.slice(0, 15);
    const ranked = HAS_LLM ? await enrich(list, { mood: ctx.mood, budget: ctx.budget, max: perCat }) : null;
    all.push(...(ranked || plain(list, perCat)).slice(0, perCat));
  }));

  if (!all.length && note) return res.status(503).json({ error: 'search ' + note });
  const places = all.map(p => ({
    name: p.name, type: p.type, km: p.km, lat: p.lat, lng: p.lng, budget: p.budget || '', best: '', why: p.why || '',
    summary: p.summary || '', rating: p.rating, reviews: p.reviews, openNow: p.openNow, address: p.address || '',
    url: p.url || '', photo: p.photo || '', photoBy: p.photoBy || '', src: p.src
  }));
  const reply = (ctx.reply && message ? ctx.reply + ' ' : '') + (places.length
    ? `Here ${places.length === 1 ? 'is 1 place' : 'are ' + places.length + ' places'} within ${radiusKm} km.`
    : `I couldn't find real places for that within ${radiusKm} km. Try a bigger range.`);
  return res.json({ reply: reply.trim(), places, links, cats, radiusKm, source });
};
