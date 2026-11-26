// Cloudflare Pages Function: POST /api/vetrina
// Pubblica o ritira una festività ("Vetrina ...") su Shopify, togliendo o
// aggiungendo la riga "Stato: bozza" nella descrizione della collezione.
//
// Segreti da impostare in Cloudflare → flq-sito → Settings → Variables and Secrets:
//   PANNELLO_PIN           PIN conosciuto solo da chi gestisce il negozio (almeno 6 caratteri)
//   SHOPIFY_SHOP           es. 1263f5  (sottodominio .myshopify.com del negozio)
//   SHOPIFY_CLIENT_ID      } app creata nella Dev Dashboard di Shopify
//   SHOPIFY_CLIENT_SECRET  } (permesso: write_products)
//   SHOPIFY_ADMIN_TOKEN    (alternativa: token shpat_ di una vecchia app personalizzata)
//
// La funzione accetta SOLO collezioni il cui handle è "vetrina" o inizia con "vetrina-":
// non può modificare prodotti, prezzi, ordini o altre collezioni.

const API_VERSION = '2024-10';
const STATE_KEYS = '(?:stato|attiva|pubblica)';
let cachedToken = null; // { token, exp }

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function shopHost(env) {
  const s = String(env.SHOPIFY_SHOP || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return null;
  return s.endsWith('.myshopify.com') ? s : s + '.myshopify.com';
}

async function getToken(env, fetchFn) {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new Error('config');
  const r = await fetchFn('https://' + shopHost(env) + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }).toString()
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const d = await r.json();
  if (!d.access_token) throw new Error('token');
  cachedToken = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}

async function admin(env, fetchFn, query, variables) {
  const token = await getToken(env, fetchFn);
  const r = await fetchFn('https://' + shopHost(env) + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  if (r.status === 401) { cachedToken = null; throw new Error('auth'); }
  if (!r.ok) throw new Error('shopify ' + r.status);
  const d = await r.json();
  if (d.errors) throw new Error('graphql');
  return d.data;
}

// Toglie ogni riga "Stato: ..." / "Attiva: ..." / "Pubblica: ..." dalla descrizione
export function stripState(html) {
  let h = String(html || '');
  const K = STATE_KEYS;
  h = h.replace(new RegExp('<p[^>]*>\\s*' + K + '\\s*:[^<]*<\\/p>\\s*', 'gi'), '');            // <p>Stato: bozza</p>
  h = h.replace(new RegExp('(^|>|\\n)\\s*' + K + '\\s*:[^<\\n]*<br\\s*\\/?>\\s*', 'gi'), '$1');  // Stato: bozza<br>
  h = h.replace(new RegExp('<br\\s*\\/?>\\s*' + K + '\\s*:[^<\\n]*(?=<\\/|$)', 'gi'), '');        // <br>Stato: bozza</p>
  h = h.replace(new RegExp('(^|\\n)\\s*' + K + '\\s*:[^<\\n]*(\\n|$)', 'gi'), '$1');              // testo semplice
  h = h.replace(/<p[^>]*>\s*<\/p>/gi, '');
  return h.trim();
}

export function setDraft(html) {
  return '<p>Stato: bozza</p>' + stripState(html);
}

export async function onRequestPost({ request, env }, fetchFn = fetch) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Richiesta non valida' }, 400); }
  const { action, id, pin } = body || {};

  if (!env.PANNELLO_PIN || String(env.PANNELLO_PIN).length < 6 || !shopHost(env))
    return json({ ok: false, error: 'Pubblicazione non ancora attivata: mancano le impostazioni sul server.' }, 503);
  if (!safeEqual(pin, env.PANNELLO_PIN)) {
    await new Promise(r => setTimeout(r, 800)); // rallenta i tentativi a caso
    return json({ ok: false, error: 'PIN non corretto' }, 401);
  }
  if (action !== 'pubblica' && action !== 'ritira') return json({ ok: false, error: 'Azione non valida' }, 400);
  if (!/^gid:\/\/shopify\/Collection\/\d+$/.test(String(id || ''))) return json({ ok: false, error: 'Collezione non valida' }, 400);

  try {
    const d = await admin(env, fetchFn, 'query($id:ID!){ collection(id:$id){ id handle title descriptionHtml } }', { id });
    const col = d && d.collection;
    if (!col) return json({ ok: false, error: 'Collezione non trovata' }, 404);
    if (!(col.handle === 'vetrina' || col.handle.startsWith('vetrina-')))
      return json({ ok: false, error: 'Si possono pubblicare solo le collezioni "Vetrina…"' }, 403);

    const descriptionHtml = action === 'pubblica' ? stripState(col.descriptionHtml) : setDraft(col.descriptionHtml);
    const u = await admin(env, fetchFn,
      'mutation($input:CollectionInput!){ collectionUpdate(input:$input){ collection{ id handle } userErrors{ field message } } }',
      { input: { id, descriptionHtml } });
    const errs = u && u.collectionUpdate && u.collectionUpdate.userErrors;
    if (errs && errs.length) return json({ ok: false, error: errs.map(e => e.message).join('; ') }, 422);
    return json({ ok: true, action, handle: col.handle, title: col.title });
  } catch (e) {
    const m = String(e && e.message || '');
    if (m === 'config') return json({ ok: false, error: 'Pubblicazione non ancora attivata: manca la chiave Shopify sul server.' }, 503);
    if (m === 'auth' || m.startsWith('token')) return json({ ok: false, error: 'Shopify ha rifiutato la chiave di accesso: va rigenerata.' }, 502);
    return json({ ok: false, error: 'Shopify non risponde, riprova tra poco.' }, 502);
  }
}

export function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  return json({ ok: false, error: 'Metodo non consentito' }, 405);
}
