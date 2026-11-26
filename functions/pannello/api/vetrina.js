// Cloudflare Pages Function: POST /pannello/api/vetrina
// Crea, modifica, pubblica o ritira una festività ("Vetrina ...") su Shopify, togliendo o
// aggiungendo la riga "Stato: bozza" nella descrizione della collezione.
//
// Segreti da impostare in Cloudflare → flq-sito → Settings → Variables and Secrets:
//   PANNELLO_PIN           PIN conosciuto solo da chi gestisce il negozio (almeno 6 caratteri)
//   SHOPIFY_SHOP           es. 1263f5  (sottodominio .myshopify.com del negozio)
//   SHOPIFY_CLIENT_ID      } app creata nella Dev Dashboard di Shopify
//   SHOPIFY_CLIENT_SECRET  } (permessi: write_products, read_publications, write_publications)
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

// ── Impostazioni scritte dal pannello (crea / salva) ──
const FIELDS = [ // [chiave nel pannello, etichetta nella descrizione, lunghezza massima]
  ['titolo', 'Titolo', 80], ['titolo2', 'Titolo evidenziato', 80], ['testo', 'Testo', 200],
  ['fascia', 'Fascia', 120], ['sezione', 'Sezione', 80], ['inizio', 'Inizio', 16], ['fine', 'Fine', 16], ['colore', 'Colore', 20]
];
const COLORI = ['natale','rosso','black friday','nero','oro','san valentino','rosa','verde','blu','bordeaux'];
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2})?$/;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const escHtml = t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Ritorna { html } oppure { error }
export function buildDescription(f, bozza) {
  f = f || {};
  const lines = [];
  for (const [k, label, max] of FIELDS) {
    const v = clean(f[k], max);
    if (!v) continue;
    if ((k === 'inizio' || k === 'fine') && !DATE_RE.test(v)) return { error: 'La data di ' + label + ' va scritta come 01/12/2026 (ora facoltativa: 01/12/2026 18:00)' };
    if (k === 'colore' && !/^#[0-9a-f]{6}$/i.test(v) && !COLORI.includes(v.toLowerCase())) return { error: 'Colore non riconosciuto' };
    lines.push('<p>' + label + ': ' + escHtml(v) + '</p>');
  }
  if (!lines.length) return { error: 'Scrivete almeno il titolo o la fascia' };
  return { html: (bozza ? '<p>Stato: bozza</p>' : '') + lines.join('') };
}

export function slugify(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

const isVetrina = h => h === 'vetrina' || String(h || '').startsWith('vetrina-');
const isBozza = html => new RegExp('(^|>|\\n)\\s*' + STATE_KEYS + '\\s*:\\s*(bozza|no\\b|spent|disattiv|pausa)', 'i').test(String(html || ''));

async function headlessPublicationId(env, fetchFn) {
  if (env.SHOPIFY_PUBLICATION_ID) return env.SHOPIFY_PUBLICATION_ID;
  const d = await admin(env, fetchFn, '{ publications(first: 25) { nodes { id name } } }');
  const list = (d && d.publications && d.publications.nodes) || [];
  const hit = list.find(p => /headless/i.test(p.name)) || null;
  return hit && hit.id;
}

// ── PREZZO e PREZZO BARRATO di un prodotto (prima variante) ──
// Il prezzo barrato deve essere il più basso degli ultimi 30 giorni (art. 17-bis Codice del Consumo):
// senza la conferma esplicita di chi lo inserisce non viene salvato.
export function checkPrezzo(prezzo, barrato, conferma30) {
  const num = v => (v === null || v === undefined || v === '') ? null : Number(String(v).replace(',', '.'));
  const p = num(prezzo), b = num(barrato);
  if (!(p > 0) || p > 1000000) return { error: 'Prezzo non valido' };
  if (b !== null && !(b > 0)) return { error: 'Prezzo barrato non valido' };
  if (b !== null && b <= p) return { error: 'Il prezzo barrato deve essere più alto del prezzo di vendita' };
  if (b !== null && conferma30 !== true) return { error: 'Confermate che il prezzo barrato è il più basso degli ultimi 30 giorni' };
  return { price: p.toFixed(2), compareAtPrice: b === null ? null : b.toFixed(2) };
}
async function cambiaPrezzo(env, fetchFn, { id, prezzo, barrato, conferma30 }) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(String(id || ''))) return json({ ok: false, error: 'Prodotto non valido' }, 400);
  const c = checkPrezzo(prezzo, barrato, conferma30);
  if (c.error) return json({ ok: false, error: c.error }, 400);
  try {
    const d = await admin(env, fetchFn, 'query($id:ID!){ product(id:$id){ id title variants(first:1){ nodes{ id } } } }', { id });
    const v = d && d.product && d.product.variants && d.product.variants.nodes && d.product.variants.nodes[0];
    if (!v) return json({ ok: false, error: 'Prodotto non trovato' }, 404);
    const u = await admin(env, fetchFn,
      'mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$productId, variants:$variants){ productVariants{ id price compareAtPrice } userErrors{ field message } } }',
      { productId: id, variants: [{ id: v.id, price: c.price, compareAtPrice: c.compareAtPrice }] });
    const r = u && u.productVariantsBulkUpdate;
    if (!r || (r.userErrors && r.userErrors.length)) return json({ ok: false, error: (r && r.userErrors || []).map(e => e.message).join('; ') || 'Salvataggio non riuscito' }, 422);
    return json({ ok: true, action: 'prezzo', title: d.product.title, price: c.price, compareAtPrice: c.compareAtPrice });
  } catch (e) {
    const m = String(e && e.message || '');
    if (m === 'config') return json({ ok: false, error: 'Pannello non ancora attivato: manca la chiave Shopify sul server.' }, 503);
    if (m === 'auth' || m.startsWith('token')) return json({ ok: false, error: 'Shopify ha rifiutato la chiave di accesso: va rigenerata.' }, 502);
    if (m === 'graphql') return json({ ok: false, error: 'Shopify ha rifiutato l\'operazione: controllate i permessi della chiave.' }, 502);
    return json({ ok: false, error: 'Shopify non risponde, riprova tra poco.' }, 502);
  }
}

export async function onRequestPost({ request, env }, fetchFn = fetch) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Richiesta non valida' }, 400); }
  const { action, id, pin, nome, campi, attiva, prezzo, barrato, conferma30 } = body || {};

  if (!env.PANNELLO_PIN || String(env.PANNELLO_PIN).length < 6 || !shopHost(env))
    return json({ ok: false, error: 'Pubblicazione non ancora attivata: mancano le impostazioni sul server.' }, 503);
  if (!safeEqual(pin, env.PANNELLO_PIN)) {
    await new Promise(r => setTimeout(r, 800)); // rallenta i tentativi a caso
    return json({ ok: false, error: 'PIN non corretto' }, 401);
  }
  if (!['pubblica', 'ritira', 'crea', 'salva', 'prezzo'].includes(action)) return json({ ok: false, error: 'Azione non valida' }, 400);
  if (action === 'prezzo') return cambiaPrezzo(env, fetchFn, { id, prezzo, barrato, conferma30 });
  if (action !== 'crea' && !/^gid:\/\/shopify\/Collection\/\d+$/.test(String(id || ''))) return json({ ok: false, error: 'Collezione non valida' }, 400);

  const UPDATE = 'mutation($input:CollectionInput!){ collectionUpdate(input:$input){ collection{ id handle } userErrors{ field message } } }';
  try {
    // ── CREA: nuova festività in bozza, pubblicata sul canale Headless ──
    if (action === 'crea') {
      const name = clean(nome, 40);
      const slug = slugify(name);
      if (!slug) return json({ ok: false, error: 'Scrivete il nome della festività' }, 400);
      const built = buildDescription(campi, attiva !== true);
      if (built.error) return json({ ok: false, error: built.error }, 400);
      const handle = 'vetrina-' + slug;
      const ex = await admin(env, fetchFn, 'query($h:String!){ collectionByHandle(handle:$h){ id } }', { h: handle });
      if (ex && ex.collectionByHandle) return json({ ok: false, error: 'Esiste già una "Vetrina ' + name + '": modificatela dalla sua scheda.' }, 409);
      const c = await admin(env, fetchFn,
        'mutation($input:CollectionInput!){ collectionCreate(input:$input){ collection{ id handle title } userErrors{ field message } } }',
        { input: { title: 'Vetrina ' + name, handle, descriptionHtml: built.html } });
      const ce = c && c.collectionCreate;
      if (!ce || (ce.userErrors && ce.userErrors.length) || !ce.collection) return json({ ok: false, error: (ce && ce.userErrors || []).map(e => e.message).join('; ') || 'Creazione non riuscita' }, 422);
      let published = false;
      const pubId = await headlessPublicationId(env, fetchFn);
      if (pubId) {
        const pu = await admin(env, fetchFn,
          'mutation($id:ID!,$input:[PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors{ field message } } }',
          { id: ce.collection.id, input: [{ publicationId: pubId }] });
        published = !(pu && pu.publishablePublish && pu.publishablePublish.userErrors && pu.publishablePublish.userErrors.length);
      }
      return json({ ok: true, action, id: ce.collection.id, handle: ce.collection.handle, title: ce.collection.title, published });
    }

    const d = await admin(env, fetchFn, 'query($id:ID!){ collection(id:$id){ id handle title descriptionHtml } }', { id });
    const col = d && d.collection;
    if (!col) return json({ ok: false, error: 'Collezione non trovata' }, 404);
    if (!isVetrina(col.handle)) return json({ ok: false, error: 'Si possono modificare solo le collezioni "Vetrina…"' }, 403);

    let descriptionHtml;
    if (action === 'salva') {
      const built = buildDescription(campi, isBozza(col.descriptionHtml));
      if (built.error) return json({ ok: false, error: built.error }, 400);
      descriptionHtml = built.html;
    } else {
      descriptionHtml = action === 'pubblica' ? stripState(col.descriptionHtml) : setDraft(col.descriptionHtml);
    }
    const u = await admin(env, fetchFn, UPDATE, { input: { id, descriptionHtml } });
    const errs = u && u.collectionUpdate && u.collectionUpdate.userErrors;
    if (errs && errs.length) return json({ ok: false, error: errs.map(e => e.message).join('; ') }, 422);
    return json({ ok: true, action, handle: col.handle, title: col.title });
  } catch (e) {
    const m = String(e && e.message || '');
    if (m === 'config') return json({ ok: false, error: 'Pubblicazione non ancora attivata: manca la chiave Shopify sul server.' }, 503);
    if (m === 'auth' || m.startsWith('token')) return json({ ok: false, error: 'Shopify ha rifiutato la chiave di accesso: va rigenerata.' }, 502);
    if (m === 'graphql') return json({ ok: false, error: 'Shopify ha rifiutato l\'operazione: controllate i permessi della chiave (prodotti e pubblicazioni).' }, 502);
    return json({ ok: false, error: 'Shopify non risponde, riprova tra poco.' }, 502);
  }
}

export function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  return json({ ok: false, error: 'Metodo non consentito' }, 405);
}
