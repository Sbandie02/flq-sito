// Il pannello si apre SOLO dal dominio ufficiale, dove c'è la protezione Cloudflare Access
// (email autorizzata + codice). Gli indirizzi tecnici *.pages.dev non passano da Access:
// lì la pagina viene rimandata al dominio ufficiale e le API vengono bloccate.
const DOMINIO = 'firstluxuryqueen.com';

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  if (url.hostname === DOMINIO) return ctx.next();
  if (url.pathname.startsWith('/pannello/api')) {
    return new Response(JSON.stringify({ ok: false, error: 'Accesso non consentito' }), {
      status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  return Response.redirect('https://' + DOMINIO + '/pannello', 302);
}
