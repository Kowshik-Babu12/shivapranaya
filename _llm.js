/* Tiny provider layer with tool calling. Every provider exposes:
     start({ system, history:[{role,text}], user, tools:[{name,description,schema}] }) -> conv
     conv.next()                      -> { text, calls:[{id,name,args}] }
     conv.feed(calls, resultStrings)  -> { text, calls }   (sends tool results, returns the model's next turn)
   Set at least one key in Vercel: ANTHROPIC_API_KEY, OPENAI_API_KEY (works with Groq / OpenRouter via OPENAI_BASE_URL) or GEMINI_API_KEY.
   PLAN_AI_PROVIDER=anthropic|openai|gemini picks the first one to try; the others (if keyed) are used as automatic backup. */
const { timed } = require('./_lib');

const safeJSON = s => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}); } catch (e) { return {}; } };
async function post(url, headers, body, ms) {
  const r = await timed(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, ms || 40000);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { }
  if (!r.ok) {
    const msg = (j && (j.error && (j.error.message || j.error) || j.message)) || txt.slice(0, 160);
    const err = new Error(`${r.status} ${String(msg).slice(0, 160)}`); err.status = r.status; throw err;
  }
  return j || {};
}
const modelErr = e => e && (e.status === 404 || (e.status === 400 && /model/i.test(e.message)));

/* ---------- Anthropic ---------- */
function anthropic(key) {
  const models = [process.env.ANTHROPIC_MODEL, 'claude-haiku-5-5', 'claude-sonnet-4-6'].filter(Boolean);
  return {
    name: 'anthropic',
    start({ system, history, user, tools }) {
      const msgs = [...history.map(h => ({ role: h.role, content: h.text })), { role: 'user', content: user }];
      const tl = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
      let mi = 0;
      const next = async () => {
        let j;
        for (;;) {
          try { j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model: models[mi], max_tokens: 1200, system, tools: tl, messages: msgs }); break; }
          catch (e) { if (modelErr(e) && mi < models.length - 1) { mi++; continue; } throw e; }
        }
        const c = j.content || [];
        msgs.push({ role: 'assistant', content: c });
        return { text: c.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), calls: c.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })) };
      };
      return { next, feed: (calls, res) => { msgs.push({ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: res[i] })) }); return next(); } };
    }
  };
}

/* ---------- OpenAI-compatible (OpenAI, Groq, OpenRouter, ...) ---------- */
function openai(key) {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return {
    name: 'openai',
    start({ system, history, user, tools }) {
      const msgs = [{ role: 'system', content: system }, ...history.map(h => ({ role: h.role, content: h.text })), { role: 'user', content: user }];
      const tl = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
      const next = async () => {
        const j = await post(base + '/chat/completions', { authorization: 'Bearer ' + key }, { model, messages: msgs, tools: tl, tool_choice: 'auto' });
        const m = j.choices && j.choices[0] && j.choices[0].message;
        if (!m) throw new Error('empty response');
        msgs.push(m);
        return { text: String(m.content || '').trim(), calls: (m.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, args: safeJSON(tc.function.arguments) })) };
      };
      return { next, feed: (calls, res) => { calls.forEach((c, i) => msgs.push({ role: 'tool', tool_call_id: c.id, content: res[i] })); return next(); } };
    }
  };
}

/* ---------- Gemini ---------- */
const up = s => { if (Array.isArray(s)) return s.map(up); if (s && typeof s === 'object') { const o = {}; for (const k in s) o[k] = k === 'type' && typeof s[k] === 'string' ? s[k].toUpperCase() : up(s[k]); return o; } return s; };
function gemini(key) {
  const models = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean);
  return {
    name: 'gemini',
    start({ system, history, user, tools }) {
      const contents = [...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })), { role: 'user', parts: [{ text: user }] }];
      const decl = tools.map(t => ({ name: t.name, description: t.description, parameters: up(t.schema) }));
      let mi = 0;
      const next = async () => {
        let j;
        for (;;) {
          try { j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${models[mi]}:generateContent`, { 'x-goog-api-key': key }, { systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: decl }] }); break; }
          catch (e) { if (modelErr(e) && mi < models.length - 1) { mi++; continue; } throw e; }
        }
        const cand = j.candidates && j.candidates[0], parts = (cand && cand.content && cand.content.parts) || [];
        if (!parts.length && j.promptFeedback && j.promptFeedback.blockReason) throw new Error('blocked ' + j.promptFeedback.blockReason);
        contents.push({ role: 'model', parts });
        return { text: parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n').trim(), calls: parts.filter(p => p.functionCall).map((p, i) => ({ id: 'g' + i, name: p.functionCall.name, args: p.functionCall.args || {} })) };
      };
      return { next, feed: (calls, res) => { contents.push({ role: 'user', parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: { result: res[i] } } })) }); return next(); } };
    }
  };
}

/* ---------- which providers are configured (preferred first) ---------- */
function providers() {
  const all = {};
  if (process.env.ANTHROPIC_API_KEY) all.anthropic = anthropic(process.env.ANTHROPIC_API_KEY);
  if (process.env.OPENAI_API_KEY) all.openai = openai(process.env.OPENAI_API_KEY);
  if (process.env.GEMINI_API_KEY) all.gemini = gemini(process.env.GEMINI_API_KEY);
  const first = (process.env.PLAN_AI_PROVIDER || '').toLowerCase();
  const order = [first, 'anthropic', 'openai', 'gemini'].filter((n, i, a) => n && a.indexOf(n) === i);
  return order.map(n => all[n]).filter(Boolean);
}
module.exports = { providers };
