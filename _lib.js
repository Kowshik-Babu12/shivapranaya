/* Shared helpers for api/suggest.js and api/plan-ai.js (underscore = not a public endpoint)
   - Firebase ID-token check (only the two allowed e-mails)
   - Place search: Google Places (optional key) -> OpenStreetMap (several mirrors, widening radius, cache) -> Nominatim
   findPlaces() never throws: it returns { places, failed, source } so callers can always answer. */
const crypto = require('crypto');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'akkabava';
const ALLOWED = (process.env.ALLOWED_EMAILS || 'pranaya.samala15@gmail.com,spranaya04@gmail.com')
  .split(',').map(s => s.trim().toLowerCase());
const GKEY = process.env.GOOGLE_PLACES_KEY || '';

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

/* ---------- small helpers ---------- */
const rad = d => d * Math.PI / 180;
function km(a, b, c, d) {
  const x = rad(c - a), y = rad(d - b);
  const h = Math.sin(x / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(y / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const r1 = n => Math.round(n * 10) / 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function timed(url, opt, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 15000);
  try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(t); }
}
const CAT_LIST = ['Movies', 'Restaurants', 'Cafes', 'Parks & nature', 'Attractions', 'Malls', 'Day trips'];
const TYPE_LABEL = { Movies: 'Cinema', Restaurants: 'Restaurant', Cafes: 'Cafe', 'Parks & nature': 'Park', Attractions: 'Attraction', Malls: 'Mall', 'Day trips': 'Day trip' };
const MAPS_Q = { Movies: 'cinema', Restaurants: 'restaurants', Cafes: 'cafes', 'Parks & nature': 'parks', Attractions: 'tourist attractions', Malls: 'shopping malls', 'Day trips': 'day trip places' };
function mapsLink(cat, lat, lng) {
  const q = encodeURIComponent(MAPS_Q[cat] || 'places') + (lat != null && lng != null ? `/@${(+lat).toFixed(5)},${(+lng).toFixed(5)},13z` : '');
  return { label: 'Search ' + (MAPS_Q[cat] || 'places') + ' on Google Maps', url: 'https://www.google.com/maps/search/' + q };
}

/* ---------- Google Places (New), optional ---------- */
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

/* ---------- OpenStreetMap (free) ---------- */
const OSM = {
  Movies: ['["amenity"="cinema"]'], Restaurants: ['["amenity"="restaurant"]'], Cafes: ['["amenity"="cafe"]'],
  'Parks & nature': ['["leisure"~"^(park|garden|nature_reserve)$"]'],
  Attractions: ['["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery)$"]', '["historic"~"^(monument|fort|castle|temple)$"]'],
  Malls: ['["shop"="mall"]'],
  'Day trips': ['["tourism"~"^(attraction|viewpoint|zoo|theme_park)$"]', '["leisure"="water_park"]']
};
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const UA = 'pranaya-shiva-app/1.1 (private couple app)';
async function overpass(cat, lat, lng, radiusKm) {
  const R = Math.round(radiusKm * 1000);
  // nw (not nwr): relations are slow and rarely needed here
  const q = '[out:json][timeout:8];(' + OSM[cat].map(t => `nw${t}(around:${R},${lat},${lng});`).join('') + ');out center 60;';
  const one = async base => {
    const r = await timed(base, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'application/json' }, body: 'data=' + encodeURIComponent(q) }, 9000);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();            // an HTML error page / "runtime error" remark counts as a failure
    if (!j || !Array.isArray(j.elements)) throw new Error('bad body');
    return j;
  };
  let j;
  try { j = await Promise.any(OVERPASS.map(one)); }          // fastest mirror wins
  catch (e) { throw new Error('overpass ' + (e.errors && e.errors[0] ? e.errors[0].message : 'failed')); }
  const seen = new Set();
  return j.elements.map(e => {
    const t = e.tags || {}, la = e.lat ?? (e.center && e.center.lat), ln = e.lon ?? (e.center && e.center.lon);
    const name = t.name || t['name:en'];
    if (!name || la == null || ln == null) return null;
    const key = name.toLowerCase() + '|' + la.toFixed(3) + '|' + ln.toFixed(3);
    if (seen.has(key)) return null; seen.add(key);
    return { id: e.type + e.id, name, type: TYPE_LABEL[cat], cat, lat: la, lng: ln, km: r1(km(lat, lng, la, ln)),
      rating: null, reviews: 0, budget: '', address: [t['addr:street'], t['addr:city']].filter(Boolean).join(', '),
      openNow: null, url: '', photo: '', revs: [], hours: t.opening_hours || '', src: 'osm' };
  }).filter(Boolean).sort((a, b) => a.km - b.km);
}
/* Small circle first (fast, nearest results), widen only while there are few results. */
async function overpassSmart(cat, lat, lng, radiusKm, deadline) {
  const steps = [...new Set([3, 8, 20, 50, 100].filter(r => r < radiusKm).concat([radiusKm]))];
  let best = [], ok = false, lastErr = null;
  for (let i = 0; i < steps.length; i++) {
    if (ok && Date.now() > deadline) break;
    let list = null;
    for (let attempt = 0; attempt < (ok ? 1 : 2) && list == null; attempt++) {
      try { list = await overpass(cat, lat, lng, steps[i]); }
      catch (e) { lastErr = e; if (!ok && attempt === 0 && Date.now() < deadline - 9000) await sleep(700); }
    }
    if (list == null) { if (ok) break; throw lastErr || new Error('overpass failed'); }
    ok = true; best = list;
    if (best.length >= 8) break;
  }
  return best;
}

const NOM_Q = { Movies: 'cinema', Restaurants: 'restaurant', Cafes: 'cafe', 'Parks & nature': 'park', Attractions: 'tourist attraction', Malls: 'shopping mall', 'Day trips': 'tourist attraction' };
async function nominatim(cat, lat, lng, radiusKm) {
  const dy = radiusKm / 111, dx = radiusKm / (111 * Math.max(0.2, Math.cos(rad(lat))));
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&viewbox=' + [lng - dx, lat + dy, lng + dx, lat - dy].join(',') + '&q=' + encodeURIComponent(NOM_Q[cat]);
  const r = await timed(url, { headers: { 'user-agent': UA, 'accept-language': 'en' } }, 8000);
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

/* ---------- cache (lives while the serverless instance is warm) ---------- */
const cache = new Map();
const ckey = (cat, lat, lng, r) => [cat, lat.toFixed(2), lng.toFixed(2), r].join('|');
function cacheGet(cat, lat, lng, r) {
  const e = cache.get(ckey(cat, lat, lng, r));
  if (!e || Date.now() - e.t > 30 * 60e3) return null;
  return e.list.map(p => ({ ...p, km: r1(km(lat, lng, p.lat, p.lng)) })).sort((a, b) => a.km - b.km);
}
function cachePut(cat, lat, lng, r, list) {
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(ckey(cat, lat, lng, r), { t: Date.now(), list });
}

const plain = (p, max) => p.slice(0, max).map(x => ({ ...x, why: x.rating ? `Rated ${x.rating}/5 by ${x.reviews} people on Google, ${x.km} km away.` : `${x.km} km away.`, summary: '' }));

/* ---------- main place finder (never throws) ---------- */
async function findPlaces({ cats, lat, lng, radiusKm, per, budgetMs }) {
  const deadline = Date.now() + (budgetMs || 24000);
  cats = (cats || []).filter(c => CAT_LIST.includes(c)).slice(0, 3);
  radiusKm = Math.max(1, Math.min(100, +radiusKm || 10));
  per = per || (cats.length === 1 ? 8 : cats.length === 2 ? 5 : 4);
  const places = [], errors = [];
  let okCats = 0, source = GKEY ? 'google' : 'osm';
  await Promise.all(cats.map(async cat => {
    let list = cacheGet(cat, lat, lng, radiusKm), failed = false;
    if (!list && GKEY) { try { list = await googlePlaces(cat, lat, lng, radiusKm, cat === 'Cafes' || cat === 'Restaurants'); } catch (e) { errors.push(String(e.message || e)); } }
    if (!list) { try { list = await overpassSmart(cat, lat, lng, radiusKm, deadline); source = 'osm'; } catch (e) { list = null; failed = true; errors.push(String(e.message || e)); } }
    if ((!list || !list.length) && Date.now() < deadline) {
      try { const l2 = await nominatim(cat, lat, lng, radiusKm); if (l2.length || !list) { list = l2; source = 'osm'; failed = false; } }
      catch (e) { errors.push(String(e.message || e)); }
    }
    if (list == null) return;
    okCats++;
    if (list.length) cachePut(cat, lat, lng, radiusKm, list);
    list = list.filter(p => p.km <= radiusKm + 0.5);
    if (cat === 'Cafes' || cat === 'Restaurants') list = list.filter(p => p.rating == null || p.rating >= 3.5 || p.reviews < 10);
    places.push(...plain(list.slice(0, 15), per).slice(0, per));
  }));
  return { places, failed: okCats === 0 && cats.length > 0, source, errors: [...new Set(errors)].slice(0, 4), radiusKm, cats };
}

/* shape sent to the browser (cards) */
const cardOf = p => ({
  name: p.name, type: p.type, km: p.km, lat: p.lat, lng: p.lng, budget: p.budget || '', best: '', why: p.why || '',
  summary: p.summary || '', rating: p.rating, reviews: p.reviews, openNow: p.openNow, address: p.address || '',
  url: p.url || '', photo: p.photo || '', photoBy: p.photoBy || '', src: p.src
});

module.exports = { PROJECT, ALLOWED, GKEY, verify, km, r1, timed, sleep, CAT_LIST, TYPE_LABEL, mapsLink, findPlaces, cardOf, overpass, nominatim, OVERPASS };
