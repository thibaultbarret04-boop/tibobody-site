// =====================================================================
// Redirection vers le nom de domaine définitif
//
// Tant que la variable DOMAINE_PRINCIPAL n'existe pas dans Cloudflare,
// rien ne change : le site reste accessible sur tibobody-site.pages.dev.
// Le jour du lancement : Settings > Variables and Secrets >
//   DOMAINE_PRINCIPAL = tibobody.fr   (Texte), puis « Retry deployment ».
// Alors https://tibobody-site.pages.dev/n-importe-quoi
//   -> https://tibobody.fr/n-importe-quoi (redirection permanente 301).
// Les anciennes versions (xxxx.tibobody-site.pages.dev) ne sont pas redirigées.
// =====================================================================
const ADRESSE_PAGES = 'tibobody-site.pages.dev';

export async function onRequest({ request, env, next }) {
  const domaine = String(env.DOMAINE_PRINCIPAL || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const url = new URL(request.url);
  // /api/ n'est jamais redirigé : Stripe n'accepte pas les redirections sur le webhook
  if (domaine && url.hostname === ADRESSE_PAGES && !url.pathname.startsWith('/api/')) {
    url.hostname = domaine;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  return next();
}