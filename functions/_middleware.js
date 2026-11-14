// =====================================================================
// Redirections (s'appliquent à tout le site)
//
// 1. Anciennes pages supprimées -> nouvelle page (redirection permanente 301),
//    pour que les anciens liens (Google, réseaux sociaux) ne tombent pas sur une erreur.
// 2. Adresse tibobody-site.pages.dev -> vrai domaine, si la variable DOMAINE_PRINCIPAL
//    existe dans Cloudflare (www.tibobody.fr). /api/ n'est jamais redirigé : Stripe
//    n'accepte pas les redirections sur le webhook.
// =====================================================================
const ADRESSE_PAGES = 'tibobody-site.pages.dev';

const ANCIENNES_PAGES = {
  '/formule.html': '/groupe-30.html',
  '/formule': '/groupe-30.html',
  '/ebook.html': '/groupe-30.html',
  '/ebook': '/groupe-30.html',
  '/candidature.html': '/',
  '/candidature': '/',
};

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const domaine = String(env.DOMAINE_PRINCIPAL || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const ancienne = ANCIENNES_PAGES[url.pathname];
  const mauvaisDomaine = domaine && url.hostname === ADRESSE_PAGES && !url.pathname.startsWith('/api/');
  if (ancienne || mauvaisDomaine) {
    if (ancienne) { url.pathname = ancienne; url.search = ''; url.hash = ''; }
    if (mauvaisDomaine) { url.hostname = domaine; url.protocol = 'https:'; url.port = ''; }
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
