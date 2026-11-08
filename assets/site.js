// =====================================================================
// TiboBody — scripts communs à toutes les pages
// =====================================================================
const FORMSPREE_URL = 'https://formspree.io/f/xnpjdajy';

// ---------------------------------------------------------------------
// Écran de chargement : intro complète à la première page vue, version courte ensuite
// ---------------------------------------------------------------------
(function(){
  const overlay = document.getElementById('pageTransition');
  if(!overlay) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = false;
  try{ seen = sessionStorage.getItem('tb_intro') === '1'; sessionStorage.setItem('tb_intro','1'); }catch(e){}
  if(seen) overlay.classList.add('pt-fast');
  const minTime = reduce ? 150 : (seen ? 850 : 2100);
  const t0 = performance.now();
  requestAnimationFrame(()=> overlay.classList.add('pt-play'));
  let done = false;
  function reveal(){
    if(done) return; done = true;
    setTimeout(()=> overlay.classList.add('hide'), Math.max(0, minTime - (performance.now() - t0)));
  }
  if(document.readyState === 'complete') reveal(); else window.addEventListener('load', reveal);
  setTimeout(reveal, 4500); // sécurité si une ressource bloque le chargement
  // retour arrière du navigateur : ne pas rester bloqué sur l'écran noir
  window.addEventListener('pageshow', e=>{ if(e.persisted){ overlay.classList.remove('pt-play'); overlay.classList.add('hide'); } });
  // transition en changeant de page du site
  document.addEventListener('click', e=>{
    const a = e.target.closest('a'); if(!a) return;
    const href = a.getAttribute('href') || '';
    if(!href || href.startsWith('#') || /^(mailto:|tel:|javascript:|https?:)/i.test(href)) return;
    if(a.target === '_blank' || a.hasAttribute('download') || /\.pdf($|\?)/i.test(href) || href.startsWith('/api/')) return;
    if(e.metaKey || e.ctrlKey || e.shiftKey) return;
    const cible = new URL(href, location.href);
    const norm = p => p.replace(/\/index\.html$/, '/');
    if(cible.hash && norm(cible.pathname) === norm(location.pathname)) return; // même page : simple défilement
    e.preventDefault();
    overlay.classList.remove('pt-play'); overlay.classList.remove('hide');
    setTimeout(()=>{ window.location.href = href; }, 420);
  });
})();

// ---------------------------------------------------------------------
// Menu mobile
// ---------------------------------------------------------------------
(function(){
  const burger = document.getElementById('burger'), drawer = document.getElementById('drawer');
  if(!burger || !drawer) return;
  burger.addEventListener('click', ()=>{ const o = drawer.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
  drawer.addEventListener('click', e=>{ if(e.target.closest('a')){ drawer.classList.remove('open'); burger.setAttribute('aria-expanded','false'); } });
})();

// Visuels protégés : pas de clic droit ni de glisser-déposer
document.addEventListener('contextmenu', e=>{ if(e.target.closest('.wm')) e.preventDefault(); });
document.addEventListener('dragstart', e=>{ if(e.target.closest('.wm')) e.preventDefault(); });

// ---------------------------------------------------------------------
// Formulaires (contact + défi 7 jours)
// ---------------------------------------------------------------------
function etatFormulaire(form, type, message){
  const ok = form.querySelector('.ok'), err = form.querySelector('.err');
  if(ok) ok.classList.toggle('show', type === 'ok');
  if(err){ err.classList.toggle('show', type === 'err'); if(type === 'err' && message) err.textContent = message; }
}
async function envoyerFormspree(donnees){
  const res = await fetch(FORMSPREE_URL, { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body: JSON.stringify(donnees) });
  if(!res.ok) throw new Error('formspree');
}

// formulaire de contact -> Formspree
(function(){
  const form = document.getElementById('contactForm');
  if(!form) return;
  form.addEventListener('submit', async e=>{
    e.preventDefault();
    if(form.querySelector('.hp input').value) return; // robot
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    etatFormulaire(form, null);
    try{
      await envoyerFormspree({
        _subject: 'Nouveau message — formulaire de contact tibobody.fr',
        prenom: form.prenom.value.trim(), email: form.email.value.trim(),
        sujet: form.sujet.value, message: form.message.value.trim(),
      });
      form.reset(); etatFormulaire(form, 'ok');
    }catch(err){
      etatFormulaire(form, 'err', "L'envoi n'a pas marché. Réessaie, ou écris directement à contact@tibobody.fr.");
    }
    btn.disabled = false;
  });
})();

// défi 7 jours -> email automatique avec le PDF (Brevo) + copie du contact (Formspree)
(function(){
  const form = document.getElementById('defiForm');
  if(!form) return;
  form.addEventListener('submit', async e=>{
    e.preventDefault();
    if(form.querySelector('.hp input').value) return; // robot
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    etatFormulaire(form, null);
    const prenom = form.prenom.value.trim(), email = form.email.value.trim();
    try{
      const res = await fetch('/api/defi', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ prenom, email, majeur: form.majeur.checked, accord: form.accord.checked }) });
      const data = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data.error || '');
      envoyerFormspree({ _subject: 'Nouvelle inscription — défi 7 jours', prenom, email, majeur: 'oui', accepte_emails: 'oui' }).catch(()=>{});
      form.reset(); etatFormulaire(form, 'ok');
    }catch(err){
      etatFormulaire(form, 'err', err.message || "L'envoi n'a pas marché. Réessaie dans un instant.");
    }
    btn.disabled = false;
  });
})();

// ---------------------------------------------------------------------
// Groupe 30 : places restantes + paiement Stripe
// ---------------------------------------------------------------------
(function(){
  const boutons = document.querySelectorAll('[data-pay]');
  const affichages = document.querySelectorAll('[data-places]');
  if(!boutons.length && !affichages.length) return;
  let etat = null; // { max, restantes, ouvert }

  function appliquer(){
    if(!etat) return;
    const complet = etat.restantes <= 0, ferme = !etat.ouvert;
    affichages.forEach(el=>{
      el.textContent = ferme ? 'Inscriptions bientôt ouvertes' : complet ? 'Groupe complet' : etat.restantes === 1 ? 'Dernière place disponible' : `${etat.restantes} places restantes sur ${etat.max}`;
      el.hidden = false;
    });
    boutons.forEach(b=>{
      if(!b.dataset.label) b.dataset.label = b.textContent;
      b.textContent = ferme ? 'Inscriptions bientôt ouvertes' : complet ? 'Groupe complet' : b.dataset.label;
      b.toggleAttribute('disabled', ferme || complet);
    });
  }
  fetch('/api/places', { cache:'no-store' }).then(r=>r.ok ? r.json() : null).then(d=>{
    if(d && d.groupe30){ etat = { ...d.groupe30, ouvert: d.ouvert !== false }; appliquer(); }
  }).catch(()=>{});

  boutons.forEach(b=> b.addEventListener('click', async e=>{
    e.preventDefault();
    if(b.disabled) return;
    const msg = document.getElementById('payMsg');
    if(msg) msg.textContent = '';
    if(!b.dataset.label) b.dataset.label = b.textContent;
    b.disabled = true; b.textContent = 'Redirection vers le paiement…';
    try{
      const res = await fetch('/api/create-checkout-session', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ offre:'groupe30' }) });
      const data = await res.json().catch(()=>({}));
      if(res.ok && data.url){ window.location.href = data.url; return; }
      if(data.complet && etat){ etat.restantes = 0; }
      throw new Error(data.error || "Le paiement n'a pas pu démarrer, réessaie dans un instant.");
    }catch(err){
      if(msg) msg.textContent = err.message;
      b.disabled = false; b.textContent = b.dataset.label; appliquer();
    }
  }));
  // retour depuis Stripe avec le bouton « précédent » : on remet les boutons en état
  window.addEventListener('pageshow', e=>{ if(e.persisted){ boutons.forEach(b=>{ b.disabled = false; if(b.dataset.label) b.textContent = b.dataset.label; }); appliquer(); } });
})();
