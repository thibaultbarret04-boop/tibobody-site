// ---------------------------------------------------------------------
// Associe chaque identifiant d'e-book/pack (ceux utilisés dans le site,
// voir l'objet `books` dans index.html) à son Price ID Stripe.
//
// Pour obtenir un Price ID :
// 1. Va sur dashboard.stripe.com > Produits > Ajouter un produit
// 2. Crée un produit pour chaque e-book/pack avec son prix
// 3. Stripe génère un "Price ID" (commence par price_...) pour chacun
// 4. Colle-le ici, à la place de price_XXXXXXXXXXXXXXXXXXXXXX
// ---------------------------------------------------------------------
const PRICE_MAP = {
  '01': 'price_1UGg5tFMHFbCmCWQbNHTua6W', // Trouver sa passion — 5,99€
  '02': 'price_1UGg6sFMHFbCmCWQDUhR1nzd', // L'art de positiver — 5,99€
  '03': 'price_1UGg82FMHFbCmCWQOybZ7OsW', // Communication non violente — 9,99€
  '04': 'price_1UGg98FMHFbCmCWQNkr6qCbV', // Le guide d'un jeune homme ambitieux — 5,99€
  '05': 'price_1UGgA0FMHFbCmCWQXDkoDEbZ', // 30 jours pour devenir inarrêtable — 9,99€
  '06': 'price_1UGgB0FMHFbCmCWQcDcF1Ugx', // 10 leçons que la musculation m'a apprises — 4,99€
  '07': 'price_1UGfg1FMHFbCmCWQc0NjtFWv', // Pack Discipline — 11,99€
  '08': 'price_1UGgDnFMHFbCmCWQWpz1OxEI', // Pack Accomplissement — 8,99€
};

// Cette version n'utilise AUCUNE librairie externe (pas de "import Stripe
// from 'stripe'") : elle appelle directement l'API Stripe avec fetch(),
// nativement disponible sur Cloudflare Workers/Pages. C'est indispensable
// avec un déploiement par "Upload direct" (glisser-déposer), qui n'installe
// pas les dépendances npm — contrairement à un déploiement connecté à Git.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { items } = await request.json();

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: 'Le panier est vide.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const origin = new URL(request.url).origin;
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', origin + '/merci.html?session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', origin + '/index.html#ebooks');

    items.forEach((item, i) => {
      const priceId = PRICE_MAP[item.id];
      if (!priceId || priceId.includes('XXXX')) {
        throw new Error(
          'Produit non configuré côté Stripe : ' + item.id +
          ' — remplis PRICE_MAP dans functions/api/create-checkout-session.js'
        );
      }
      params.append(`line_items[${i}][price]`, priceId);
      params.append(`line_items[${i}][quantity]`, '1');
    });

    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY manquante — vérifie les variables d\'environnement dans Cloudflare Pages.');
    }

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      throw new Error(data.error?.message || 'Erreur Stripe inconnue.');
    }

    return new Response(JSON.stringify({ url: data.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}