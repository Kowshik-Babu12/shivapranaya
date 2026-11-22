/* Vercel serverless function: /api/suggest  (place finder + photo proxy, no AI)
   Used by Plan AI as the backup when the AI service is unavailable, and for Google photos.
   - Verifies the Firebase ID token (only the two allowed e-mails)
   - POST { lat, lng, message?, cats?, radiusKm? } -> { reply, places, links, cats, source }
   - GET  ?photo=places/xxx/photos/yyy             -> image bytes (only if GOOGLE_PLACES_KEY is set)
   - GET  ?health=1                                -> status, no secrets
   If every map source is busy it still answers (200) with a Google Maps link instead of an error. */
const { PROJECT, GKEY, verify, timed, CAT_LIST, mapsLink, findPlaces, cardOf } = require('./_lib');

function ruleIntent(msg) {
  const s = msg.toLowerCase(), cats = [], has = re => re.test(s);
  if (has(/movie|film|cinema|theat(er|re)|watch/)) cats.push('Movies');
  if (has(/dinner|lunch|brunch|breakfast|restaurant|eat|food|biryani|hungry|meal/)) cats.push('Restaurants');
  if (has(/cafe|café|coffee|tea|dessert|bakery/)) cats.push('Cafes');
  if (has(/park|nature|garden|walk|lake|picnic|sunset/)) cats.push('Parks & nature');
  if (has(/mall|shopping|shop/)) cats.push('Malls');
  if (has(/trip|drive|getaway|weekend|day out/)) cats.push('Day trips');
  if (has(/visit|attraction|places|sightsee|temple|museum|fort|explore|date/) && !cats.length) cats.push('Attractions');
  const m = s.match(/(\d{1,3})\s*(?:km|kms|kilomet)/);
  return { cats, radiusKm: m ? Math.min(100, +m[1]) : null };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.health) return res.json({ ok: true, googlePlaces: !!GKEY, project: PROJECT });
  try { await verify(req); } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }

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
  const lat = +b.lat, lng = +b.lng, hasLoc = b.lat != null && b.lng != null && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2000) : '';
  const intent = message ? ruleIntent(message) : { cats: (b.cats || []).filter(c => CAT_LIST.includes(c)), radiusKm: null };
  const radiusKm = Math.max(1, Math.min(100, +(intent.radiusKm || b.radiusKm) || 10));

  if (!intent.cats.length) return res.json({ reply: 'What kind of outing? For example: a movie, a romantic dinner, a cosy cafe, a park or a day trip.', places: [], links: [], cats: [], radiusKm });
  if (!hasLoc) return res.json({ reply: 'I need your location to find places near you. Allow location for this site in your browser or phone settings, then ask again.', places: [], links: [], cats: [], radiusKm, needLoc: true });

  const cats = intent.cats.slice(0, 3), links = [];
  if (cats.includes('Movies')) links.push({ label: 'BookMyShow', url: 'https://in.bookmyshow.com/' }, { label: 'District', url: 'https://www.district.in/movies' });
  const r = await findPlaces({ cats, lat, lng, radiusKm });
  const places = r.places.map(cardOf);
  if (r.failed || !places.length) cats.forEach(c => links.push(mapsLink(c, lat, lng)));
  const reply = r.failed
    ? 'The free map data is busy right now, so I could not load places. Try again in a minute, or open Google Maps with the link below.'
    : places.length ? `Here ${places.length === 1 ? 'is 1 place' : 'are ' + places.length + ' places'} within ${radiusKm} km.` : `I couldn't find real places for that within ${radiusKm} km. Try a bigger range, or use the Google Maps link below.`;
  return res.json({ reply, places, links, cats, radiusKm, source: r.source, busy: r.failed || undefined });
}
module.exports = async (req, res) => {
  try { return await handler(req, res); }
  catch (e) { if (!res.headersSent) return res.status(500).json({ error: 'server', message: String(e && e.message || e).slice(0, 120) }); }
};
