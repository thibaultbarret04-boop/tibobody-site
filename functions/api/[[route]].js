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
//   POST /api/stripe-webhook            -> email 7 jours avant la fin du tarif de bienvenue (Brevo)
//
// Variables à régler dans Cloudflare (Settings > Variables and Secrets) :
//   STRIPE_SECRET_KEY      (Secret)  clé Stripe sk_test_… / sk_live_…
//   PAIEMENTS_OUVERTS      (Texte)   facultatif : "non" pour fermer les paiements. Absent = ouverts.
//   BREVO_API_KEY          (Secret)  clé API Brevo (emails automatiques)
//   STRIPE_WEBHOOK_SECRET  (Secret)  whsec_… du webhook Stripe
//
// Tarif de bienvenue : dans Stripe, produit > Métadonnées > clé "coupon" = ID du coupon
// (repeating, 3 mois). Il est appliqué automatiquement au paiement.
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
  '07': 'prod_VPAHXOMr2YbTe1', // Pack Discipline
  '08': 'prod_VPAIIiyf5OgCIG', // Pack Accomplissement
};

// Contenu de chaque article : un pack donne accès à 2 e-books
const CONTENU = {
  '01': ['01'], '02': ['02'], '03': ['03'], '04': ['04'], '05': ['05'], '06': ['06'],
  '07': ['05', '06'], // Pack Discipline
  '08': ['01', '04'], // Pack Accomplissement
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
const NOMS_FORMULES = { cadre: 'Cadre', accompagne: 'Accompagné', immersion: 'Immersion' };

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
      coupon: (produit.metadata && produit.metadata.coupon || '').trim() || null,
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
      // tarif de bienvenue appliqué automatiquement (aucun code à taper)
      ...(places.coupon ? { discounts: [{ coupon: places.coupon }] } : {}),
      metadata: { formule: cle },
      subscription_data: { metadata: { formule: cle, ...(places.coupon ? { bienvenue: places.coupon } : {}) } },
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: { message: `J'accepte les [conditions générales de vente](${origin}/cgv.html).` },
      },
      custom_fields: [{
        key: 'demarrage',
        label: { type: 'custom', custom: 'Démarrage' },
        type: 'dropdown',
        optional: false,
        dropdown: {
          options: [
            { label: 'Je demande à commencer tout de suite. Si je me rétracte, je paierai la part déjà effectuée.', value: 'immediat' },
            { label: 'Je préfère attendre la fin du délai de 14 jours.', value: 'attendre14j' },
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
        footer: 'Tibobody — contact@tibobody.fr',
      },
    },
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `J'accepte les [CGV](${origin}/cgv.html) et je demande l'accès immédiat à mon e-book. Je reconnais perdre mon droit de rétractation dès sa livraison.`,
      },
    },
  });
  return json({ url: session.url });
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
function dateParis(d) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(d);
}
function euros(centimes) {
  return (centimes / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
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
  if (!nom || !formule || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Merci de renseigner ton nom, ton email et le contrat concerné.' }, 400);
  }
  if (!env.BREVO_API_KEY) return json({ error: 'indisponible', indisponible: true }, 503);

  const recue = new Date();
  const quand = dateHeureParis(recue);
  const contenu = [
    'Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services ci-dessous :',
    `- Contrat concerné : ${formule}`,
    `- Date de souscription : ${dateSouscription || 'non précisée'}`,
    `- Nom du client : ${nom}`,
    `- Adresse email utilisée pour l'achat : ${email}`,
    ...(message ? [`- Précision : ${message}`] : []),
  ].join('\n');

  await envoyerEmail(env, {
    to: { email, name: nom },
    replyTo: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
    subject: 'Accusé de réception de ta rétractation — Tibobody',
    text: `Bonjour ${nom},\n\nNous accusons réception de ta demande de rétractation, reçue le ${quand}.\n\nVoici le contenu de ta déclaration :\n\n${contenu}\n\nLe remboursement interviendra au plus tard 14 jours après ta rétractation, par le même moyen de paiement que celui utilisé lors de l'achat.\n\nPour toute question, réponds simplement à cet email.\n\nTibobody — ${EMAIL_CONTACT}`,
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
// Webhook Stripe : prévient le client 7 jours avant la fin du tarif de bienvenue
// (Stripe > Paramètres > Facturation > « Upcoming renewal events » réglé sur 7 jours)
// ---------------------------------------------------------------------
async function stripeWebhook(request, env) {
  const brut = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET || !(await signatureStripeValide(brut, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Signature invalide.' }, 400);
  }
  const event = JSON.parse(brut);
  if (event.type !== 'invoice.upcoming') return json({ recu: true });

  const facture = event.data && event.data.object || {};
  const subId = idDe(facture.subscription)
    || idDe(facture.parent && facture.parent.subscription_details && facture.parent.subscription_details.subscription);
  if (!subId) return json({ recu: true });

  const abo = await stripe(env, 'GET', `subscriptions/${subId}`);
  const meta = abo.metadata || {};
  if (!meta.bienvenue || meta.prevenu_tarif_normal) return json({ recu: true }); // pas concerné ou déjà prévenu

  const remise = (facture.total_discount_amounts || []).reduce((t, d) => t + (d.amount || 0), 0);
  if (remise > 0) return json({ recu: true }); // la prochaine mensualité est encore au tarif de bienvenue

  const email = facture.customer_email;
  if (!email) return json({ recu: true });
  const ligne = facture.lines && facture.lines.data && facture.lines.data[0];
  const debut = ligne && ligne.period && ligne.period.start;
  const quand = debut ? `le ${dateParis(new Date(debut * 1000))}` : 'dans 7 jours';
  const montant = typeof facture.amount_due === 'number' ? euros(facture.amount_due) : 'le tarif normal';
  const nomFormule = NOMS_FORMULES[meta.formule] || 'ta formule';
  const portail = env.PORTAIL_CLIENT_URL ? `\n\nGérer ou résilier ton abonnement : ${env.PORTAIL_CLIENT_URL}` : `\n\nPour gérer ou résilier ton abonnement, utilise le lien présent dans tes reçus ou écris à ${EMAIL_CONTACT}.`;

  await envoyerEmail(env, {
    to: { email, name: facture.customer_name || undefined },
    replyTo: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
    subject: `Ta formule ${nomFormule} passe au tarif normal ${quand}`,
    text: `Bonjour${facture.customer_name ? ' ' + facture.customer_name : ''},\n\nTes 3 mois au tarif de bienvenue se terminent. À partir de ta prochaine mensualité, ${quand}, ta formule ${nomFormule} sera facturée ${montant} par mois (tarif normal en vigueur au jour de ta souscription).\n\nTu n'as rien à faire pour continuer. Si tu préfères arrêter, tu peux résilier à tout moment, sans frais, avant cette date.${portail}\n\nMerci pour ta confiance,\nTibobody — ${EMAIL_CONTACT}`,
  });
  await stripe(env, 'POST', `subscriptions/${subId}`, { metadata: { prevenu_tarif_normal: new Date().toISOString().slice(0, 10) } });
  return json({ recu: true, prevenu: true });
}

async function signatureStripeValide(brut, entete, secret) {
  if (!entete) return false;
  const parts = Object.fromEntries(entete.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const v1 = entete.split(',').map(p => p.trim()).filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = parts.t;
  if (!t || v1.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min de tolérance
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cle, new TextEncoder().encode(`${t}.${brut}`)));
  const attendu = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  return v1.some(v => egal(v, attendu));
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