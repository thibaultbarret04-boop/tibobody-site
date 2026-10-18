// =====================================================================
// Tibobody — backend de paiement (Cloudflare Pages Functions)
//
//   GET  /api/places                    -> places restantes par formule
//   POST /api/create-checkout-session   -> crée un paiement Stripe
//        { formule: "cadre" | "accompagne" | "immersion" }  (abonnement)
//        { items: [{ id: "01" }, ...] }                     (e-books)
//   GET  /api/telechargements?session_id=cs_… | ?t=…   -> liens de téléchargement
//   GET  /api/fichier/05?exp=…&sig=…    -> le PDF (lien signé, valable 1 h)
//   POST /api/retractation              -> demande de rétractation + accusé de réception (Brevo)
//   POST /api/stripe-webhook            -> plus utilisé (répond « reçu » ; le webhook peut être supprimé dans Stripe)
//
// Variables à régler dans Cloudflare (Settings > Variables and Secrets) :
//   STRIPE_SECRET_KEY      (Secret)  clé Stripe sk_test_… / sk_live_…
//   PAIEMENTS_OUVERTS      (Texte)   facultatif : "non" pour fermer les paiements. Absent = ouverts.
//   BREVO_API_KEY          (Secret)  clé API Brevo (emails automatiques)
//   PORTAIL_CLIENT_URL     (Texte)   lien du portail client Stripe (https://billing.stripe.com/p/login/…)
//   DOMAINE_PRINCIPAL      (Texte)   ex. tibobody.fr : redirige tibobody-site.pages.dev vers ce domaine
//                                    (voir functions/_middleware.js). Absent = pas de redirection.
//
//   GET  /api/portail                   -> redirige vers le portail client Stripe
//
// Tarif de lancement : le client tape le code promo (ex. TIBOBODY50) sur la page de paiement
// des formules. Le code se crée dans Stripe (Bons de réduction > Codes promotionnels).
//
// Les PDF sont dans un dossier au nom secret (DOSSIER_PRIVE ci-dessous),
// impossible à deviner : le backend lit le fichier et le transmet à l'acheteur
// sans jamais révéler ce nom. Seuls les liens signés permettent de télécharger.
// ⚠ Ne jamais écrire ce nom de dossier sur le site, ni le partager.
//
// La clé secrète Stripe n'est JAMAIS écrite ici : elle est lue dans la
// variable d'environnement STRIPE_SECRET_KEY (réglages Cloudflare Pages).
//
// Places : Stripe sert de registre, pas besoin de base de données.
//   places restantes = places max − abonnements en cours − paiements en cours
//   « places max » se règle dans Stripe : produit > Métadonnées > clé "places".
//   (valeur par défaut ci-dessous si la métadonnée n'existe pas)
// =====================================================================

const FORMULES = {
  cadre:      { product: 'prod_VPAS6UDcqbGgsa', placesParDefaut: 8 },
  accompagne: { product: 'prod_VPAUUfluBpZox7', placesParDefaut: 6 },
  immersion:  { product: 'prod_VPAVhE4lJ1uoCq', placesParDefaut: 3 },
};

// Identifiants utilisés par le panier du site (ebook.html)
const EBOOKS = {
  '01': 'prod_VPANVV3JWkdePl', // Trouver sa passion
  '02': 'prod_VPAMwBYnnHoZy6', // L'art de positiver
  '03': 'prod_VPAM8bSCsfDyAe', // Communication non violente
  '04': 'prod_VPAKJCA6nnRRZm', // Le guide d'un jeune homme ambitieux
  '05': 'prod_VPAJ5d955advxw', // 30 jours pour devenir inarrêtable
  '06': 'prod_VPAOWpBe12cHeK', // 10 leçons que la musculation m'a apprises
  '07': 'prod_VPAHXOMr2YbTe1', // Pack Intégral (les 6 e-books) — ancien produit « Pack Discipline » renommé
};

// Contenu de chaque article : le pack donne accès aux 6 e-books
const CONTENU = {
  '01': ['01'], '02': ['02'], '03': ['03'], '04': ['04'], '05': ['05'], '06': ['06'],
  '07': ['01', '02', '03', '04', '05', '06'], // Pack Intégral
};

// Dossier des PDF, à la racine du site (nom secret, ne pas le modifier sans renommer le dossier)
const DOSSIER_PRIVE = 'ebooks-a9f0aca74470de24f4c9627367dabf01';

// Fichiers PDF à placer dans ce dossier (noms exacts)
const FICHIERS = {
  '01': { fichier: 'trouver-sa-passion.pdf',            titre: 'Trouver sa passion' },
  '02': { fichier: 'art-de-positiver.pdf',              titre: "L'art de positiver" },
  '03': { fichier: 'communication-non-violente.pdf',    titre: 'Communication non violente' },
  '04': { fichier: 'guide-jeune-homme-ambitieux.pdf',   titre: "Le guide d'un jeune homme ambitieux" },
  '05': { fichier: '30-jours-inarretable.pdf',          titre: '30 jours pour devenir inarrêtable' },
  '06': { fichier: '10-lecons-musculation.pdf',         titre: "10 leçons que la musculation m'a apprises" },
};

const LIEN_COMMANDE_JOURS = 365;      // lien envoyé dans la facture
const LIEN_FICHIER_SECONDES = 60 * 60; // lien direct vers un PDF

const EMAIL_CONTACT = 'contact@tibobody.fr';
const NOM_EXPEDITEUR = 'Tibobody';

// Pied des factures (obligatoire : identité du vendeur + mention TVA)
const PIED_FACTURE = 'Thibault Barret – TiboBody, entrepreneur individuel – 29 rue Tronchet, 75008 Paris – SIRET 13152662600018 – TVA non applicable, art. 293 B du CGI – contact@tibobody.fr';

// Champ obligatoire au paiement (Stripe n'a pas de case à cocher : liste à un seul choix)
const CHAMP_MAJEUR = {
  key: 'majeur',
  label: { type: 'custom', custom: 'Âge' },
  type: 'dropdown',
  optional: false,
  dropdown: { options: [{ label: "J'ai 18 ans ou plus", value: 'oui' }] },
};

function paiementsOuverts(env) {
  return String(env.PAIEMENTS_OUVERTS || '').trim().toLowerCase() !== 'non';
}

// Un client compte comme « place occupée » tant que son abonnement est dans un de ces états
const STATUTS_OCCUPANTS = ['active', 'trialing', 'past_due', 'unpaid'];
// Durée de réservation d'une place pendant le paiement (Stripe impose 30 min minimum)
const RESERVATION_SECONDES = 31 * 60;
const CACHE_PLACES_SECONDES = 20;

// ---------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------
export async function onRequest({ request, env, params }) {
  const route = (params.route || []).join('/');
  try {
    if (route === 'retractation' && request.method === 'POST') return await postRetractation(request, env);
    if (route === 'portail') {
      // lien « Gérer ou résilier mon abonnement » : portail client Stripe, sinon le formulaire de contact
      const dest = /^https:\/\/billing\.stripe\.com\//.test(env.PORTAIL_CLIENT_URL || '') ? env.PORTAIL_CLIENT_URL : '/index.html#contact';
      return Response.redirect(new URL(dest, request.url).toString(), 302);
    }
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'Paiement indisponible : clé Stripe non configurée.' }, 500);
    }
    if (route === 'places' && request.method === 'GET') return await getPlaces(request, env);
    if (route === 'create-checkout-session' && request.method === 'POST') return await createCheckout(request, env);
    if (route === 'stripe-webhook' && request.method === 'POST') return await stripeWebhook(request, env);
    if (route === 'telechargements' && request.method === 'GET') return await getTelechargements(request, env);
    if (params.route && params.route[0] === 'fichier' && request.method === 'GET') return await getFichier(request, env, params.route[1]);
    return json({ error: 'Route inconnue.' }, 404);
  } catch (e) {
    console.error('API error', route, e.message, e.stripe || '');
    return json({ error: "Le paiement n'a pas pu démarrer, réessaie dans un instant." }, 500);
  }
}

// ---------------------------------------------------------------------
// Places restantes
// ---------------------------------------------------------------------
async function getPlaces(request, env) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/places', request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const places = await calculerPlaces(env);
  const data = Object.fromEntries(Object.entries(places).map(([k, v]) => [k, { max: v.max, restantes: v.restantes }]));
  data.ouvert = paiementsOuverts(env);
  const res = json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_PLACES_SECONDES}` });
  if (cache) await cache.put(cacheKey, res.clone());
  return res;
}

async function calculerPlaces(env, seulement) {
  const cles = seulement ? [seulement] : Object.keys(FORMULES);
  const produits = await Promise.all(cles.map(k => stripe(env, 'GET', `products/${FORMULES[k].product}`)));

  // paiements en cours (sessions ouvertes) = places réservées temporairement
  const sessions = await listerTout(env, 'checkout/sessions', { status: 'open', limit: 100 });

  const resultat = {};
  await Promise.all(cles.map(async (k, i) => {
    const produit = produits[i];
    const prixId = idDe(produit.default_price);
    const max = parseInt(produit.metadata && produit.metadata.places, 10);
    const placesMax = Number.isFinite(max) && max >= 0 ? max : FORMULES[k].placesParDefaut;

    let occupees = 0;
    if (prixId) {
      const abonnements = await listerTout(env, 'subscriptions', { price: prixId, status: 'all', limit: 100 });
      occupees = abonnements.filter(s => STATUTS_OCCUPANTS.includes(s.status)).length;
    }
    const enCours = sessions.filter(s => s.metadata && s.metadata.formule === k).length;

    resultat[k] = {
      max: placesMax,
      restantes: Math.max(0, placesMax - occupees - enCours),
      prix: prixId,
    };
  }));
  return resultat;
}

// ---------------------------------------------------------------------
// Création du paiement
// ---------------------------------------------------------------------
async function createCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête invalide.' }, 400); }
  const origin = new URL(request.url).origin;
  const expiresAt = Math.floor(Date.now() / 1000) + RESERVATION_SECONDES;

  if (!paiementsOuverts(env)) {
    return json({ error: 'Les paiements ouvrent très bientôt. Écris-moi via le formulaire de contact en attendant.', ferme: true }, 403);
  }

  // ----- Formule (abonnement mensuel) -----
  if (body && body.formule) {
    const cle = String(body.formule);
    if (!FORMULES[cle]) return json({ error: 'Formule inconnue.' }, 400);
    // chaque paiement ouvert réserve une place 31 min : on limite pour qu'un robot ne bloque pas tout
    if (await limiteAtteinte(request, 'formule', 3, RESERVATION_SECONDES)) {
      return json({ error: 'Trop de tentatives de paiement. Réessaie dans 30 minutes ou écris-moi via le formulaire de contact.' }, 429);
    }

    const places = (await calculerPlaces(env, cle))[cle];
    if (!places.prix) return json({ error: "Cette formule n'a pas encore de prix dans Stripe." }, 500);
    if (places.restantes <= 0) {
      return json({ error: 'Cette formule est complète pour le moment.', complet: true }, 409);
    }

    const session = await creerSession(env, {
      mode: 'subscription',
      locale: 'fr',
      line_items: [{ price: places.prix, quantity: 1 }],
      success_url: `${origin}/merci.html?type=formule&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/formule.html#formules`,
      expires_at: expiresAt,
      // champ « Code promo » (tarif de lancement : TIBOBODY50)
      allow_promotion_codes: true,
      metadata: { formule: cle },
      subscription_data: { metadata: { formule: cle } },
      // case à cocher obligatoire (seule vraie case que Stripe propose)
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: { message: `J'accepte les [CGV](${origin}/cgv.html).` },
      },
      // Stripe n'a pas d'autre case à cocher : choix obligatoire dans une liste
      custom_fields: [{
        key: 'demarrage',
        label: { type: 'custom', custom: 'Début de l\'accompagnement' },
        type: 'dropdown',
        optional: false,
        dropdown: {
          options: [
            { label: "Je demande que l'accompagnement commence avant la fin du délai de rétractation de 14 jours", value: 'immediat' },
            { label: 'Je préfère attendre la fin du délai de rétractation de 14 jours', value: 'attendre14j' },
          ],
        },
      }, CHAMP_MAJEUR],
    });
    return json({ url: session.url });
  }

  // ----- E-books (paiement unique) -----
  const ids = Array.isArray(body && body.items)
    ? [...new Set(body.items.map(i => String(i && i.id)))].filter(id => EBOOKS[id])
    : [];
  if (ids.length === 0) return json({ error: 'Ton panier est vide.' }, 400);
  if (await limiteAtteinte(request, 'ebook', 10, RESERVATION_SECONDES)) {
    return json({ error: 'Trop de tentatives de paiement. Réessaie dans quelques minutes.' }, 429);
  }

  const produits = await Promise.all(ids.map(id => stripe(env, 'GET', `products/${EBOOKS[id]}`)));
  const lignes = produits.map(p => {
    const prix = idDe(p.default_price);
    if (!prix) throw new Error(`Produit sans prix : ${p.id}`);
    return { price: prix, quantity: 1 };
  });

  // lien de téléchargement envoyé par Stripe dans la facture (valable 1 an)
  const contenu = contenuDe(ids);
  const expCommande = Math.floor(Date.now() / 1000) + LIEN_COMMANDE_JOURS * 86400;
  const jeton = await creerJeton(env, `${contenu.join(',')}|${expCommande}`);
  const lienCommande = `${origin}/merci.html?type=ebook&t=${jeton}`;

  const session = await creerSession(env, {
    mode: 'payment',
    locale: 'fr',
    line_items: lignes,
    success_url: `${origin}/merci.html?type=ebook&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/ebook.html`,
    expires_at: expiresAt,
    metadata: { ebooks: ids.join(',') },
    custom_fields: [CHAMP_MAJEUR],
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: `Merci pour ton achat ! Télécharge tes e-books ici (lien valable 1 an) : ${lienCommande}`,
        footer: PIED_FACTURE,
      },
    },
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `J'accepte les [CGV](${origin}/cgv.html). J'accepte la livraison immédiate et je renonce à mon droit de rétractation.`,
      },
    },
  });
  return json({ url: session.url });
}

// ---------------------------------------------------------------------
// Anti-abus : nombre maximum de demandes par adresse IP sur une durée
// (empêche un robot de bloquer les places ou d'envoyer des emails en boucle)
// ---------------------------------------------------------------------
async function limiteAtteinte(request, action, max, secondes) {
  if (typeof caches === 'undefined') return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
  const cle = new Request(`https://limite.tibobody.invalid/${action}/${encodeURIComponent(ip)}`);
  try {
    const deja = await caches.default.match(cle);
    const n = deja ? parseInt(await deja.text(), 10) || 0 : 0;
    if (n >= max) return true;
    await caches.default.put(cle, new Response(String(n + 1), { headers: { 'Cache-Control': `max-age=${secondes}` } }));
  } catch (e) { console.warn('limite', e.message); }
  return false;
}

// ---------------------------------------------------------------------
// Emails (Brevo)
// ---------------------------------------------------------------------
async function envoyerEmail(env, { to, subject, text, replyTo }) {
  if (!env.BREVO_API_KEY) throw new Error('BREVO_API_KEY manquante');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">${echapper(text).replace(/\n/g, '<br>')}</div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: NOM_EXPEDITEUR, email: EMAIL_CONTACT },
      to: Array.isArray(to) ? to : [to],
      ...(replyTo ? { replyTo } : {}),
      subject, textContent: text, htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} ${await res.text()}`);
}

function echapper(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function dateHeureParis(d) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'medium', timeZone: 'Europe/Paris' }).format(d) + ' (heure de Paris)';
}

// ---------------------------------------------------------------------
// Rétractation : enregistre la demande et envoie l'accusé de réception
// (contenu + date et heure, sur support durable = email) — obligatoire depuis le 19/06/2026
// ---------------------------------------------------------------------
async function postRetractation(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Requête invalide.' }, 400); }
  const champ = (v, max = 200) => String(v || '').trim().slice(0, max);
  const nom = champ(b.nom, 120), email = champ(b.email, 160), formule = champ(b.formule, 60);
  const dateSouscription = champ(b.date_souscription, 20), message = champ(b.message, 2000);
  if (champ(b._gotcha)) return json({ ok: true }); // robot
  const CONTRATS = ['Cadre', 'Accompagné', 'Immersion', 'E-book'];
  if (!nom || !CONTRATS.includes(formule) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Merci de renseigner ton nom, ton email et le contrat concerné.' }, 400);
  }
  if (!env.BREVO_API_KEY) return json({ error: 'indisponible', indisponible: true }, 503);
  if (await limiteAtteinte(request, 'retractation', 3, 3600)) {
    return json({ error: 'Trop de demandes envoyées. Réessaie dans une heure, ou écris directement à contact@tibobody.fr.' }, 429);
  }

  const recue = new Date();
  const quand = dateHeureParis(recue);
  // version pour le client : sans le message libre et sans liens (évite qu'un tiers se serve
  // du formulaire pour envoyer un faux email avec un lien, au nom de Tibobody)
  const sansLien = t => t.replace(/(https?:\/\/|www\.)\S*/gi, '[lien retiré]');
  const contenuClient = [
    'Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services ci-dessous :',
    `- Contrat concerné : ${sansLien(formule)}`,
    `- Date de souscription : ${sansLien(dateSouscription) || 'non précisée'}`,
    `- Nom du client : ${sansLien(nom)}`,
    `- Adresse email utilisée pour l'achat : ${email}`,
  ].join('\n');
  const contenu = [
    'Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services ci-dessous :',
    `- Contrat concerné : ${formule}`,
    `- Date de souscription : ${dateSouscription || 'non précisée'}`,
    `- Nom du client : ${nom}`,
    `- Adresse email utilisée pour l'achat : ${email}`,
    ...(message ? [`- Précision : ${message}`] : []),
  ].join('\n');

  await envoyerEmail(env, {
    to: { email, name: sansLien(nom).slice(0, 70) },
    replyTo: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
    subject: 'Accusé de réception de ta rétractation — Tibobody',
    text: `Bonjour ${sansLien(nom)},\n\nNous accusons réception de ta demande de rétractation, reçue le ${quand}.\n\nVoici le contenu de ta déclaration :\n\n${contenuClient}\n\nLe remboursement interviendra au plus tard 14 jours après ta rétractation, par le même moyen de paiement que celui utilisé lors de l'achat. Si tu avais demandé que l'accompagnement commence avant la fin du délai de 14 jours, seule la part correspondant aux jours écoulés reste due.\n\nPour toute question, réponds simplement à cet email.\n\nTibobody — ${EMAIL_CONTACT}`,
  });
  // copie pour Tibobody (si elle échoue, la demande du client reste valide)
  try {
    await envoyerEmail(env, {
      to: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
      replyTo: { email, name: nom },
      subject: `Rétractation reçue — ${nom} (${formule})`,
      text: `Demande reçue le ${quand}.\n\n${contenu}\n\nÀ faire : arrêter l'abonnement dans Stripe et rembourser sous 14 jours (au prorata si le client a demandé à commencer tout de suite).`,
    });
  } catch (e) { console.error('copie rétractation', e.message); }

  return json({ ok: true, recue: quand });
}

// ---------------------------------------------------------------------
// Webhook Stripe : plus nécessaire (l'ancien tarif de bienvenue a été remplacé
// par un code promo sur le 1er mois). On répond « reçu » pour que Stripe ne
// réessaie pas si le webhook n'a pas encore été supprimé.
// ---------------------------------------------------------------------
async function stripeWebhook() {
  return json({ recu: true });
}

// ---------------------------------------------------------------------
// Livraison des e-books
// ---------------------------------------------------------------------
function contenuDe(ids) {
  return [...new Set(ids.flatMap(id => CONTENU[id] || []))].filter(id => FICHIERS[id]).sort();
}

// Liste des e-books achetés + liens signés vers les PDF
async function getTelechargements(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const jeton = url.searchParams.get('t');
  let contenu = null;

  if (sessionId) {
    // retour direct après paiement : on vérifie auprès de Stripe que c'est payé
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: 'Commande introuvable.' }, 404);
    let session;
    try { session = await stripe(env, 'GET', `checkout/sessions/${sessionId}`); }
    catch { return json({ error: 'Commande introuvable.' }, 404); }
    if (session.payment_status !== 'paid') return json({ error: "Le paiement n'est pas encore confirmé." }, 402);
    contenu = contenuDe(String((session.metadata && session.metadata.ebooks) || '').split(',').filter(Boolean));
  } else if (jeton) {
    // lien reçu dans la facture
    const donnees = await lireJeton(env, jeton);
    if (!donnees) return json({ error: 'Lien invalide.' }, 403);
    const [liste, exp] = donnees.split('|');
    if (Date.now() / 1000 > Number(exp)) return json({ error: 'Ce lien a expiré. Écris à contact@tibobody.fr.' }, 410);
    contenu = liste.split(',').filter(id => FICHIERS[id]);
  }
  if (!contenu || contenu.length === 0) return json({ error: 'Commande introuvable.' }, 404);

  const exp = Math.floor(Date.now() / 1000) + LIEN_FICHIER_SECONDES;
  const ebooks = await Promise.all(contenu.map(async id => ({
    id,
    titre: FICHIERS[id].titre,
    url: `/api/fichier/${id}?exp=${exp}&sig=${await signer(env, `fichier|${id}|${exp}`)}`,
  })));
  return json({ ebooks });
}

// Sert un PDF si le lien signé est valide
async function getFichier(request, env, id) {
  const url = new URL(request.url);
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig') || '';
  if (!FICHIERS[id] || !exp) return new Response('Introuvable', { status: 404 });
  if (Date.now() / 1000 > Number(exp)) {
    return new Response('Ce lien a expiré : retourne sur ta page de téléchargement pour en obtenir un nouveau.', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!egal(sig, await signer(env, `fichier|${id}|${exp}`))) return new Response('Lien invalide', { status: 403 });
  if (!env.ASSETS) return new Response('Stockage indisponible', { status: 500 });

  const fichier = await env.ASSETS.fetch(new Request(new URL(`/${DOSSIER_PRIVE}/${FICHIERS[id].fichier}`, url.origin)));
  if (!fichier.ok) return new Response('Fichier introuvable', { status: 404 });
  return new Response(fichier.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${FICHIERS[id].fichier}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// --- signatures (HMAC-SHA256) ---
async function signer(env, message) {
  const secret = env.DOWNLOAD_SECRET || env.STRIPE_SECRET_KEY;
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(`tibobody-ebooks|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cle, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}
async function creerJeton(env, donnees) {
  return `${b64url(new TextEncoder().encode(donnees))}.${await signer(env, `commande|${donnees}`)}`;
}
async function lireJeton(env, jeton) {
  const [partie, sig] = String(jeton).split('.');
  if (!partie || !sig) return null;
  let donnees;
  try { donnees = new TextDecoder().decode(Uint8Array.from(atob(partie.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); }
  catch { return null; }
  return egal(sig, await signer(env, `commande|${donnees}`)) ? donnees : null;
}
function b64url(bytes) {
  let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function egal(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Crée la session de paiement.
// En MODE TEST uniquement : si l'URL des CGV n'est pas renseignée dans Stripe
// (Paramètres > Informations publiques), on relance sans la case CGV pour pouvoir tester.
// En MODE RÉEL, la case reste obligatoire : l'erreur remonte pour ne jamais vendre sans elle.
async function creerSession(env, params) {
  try {
    return await stripe(env, 'POST', 'checkout/sessions', params);
  } catch (e) {
    const modeTest = String(env.STRIPE_SECRET_KEY).startsWith('sk_test_');
    const liéAuxCgv = /terms of service|consent_collection/i.test(`${e.message} ${(e.stripe && e.stripe.param) || ''}`);
    if (!modeTest || !liéAuxCgv) throw e;
    console.warn('Mode test : URL des CGV absente dans Stripe, paiement créé sans la case CGV.');
    const sansCgv = { ...params };
    delete sansCgv.consent_collection;
    if (sansCgv.custom_text) {
      const { terms_of_service_acceptance, ...autres } = sansCgv.custom_text;
      if (Object.keys(autres).length) sansCgv.custom_text = autres; else delete sansCgv.custom_text;
    }
    return await stripe(env, 'POST', 'checkout/sessions', sansCgv);
  }
}

// ---------------------------------------------------------------------
// Outils Stripe (API REST, sans dépendance)
// ---------------------------------------------------------------------
async function stripe(env, method, path, params) {
  const query = params ? encoder(params) : '';
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: method === 'GET' ? undefined : query,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Erreur Stripe ${res.status}`);
    err.stripe = data.error;
    throw err;
  }
  return data;
}

async function listerTout(env, path, params, maxPages = 10) {
  const tout = [];
  let apres;
  for (let page = 0; page < maxPages; page++) {
    const res = await stripe(env, 'GET', path, apres ? { ...params, starting_after: apres } : params);
    tout.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    apres = res.data[res.data.length - 1].id;
  }
  return tout;
}

// { a: { b: [ { c: 1 } ] } }  ->  a[b][0][c]=1
function encoder(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encoder(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

function idDe(v) { return v && typeof v === 'object' ? v.id : v || null; }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}