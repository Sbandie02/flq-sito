// ─────────────────────────────────────────────────────────────
// ACCESSO AL PANNELLO con utente e password
// Gira solo su /pannello e /pannello/* (vedi _routes.json): il sito pubblico non passa di qui.
//
// Impostazioni su Cloudflare Pages → Settings → Variables and secrets (Production):
//   PANNELLO_UTENTI  (Secret)  utenti e password, uno per riga o separati da ;
//                              es.  jessica:UnaPasswordLunga;aqeel:AltraPassword;federico:...
//                              nome utente: lettere minuscole/numeri; password: almeno 10 caratteri
//   PANNELLO_PIN     (Secret)  già presente: serve anche per firmare la sessione
// La sessione dura 30 giorni (cookie sicuro, non leggibile da JavaScript).
// Cambiando una password o il PIN, tutti vengono scollegati.
// ─────────────────────────────────────────────────────────────
const COOKIE = 'flq_pannello';
const DURATA = 30 * 24 * 3600;
const enc = new TextEncoder();

export function utenti(env) {
  const out = {};
  String(env.PANNELLO_UTENTI || '').split(/[;\n]/).forEach(r => {
    const i = r.indexOf(':'); if (i <= 0) return;
    const u = r.slice(0, i).trim().toLowerCase(); const p = r.slice(i + 1).trim();
    if (/^[a-z0-9_-]{1,32}$/.test(u) && p.length >= 10) out[u] = p;
  });
  return out;
}
function safeEq(a, b) {
  a = String(a); b = String(b); let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function chiave(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('flq-sessione|' + (env.PANNELLO_PIN || '') + '|' + (env.PANNELLO_UTENTI || '')));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function firma(env, utente, scad) {
  const dati = utente + '.' + scad;
  return dati + '.' + b64u(await crypto.subtle.sign('HMAC', await chiave(env), enc.encode(dati)));
}
export async function leggi(env, token) {
  const p = String(token || '').split('.'); if (p.length !== 3) return null;
  const [u, scad] = p;
  if (!/^[a-z0-9_-]{1,32}$/.test(u) || !(Number(scad) > Date.now() / 1000) || !utenti(env)[u]) return null;
  return safeEq(await firma(env, u, scad), token) ? u : null;
}
function cookie(req, nome) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h } });
const vai = (dove, h = {}) => new Response(null, { status: 302, headers: { location: dove, 'cache-control': 'no-store', ...h } });
const attesa = ms => new Promise(r => setTimeout(r, ms));

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/pannello' && !path.startsWith('/pannello/')) return ctx.next();

  const lista = utenti(env);
  const chi = await leggi(env, cookie(request, COOKIE));

  // Pagina di accesso
  if (path === '/pannello/accedi') {
    if (chi) return vai('/pannello');
    return new Response(paginaAccesso(Object.keys(lista).length > 0), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY' }
    });
  }
  // Login
  if (path === '/pannello/api/accedi') {
    if (request.method !== 'POST') return json({ ok: false, error: 'Metodo non valido' }, 405);
    if (!Object.keys(lista).length) return json({ ok: false, error: 'Accesso non ancora configurato sul server.' }, 503);
    let b = {}; try { b = await request.json(); } catch (_) {}
    const u = String(b.utente || '').trim().toLowerCase();
    const giusto = lista[u];
    const ok = safeEq(String(b.password || ''), giusto || '\u0000nessuno');
    if (!giusto || !ok) { await attesa(1200); return json({ ok: false, error: 'Utente o password non corretti' }, 401); }
    const tok = await firma(env, u, Math.floor(Date.now() / 1000) + DURATA);
    return json({ ok: true, utente: u }, 200, { 'set-cookie': `${COOKIE}=${encodeURIComponent(tok)}; Path=/pannello; Max-Age=${DURATA}; HttpOnly; Secure; SameSite=Strict` });
  }
  // Esci
  if (path === '/pannello/esci') return vai('/pannello/accedi', { 'set-cookie': `${COOKIE}=; Path=/pannello; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });

  // Tutto il resto del pannello richiede l'accesso
  if (!chi) {
    if (path.startsWith('/pannello/api/')) return json({ ok: false, error: 'Sessione scaduta: rientrate nel pannello.' }, 401);
    return vai('/pannello/accedi');
  }
  if (path === '/pannello/api/io') return json({ ok: true, utente: chi });
  return ctx.next();
}

function paginaAccesso(attivo) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Pannello · First Luxury Queen</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;1,300;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font-family:'Jost',sans-serif;color:#F5EDE6;
background:radial-gradient(1200px 600px at 15% 0%,#3A1828 0%,transparent 60%),radial-gradient(900px 500px at 100% 100%,#2A1420 0%,transparent 55%),#120B0F}
.card{width:100%;max-width:420px;background:linear-gradient(180deg,rgba(36,21,28,.92),rgba(24,14,19,.96));border:1px solid rgba(217,180,74,.22);border-radius:18px;padding:44px 36px 34px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.k{font:500 10px/1 'Jost';letter-spacing:.32em;text-transform:uppercase;color:#D9B44A;text-align:center}
h1{font:italic 300 42px/1.05 'Cormorant Garamond',serif;text-align:center;margin:14px 0 6px;color:#fff}
h1 em{color:#D7A3B6;font-style:italic}
.rule{width:64px;height:1px;background:linear-gradient(90deg,transparent,#D9B44A,transparent);margin:18px auto 28px}
label{display:block;font:400 11px/1 'Jost';letter-spacing:.18em;text-transform:uppercase;color:#BFA9B3;margin:0 0 8px}
.f{margin-bottom:18px;position:relative}
input{width:100%;height:50px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#fff;font:400 16px 'Jost';padding:0 16px;outline:none;transition:border-color .2s,background .2s}
input:focus{border-color:#D9B44A;background:rgba(255,255,255,.07)}
.eye{position:absolute;right:10px;bottom:9px;height:32px;padding:0 10px;border:0;background:none;color:#BFA9B3;font:400 12px 'Jost';cursor:pointer}
button.go{width:100%;height:52px;margin-top:8px;border:0;border-radius:10px;cursor:pointer;font:500 12px 'Jost';letter-spacing:.24em;text-transform:uppercase;color:#1A0F14;background:linear-gradient(135deg,#E6C76A,#C9A23C);box-shadow:0 10px 24px rgba(217,180,74,.25);transition:transform .15s,opacity .2s}
button.go:hover{transform:translateY(-1px)} button.go:disabled{opacity:.6;cursor:default;transform:none}
.err{min-height:20px;margin-top:14px;text-align:center;font:400 13px 'Jost';color:#F0A3B5}
.foot{margin-top:22px;text-align:center;font:300 12px/1.6 'Jost';color:#8E7883}
.foot a{color:#BFA9B3}
</style></head><body>
<main class="card">
  <div class="k">Pannello di controllo</div>
  <h1>First Luxury <em>Queen</em></h1>
  <div class="rule"></div>
  ${attivo ? `<form id="f" autocomplete="on">
    <div class="f"><label for="u">Utente</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
    <div class="f"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" onclick="const p=document.getElementById('p');p.type=p.type==='password'?'text':'password';this.textContent=p.type==='password'?'Mostra':'Nascondi'">Mostra</button></div>
    <button class="go" id="b" type="submit">Entra</button>
    <div class="err" id="e" role="alert"></div>
  </form>` : `<p class="err" style="color:#BFA9B3">Accesso non ancora configurato.</p>`}
  <div class="foot">Area riservata allo staff · <a href="/">torna al sito</a></div>
</main>
<script>
const f=document.getElementById('f');
if(f) f.addEventListener('submit',async ev=>{ev.preventDefault();const b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;b.textContent='Accesso…';e.textContent='';
 try{const r=await fetch('/pannello/api/accedi',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({utente:document.getElementById('u').value,password:document.getElementById('p').value})});
  const d=await r.json().catch(()=>({}));if(r.ok&&d.ok){location.replace('/pannello#/panoramica');return;}e.textContent=d.error||'Accesso non riuscito, riprova.';}
 catch(_){e.textContent='Connessione assente, riprova.';}
 b.disabled=false;b.textContent='Entra';});
</script></body></html>`;
}
