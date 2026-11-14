// =====================================================================
// TiboBody — backend du site (Cloudflare Pages Functions)
//
// Routes :
//   GET  /api/places                    -> places restantes du Groupe 30
//   POST /api/create-checkout-session   -> paiement Stripe { offre: "groupe30" }
//   POST /api/defi                      -> défi 7 jours : envoie le PDF par email (Brevo)
//   POST /api/retractation              -> demande de rétractation + accusé de réception (Brevo)
//   POST /api/stripe-webhook            -> après chaque achat : email au client + email à TiboBody
//   GET  /api/telechargements, /api/fichier/…  -> e-books déjà achetés (liens envoyés aux clients)
//   GET  /api/portail                   -> portail client Stripe (anciens abonnements)
//
// Variables à régler dans Cloudflare (Settings > Variables and Secrets) :
//   STRIPE_SECRET_KEY      (Secret)  clé Stripe (sk_live_… ou rk_live_…)
//   STRIPE_WEBHOOK_SECRET  (Secret)  whsec_… du webhook Stripe (événement checkout.session.completed)
//   BREVO_API_KEY          (Secret)  clé API Brevo (emails automatiques)
//   DOWNLOAD_SECRET        (Secret)  signe les liens de téléchargement — ne jamais le changer
//   GROUPE30_PRODUCT       (Texte)   identifiant prod_… du produit « Groupe 30 » dans Stripe
//   FORMULAIRE_DEPART_URL  (Texte)   facultatif : lien du formulaire de départ (envoyé après l'achat)
//   BREVO_LISTE_DEFI       (Texte)   facultatif : numéro de la liste Brevo où ranger les inscrits au défi
//   PORTAIL_CLIENT_URL     (Texte)   lien du portail client Stripe
//   DOMAINE_PRINCIPAL      (Texte)   www.tibobody.fr (voir functions/_middleware.js)
//   PAIEMENTS_OUVERTS      (Texte)   facultatif : "non" ferme les inscriptions. Absent = ouvertes.
//
// Groupe 30 : tout se règle dans Stripe, sur le produit, sans toucher au code :
//   prix par défaut = prix du groupe (29 €, paiement unique)
//   Métadonnées > "places"  = nombre de places (10 par défaut)
//   Métadonnées > "cohorte" = nom du groupe en cours (ex. g1). Pour ouvrir le groupe suivant,
//                             mettre g2 : le compteur de places repart de zéro.
// Une place est occupée par chaque paiement réussi et non remboursé de la cohorte, et
// réservée 31 minutes pendant un paiement en cours.
//
// Les PDF des e-books déjà vendus sont dans un dossier au nom secret (DOSSIER_PRIVE) :
// ⚠ ne jamais l'écrire sur le site ni le partager. Aucune clé n'est écrite ici.
// =====================================================================

const PLACES_PAR_DEFAUT = 10;
const COHORTE_PAR_DEFAUT = 'g1';
const DEFI_PDF = '/assets/img/defi7jour.pdf'; // PDF du défi (public)

// E-books déjà vendus : on garde la livraison pour les anciens acheteurs (plus de vente)
const CONTENU = {
  '01': ['01'], '02': ['02'], '03': ['03'], '04': ['04'], '05': ['05'], '06': ['06'],
  '07': ['01', '02', '03', '04', '05', '06'], // Pack Intégral
  '08': ['01', '04'],                           // ancien Pack Accomplissement
};
const DOSSIER_PRIVE = 'ebooks-a9f0aca74470de24f4c9627367dabf01';
const FICHIERS = {
  '01': { fichier: 'trouver-sa-passion.pdf',            titre: 'Trouver sa passion' },
  '02': { fichier: 'art-de-positiver.pdf',              titre: "L'art de positiver" },
  '03': { fichier: 'communication-non-violente.pdf',    titre: 'Communication non violente' },
  '04': { fichier: 'guide-jeune-homme-ambitieux.pdf',   titre: "Le guide d'un jeune homme ambitieux" },
  '05': { fichier: '30-jours-inarretable.pdf',          titre: '30 jours pour devenir inarrêtable' },
  '06': { fichier: '10-lecons-musculation.pdf',         titre: "10 leçons que la musculation m'a apprises" },
};
const LIEN_FICHIER_SECONDES = 60 * 60; // lien direct vers un PDF

const EMAIL_CONTACT = 'contact@tibobody.fr';
const NOM_EXPEDITEUR = 'TiboBody';

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
    if (route === 'defi' && request.method === 'POST') return await postDefi(request, env);
    if (route === 'portail') {
      const dest = /^https:\/\/billing\.stripe\.com\//.test(env.PORTAIL_CLIENT_URL || '') ? env.PORTAIL_CLIENT_URL : '/#contact';
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
    return json({ error: "Une erreur est survenue, réessaie dans un instant." }, 500);
  }
}

// ---------------------------------------------------------------------
// Groupe 30 : places restantes
// ---------------------------------------------------------------------
async function getPlaces(request, env) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/places', request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const g = await infosGroupe(env);
  const res = json({ groupe30: { max: g.max, restantes: g.restantes }, ouvert: paiementsOuverts(env) }, 200,
    { 'Cache-Control': `public, max-age=${CACHE_PLACES_SECONDES}` });
  if (cache) await cache.put(cacheKey, res.clone());
  return res;
}

async function infosGroupe(env) {
  if (!env.GROUPE30_PRODUCT) throw new Error('GROUPE30_PRODUCT manquant');
  const produit = await stripe(env, 'GET', `products/${env.GROUPE30_PRODUCT}`);
  const meta = produit.metadata || {};
  const max = parseInt(meta.places, 10);
  const places = Number.isFinite(max) && max >= 0 ? max : PLACES_PAR_DEFAUT;
  const cohorte = String(meta.cohorte || COHORTE_PAR_DEFAUT).trim();
  const estDuGroupe = sess => sess.metadata && sess.metadata.offre === 'groupe30' && sess.metadata.cohorte === cohorte;

  // paiements réussis de ce groupe, sauf ceux remboursés (rétractation, garantie…)
  const payes = await listerTout(env, 'checkout/sessions', { status: 'complete', limit: 100, 'expand[]': 'data.payment_intent.latest_charge' });
  const occupees = payes.filter(sess => {
    if (!estDuGroupe(sess) || sess.payment_status !== 'paid') return false;
    const charge = sess.payment_intent && sess.payment_intent.latest_charge;
    return !(charge && typeof charge === 'object' && charge.amount_refunded > 0);
  }).length;
  // paiements en cours = places réservées temporairement
  const ouvertes = await listerTout(env, 'checkout/sessions', { status: 'open', limit: 100 });
  const enCours = ouvertes.filter(estDuGroupe).length;

  return { max: places, restantes: Math.max(0, places - occupees - enCours), prix: idDe(produit.default_price), cohorte, nom: produit.name || 'Groupe 30' };
}

// ---------------------------------------------------------------------
// Groupe 30 : création du paiement
// ---------------------------------------------------------------------
async function createCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête invalide.' }, 400); }
  if (!body || body.offre !== 'groupe30') return json({ error: 'Offre inconnue.' }, 400);
  if (!paiementsOuverts(env)) {
    return json({ error: 'Les inscriptions ouvrent très bientôt. Écris-moi via le formulaire de contact en attendant.', ferme: true }, 403);
  }
  // chaque paiement ouvert réserve une place 31 min : on limite pour qu'un robot ne bloque pas tout
  if (await limiteAtteinte(request, 'groupe30', 3, RESERVATION_SECONDES)) {
    return json({ error: 'Trop de tentatives de paiement. Réessaie dans 30 minutes ou écris-moi via le formulaire de contact.' }, 429);
  }
  const g = await infosGroupe(env);
  if (!g.prix) return json({ error: "Le Groupe 30 n'a pas encore de prix dans Stripe." }, 500);
  if (g.restantes <= 0) return json({ error: 'Ce groupe est complet. Écris-moi pour être prévenu du prochain.', complet: true }, 409);

  const origin = new URL(request.url).origin;
  const session = await creerSession(env, {
    mode: 'payment',
    locale: 'fr',
    line_items: [{ price: g.prix, quantity: 1 }],
    success_url: `${origin}/merci.html?type=groupe30&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/groupe-30.html#reserver`,
    expires_at: Math.floor(Date.now() / 1000) + RESERVATION_SECONDES,
    allow_promotion_codes: true,
    phone_number_collection: { enabled: true }, // numéro pour le groupe WhatsApp
    metadata: { offre: 'groupe30', cohorte: g.cohorte },
    payment_intent_data: { metadata: { offre: 'groupe30', cohorte: g.cohorte } },
    invoice_creation: { enabled: true, invoice_data: { footer: PIED_FACTURE } },
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: { message: `J'accepte les [CGV](${origin}/cgv.html).` },
    },
    // Stripe n'a pas d'autre case à cocher : choix obligatoire dans une liste
    custom_fields: [{
      key: 'demarrage',
      label: { type: 'custom', custom: 'Début du groupe' },
      type: 'dropdown',
      optional: false,
      dropdown: {
        options: [
          { label: 'Je demande à commencer avant la fin de mon délai de rétractation de 14 jours', value: 'immediat' },
          { label: 'Je préfère attendre la fin du délai de rétractation de 14 jours', value: 'attendre14j' },
        ],
      },
    }, CHAMP_MAJEUR],
  });
  return json({ url: session.url });
}

// ---------------------------------------------------------------------
// Défi 7 jours : envoie le lien du PDF par email (+ liste Brevo si configurée)
// ---------------------------------------------------------------------
async function postDefi(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Requête invalide.' }, 400); }
  const prenom = String(b.prenom || '').trim().slice(0, 60).replace(/(https?:\/\/|www\.)\S*/gi, '');
  const email = String(b.email || '').trim().slice(0, 160);
  if (!prenom || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Merci de renseigner ton prénom et une adresse e-mail valide.' }, 400);
  if (b.majeur !== true || b.accord !== true) return json({ error: 'Merci de cocher les deux cases pour recevoir le défi.' }, 400);
  if (!env.BREVO_API_KEY) return json({ error: "L'envoi est momentanément indisponible. Écris-moi à contact@tibobody.fr." }, 503);
  if (await limiteAtteinte(request, 'defi', 5, 3600)) return json({ error: 'Trop de demandes. Réessaie dans une heure.' }, 429);

  const base = env.DOMAINE_PRINCIPAL ? `https://${String(env.DOMAINE_PRINCIPAL).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : new URL(request.url).origin;
  await envoyerEmail(env, {
    to: { email, name: prenom },
    replyTo: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
    subject: 'Ton défi 7 jours TiboBody',
    text: `Salut ${prenom},\n\nVoici ton défi 7 jours : une action par jour pour reprendre le contrôle.\n\nTélécharge-le ici :\n${base}${DEFI_PDF}\n\nCommence aujourd'hui, pas lundi. Et si tu veux quelqu'un qui t'attend chaque jour pendant 30 jours, le Groupe 30 est là :\n${base}/groupe-30.html\n\nThibault — TiboBody\n\nTu reçois cet e-mail parce que tu t'es inscrit au défi sur tibobody.fr. Pour ne plus recevoir de messages, réponds simplement « stop ».`,
  });
  // rangement dans la liste Brevo (facultatif) : permet d'envoyer ensuite des conseils avec désinscription en 1 clic
  const liste = parseInt(env.BREVO_LISTE_DEFI, 10);
  if (Number.isFinite(liste)) {
    try {
      const r = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, attributes: { PRENOM: prenom }, listIds: [liste], updateEnabled: true }),
      });
      if (!r.ok && r.status !== 204) console.warn('liste Brevo', r.status, await r.text());
    } catch (e) { console.warn('liste Brevo', e.message); }
  }
  return json({ ok: true });
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
function euros(centimes) {
  return (centimes / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u202f|\u00a0/g, ' ') + ' €';
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
  const CONTRATS = ['Groupe 30', 'Autre commande (e-book, ancienne formule)', 'Cadre', 'Accompagné', 'Immersion', 'E-book'];
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
    subject: 'Accusé de réception de ta rétractation — TiboBody',
    text: `Bonjour ${sansLien(nom)},\n\nNous accusons réception de ta demande de rétractation, reçue le ${quand}.\n\nVoici le contenu de ta déclaration :\n\n${contenuClient}\n\nLe remboursement interviendra au plus tard 14 jours après ta rétractation, par le même moyen de paiement que celui utilisé lors de l'achat. Si tu avais demandé que le groupe commence avant la fin du délai de 14 jours, seule la part correspondant aux jours écoulés reste due.\n\nPour toute question, réponds simplement à cet email.\n\nTiboBody — ${EMAIL_CONTACT}`,
  });
  // copie pour Tibobody (si elle échoue, la demande du client reste valide)
  try {
    await envoyerEmail(env, {
      to: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
      replyTo: { email, name: nom },
      subject: `Rétractation reçue — ${nom} (${formule})`,
      text: `Demande reçue le ${quand}.\n\n${contenu}\n\nÀ faire : rembourser dans Stripe sous 14 jours (au prorata des jours écoulés si le client avait demandé à commencer tout de suite), et le retirer du groupe WhatsApp.`,
    });
  } catch (e) { console.error('copie rétractation', e.message); }

  return json({ ok: true, recue: quand });
}

// ---------------------------------------------------------------------
// Webhook Stripe (événement checkout.session.completed)
//  - Groupe 30 : email de bienvenue au client + email à TiboBody avec le numéro WhatsApp
// ---------------------------------------------------------------------
async function stripeWebhook(request, env) {
  const brut = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET || !(await signatureStripeValide(brut, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Signature invalide.' }, 400);
  }
  const event = JSON.parse(brut);
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return json({ recu: true });
  const session = (event.data && event.data.object) || {};
  const meta = session.metadata || {};
  if (session.payment_status !== 'paid' || meta.offre !== 'groupe30') return json({ recu: true });
  if (!env.BREVO_API_KEY) { console.error('webhook : BREVO_API_KEY manquante'); return json({ recu: true }); }

  // Stripe peut renvoyer le même événement : on n'envoie qu'une fois
  const cleVente = `vente/${session.id}`;
  if (await dejaTraite(cleVente)) return json({ recu: true, doublon: true });

  const client = session.customer_details || {};
  const email = client.email || session.customer_email;
  const nom = (client.name || '').trim();
  const prenom = nom.split(' ')[0] || '';
  const tel = client.phone || '';
  const montant = typeof session.amount_total === 'number' ? euros(session.amount_total) : '';
  const remise = session.total_details && session.total_details.amount_discount ? euros(session.total_details.amount_discount) : '';
  const champ = cle => { const c = (session.custom_fields || []).find(f => f.key === cle); return c && c.dropdown ? c.dropdown.value : ''; };
  const demarrage = champ('demarrage') === 'immediat' ? 'dès le démarrage du groupe (avant la fin des 14 jours)' : champ('demarrage') === 'attendre14j' ? 'après son délai de rétractation de 14 jours' : 'non précisé';
  const formulaire = env.FORMULAIRE_DEPART_URL
    ? `Étape suivante : remplis ton formulaire de départ (5 minutes) :\n${env.FORMULAIRE_DEPART_URL}\n\nJe te renvoie ton plan écrit sous 48 h.`
    : `Étape suivante : je t'envoie ton formulaire de départ sous 48 h, puis ton plan écrit.`;

  if (email) {
    await envoyerEmail(env, {
      to: nom ? { email, name: nom } : { email },
      replyTo: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
      subject: 'Ta place dans le Groupe 30 est réservée',
      text: `Salut${prenom ? ' ' + prenom : ''},\n\nTa place dans le Groupe 30 est réservée${montant ? ` (paiement de ${montant} reçu)` : ''}. Bienvenue !\n\n${formulaire}\n\nAvant le démarrage, je t'ajoute au groupe WhatsApp avec ton accord, au numéro indiqué lors du paiement.\n\nPas convaincu pendant les 7 premiers jours du groupe ? Écris-moi, je te rembourse les 29 €.\n\nÀ très vite,\nThibault — TiboBody`,
    });
  }
  // email à TiboBody (si un envoi échoue, Stripe réessaiera plus tard)
  await envoyerEmail(env, {
    to: { email: EMAIL_CONTACT, name: NOM_EXPEDITEUR },
    ...(email ? { replyTo: nom ? { email, name: nom } : { email } } : {}),
    subject: `Nouvelle inscription Groupe 30 (${meta.cohorte || ''})${montant ? ' — ' + montant : ''}`,
    text: `Groupe : ${meta.cohorte || '?'}\nClient : ${nom || 'non renseigné'}\nEmail : ${email || 'non renseigné'}\nTéléphone (WhatsApp) : ${tel || 'non renseigné'}\nDémarrage demandé : ${demarrage}\nMontant payé : ${montant || '?'}${remise ? `\nRéduction (code promo) : ${remise}` : ''}\nDate : ${dateHeureParis(new Date((session.created || Date.now() / 1000) * 1000))}\n\nÀ faire : envoyer le formulaire de départ${env.FORMULAIRE_DEPART_URL ? ' (déjà envoyé automatiquement)' : ''}, renvoyer le plan sous 48 h, ajouter au groupe WhatsApp.\n\nDétail dans Stripe : https://dashboard.stripe.com/${String(env.STRIPE_SECRET_KEY).startsWith('sk_test_') ? 'test/' : ''}checkout/sessions/${session.id}`,
  });
  await marquerTraite(cleVente); // seulement une fois les emails partis (sinon Stripe réessaie)
  return json({ recu: true, envoye: true });
}

// Anti-doublon (Stripe peut envoyer deux fois le même événement)
async function dejaTraite(cle) {
  if (typeof caches === 'undefined') return false;
  try { return !!(await caches.default.match(new Request(`https://doublons.tibobody.invalid/${cle}`))); }
  catch (e) { console.warn('doublon', e.message); return false; }
}
async function marquerTraite(cle) {
  if (typeof caches === 'undefined') return;
  try { await caches.default.put(new Request(`https://doublons.tibobody.invalid/${cle}`), new Response('1', { headers: { 'Cache-Control': 'max-age=604800' } })); }
  catch (e) { console.warn('doublon', e.message); }
}

async function signatureStripeValide(brut, entete, secret) {
  if (!entete) return false;
  const morceaux = entete.split(',').map(p => p.trim());
  const t = (morceaux.find(p => p.startsWith('t=')) || '').slice(2);
  const v1 = morceaux.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
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
