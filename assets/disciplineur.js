// =====================================================================
// Animation « Disciplineur » : dessinée en direct sur un canvas, fond transparent
// Reproduit la vidéo : le client monte seul, s'arrête au jour 24, le disciplineur
// le relève et ils arrivent ensemble en haut au jour 70. Boucle de 19 s.
// =====================================================================
(function(){
  const canvas = document.getElementById('defAnim');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DUREE = 19, W = 100, H = 60, HAUT = 24;            // marche : 100 de large, 60 de haut, palier à la 24e
  const BLANC = '#F4EFEA', ROUGE = '#F0462B';
  const DISPLAY = "'Saira Extra Condensed','Arial Narrow',Impact,sans-serif";
  const MONO = "ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace";
  const L = { cuisse:92, tibia:92, bras:68, avantBras:62, tronc:138, tete:25, bassin:150 };

  // ---------- outils ----------
  const clamp = (v,a,b)=> Math.max(a, Math.min(b, v));
  const lerp = (a,b,k)=> a + (b-a)*k;
  const lerpP = (p,q,k)=> ({ x:lerp(p.x,q.x,k), y:lerp(p.y,q.y,k) });
  const ease = k=> k<.5 ? 2*k*k : 1 - Math.pow(-2*k+2, 2)/2;
  const rampe = (t,a,b)=> clamp((t-a)/(b-a), 0, 1);
  const fen = (t,a,b,c,d)=> Math.min(ease(rampe(t,a,b)), 1 - ease(rampe(t,c,d)));   // monte a→b, descend c→d
  // images clés [temps, valeur, courbe] ; courbe : l (linéaire), o (ralentit), i (accélère), s (douce)
  function cle(t, k){
    if(t <= k[0][0]) return k[0][1];
    for(let n=1; n<k.length; n++){
      if(t <= k[n][0]){
        const [t0,v0] = k[n-1], [t1,v1,c] = k[n];
        let r = (t-t0)/(t1-t0);
        if(c==='o') r = 1 - (1-r)*(1-r); else if(c==='i') r = r*r; else if(c==='s') r = ease(r);
        return lerp(v0, v1, r);
      }
    }
    return k[k.length-1][1];
  }

  // ---------- l'escalier ----------
  const sol = x=> -clamp(x/W - .5, -40, HAUT) * H;                   // ligne moyenne de l'escalier
  const marche = n=> ({ x:(n+.5)*W, y:-Math.min(n, HAUT)*H });        // milieu du dessus de la marche n

  function ik(a, b, la, lb, versAvant){                                // genou / coude
    const dx = b.x-a.x, dy = b.y-a.y;
    let d = Math.hypot(dx,dy); const dm = la+lb-.5;
    if(d > dm){ b = { x:a.x+dx/d*dm, y:a.y+dy/d*dm }; d = dm; }
    const cosA = clamp((la*la + d*d - lb*lb)/(2*la*d), -1, 1), A = Math.acos(cosA), ang = Math.atan2(dy,dx);
    const p1 = { x:a.x+la*Math.cos(ang+A), y:a.y+la*Math.sin(ang+A) };
    const p2 = { x:a.x+la*Math.cos(ang-A), y:a.y+la*Math.sin(ang-A) };
    return { j: (versAvant ? p1.x>p2.x : p1.x<p2.x) ? p1 : p2, fin:b };
  }

  // pose d'un personnage : u = avancée (en marches), k = effondrement 0..1, mains = cibles éventuelles
  function pose(u, k, mainA, poidsA){
    const pied = p=>{                                                  // pied p (0 ou 1) posé une marche sur deux
      const v = (u - p)/2, b = Math.floor(v), f = clamp((v - b - .5)*2, 0, 1), fe = ease(f);
      const de = marche(2*b+p), vers = marche(2*b+p+2);
      const q = lerpP(de, vers, fe); q.y -= Math.sin(Math.PI*f)*34; return q;
    };
    const pA = pied(0), pB = pied(1);
    let hanche = { x:u*W, y:sol(u*W) - L.bassin };
    hanche = { x:hanche.x - 22*k, y:hanche.y + 92*k };
    const pench = .12 + .9*k;                                          // inclinaison du buste
    const dir = { x:Math.sin(pench), y:-Math.cos(pench) };
    const epaule = { x:hanche.x + dir.x*L.tronc, y:hanche.y + dir.y*L.tronc };
    const tete = { x:hanche.x + dir.x*(L.tronc+L.tete+8), y:hanche.y + dir.y*(L.tronc+L.tete+8) };
    const jA = ik(hanche, pA, L.cuisse, L.tibia, true), jB = ik(hanche, pB, L.cuisse, L.tibia, true);
    const ph = Math.PI*u;
    const bras = (s)=>{                                                // balancier opposé aux jambes
      const th = s*Math.sin(ph)*.55*(1-k) + pench*.4;
      const coude = { x:epaule.x + Math.sin(th)*L.bras, y:epaule.y + Math.cos(th)*L.bras };
      const th2 = th + .55;
      return { coude, main:{ x:coude.x + Math.sin(th2)*L.avantBras, y:coude.y + Math.cos(th2)*L.avantBras } };
    };
    let bA = bras(-1), bB = bras(1);
    // effondré : les mains cherchent appui sur la marche
    if(k > 0){
      const appui = marche(Math.round(u)+1); appui.x -= 30;
      const r = ik(epaule, appui, L.bras, L.avantBras, false);
      bA = { coude:lerpP(bA.coude, r.j, k), main:lerpP(bA.main, r.fin, k) };
      const r2 = ik(epaule, { x:appui.x-40, y:appui.y }, L.bras, L.avantBras, false);
      bB = { coude:lerpP(bB.coude, r2.j, k), main:lerpP(bB.main, r2.fin, k) };
    }
    if(mainA && poidsA > 0){                                           // bras tendu vers l'autre
      const r = ik(epaule, mainA, L.bras, L.avantBras, false);
      bA = { coude:lerpP(bA.coude, r.j, poidsA), main:lerpP(bA.main, r.fin, poidsA) };
    }
    return { hanche, epaule, tete, jA, jB, bA, bB };
  }

  function dessinePerso(P, coul, nom, alpha, decalNom){
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = coul; ctx.shadowBlur = 22;
    const membre = (a,j,b,op)=>{ ctx.globalAlpha = alpha*op; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(j.x,j.y); ctx.lineTo(b.x,b.y); ctx.stroke(); };
    ctx.strokeStyle = coul; ctx.lineWidth = 15;
    membre(P.hanche, P.jB.j, P.jB.fin, .45);                          // membres arrière, plus pâles
    membre(P.epaule, P.bB.coude, P.bB.main, .45);
    membre(P.epaule, P.hanche, P.hanche, 1);                          // buste
    membre(P.hanche, P.jA.j, P.jA.fin, 1);
    membre(P.epaule, P.bA.coude, P.bA.main, 1);
    ctx.globalAlpha = alpha; ctx.fillStyle = coul;
    ctx.beginPath(); ctx.arc(P.tete.x, P.tete.y, L.tete, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `700 28px ${MONO}`; ctx.textAlign = 'center';
    if('letterSpacing' in ctx) ctx.letterSpacing = '5px';
    ctx.globalAlpha = alpha*.95;
    ctx.fillText(nom, P.tete.x + (decalNom||0), P.tete.y - L.tete - 22);
    ctx.restore();
  }

  function rendu(t){
    const S = canvas.width / 1000;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.setTransform(S,0,0,S,0,0);
    const glob = Math.min(rampe(t,0,.6), 1 - rampe(t,18.3,19));

    // chronologie (reprise de la vidéo)
    const uC = cle(t, [[0,0],[5.6,7.6,'l'],[6.8,9,'o'],[10.8,9],[11.8,10.2,'i'],[14.6,23.2,'l'],[15.6,25,'o']]);
    const uD = cle(t, [[0,-14],[4.4,-14],[6.5,8.2,'l'],[7.3,10,'o'],[10.8,10],[11.8,11.6,'i'],[14.6,25.4,'l'],[15.6,28,'o']]);
    const effondre = fen(t, 6.5, 7.4, 9.9, 10.9);
    const tendD = fen(t, 7.9, 8.8, 10.4, 11.6);
    const tendC = fen(t, 9.0, 9.7, 11.4, 12.5);
    const jour = t < 6.8 ? Math.max(1, Math.round(lerp(1, 24, rampe(t,.6,6.8)))) : t < 10.9 ? 24 : Math.round(lerp(24, 70, rampe(t,10.9,15.3)));

    // caméra : suit le client
    const camX = lerp(uC, (uC+uD)/2, ease(rampe(t,10.8,12.5)))*W, camY = sol(camX);
    ctx.save();
    ctx.globalAlpha = glob;
    ctx.translate(470 - camX, 720 - camY);

    // rayons de lumière en haut de l'escalier (fin)
    const ray = rampe(t, 14.4, 15.8);
    if(ray > 0){
      const xh = (HAUT+1.5)*W, yh = -HAUT*H;
      ctx.save(); ctx.globalAlpha = glob*ray*.4;
      [[-90,70],[0,90],[100,60],[180,45]].forEach(([dx,l])=>{
        const g = ctx.createLinearGradient(0, yh-760, 0, yh);
        g.addColorStop(0,'rgba(255,240,230,.0)'); g.addColorStop(.35,'rgba(255,236,226,.16)'); g.addColorStop(1,'rgba(255,236,226,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(xh+dx-l*.3, yh-760); ctx.lineTo(xh+dx+l*.3, yh-760); ctx.lineTo(xh+dx+l, yh); ctx.lineTo(xh+dx-l, yh); ctx.fill();
      });
      ctx.restore();
    }

    // escalier : seulement les contours, pas de fond
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(244,239,234,.30)';
    const n0 = Math.floor(camX/W) - 9, n1 = Math.min(HAUT, Math.floor(camX/W) + 9);
    ctx.beginPath();
    ctx.moveTo(n0*W, -n0*H);
    for(let n=n0; n<n1; n++){ ctx.lineTo((n+1)*W, -n*H); ctx.lineTo((n+1)*W, -(n+1)*H); }
    if(n1 >= HAUT) ctx.lineTo(camX + 900, -HAUT*H); else ctx.lineTo((n1+1)*W, -n1*H);
    ctx.stroke();
    // main courante
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(244,239,234,.42)';
    const rx0 = n0*W, rx1 = Math.min((HAUT+.6)*W, camX + 900);
    ctx.beginPath(); ctx.moveTo(rx0, sol(rx0) - 250); ctx.lineTo(rx1, -((rx1/W)-.5)*H - 250); ctx.stroke();

    // personnages
    const PD0 = pose(uD, 0, null, 0), PC0 = pose(uC, effondre, null, 0);
    const rencontre = lerpP(PD0.epaule, PC0.epaule, .5); rencontre.y += 40;
    const PD = pose(uD, 0, rencontre, tendD);
    const PC = pose(uC, effondre, PD.bA.main, tendC);
    if(uD > -12) dessinePerso(PD, ROUGE, 'DISCIPLINEUR', glob, 0);
    dessinePerso(PC, BLANC, 'CLIENT', glob, effondre*-115);

    // onde quand les mains se rejoignent
    const onde = rampe(t, 9.5, 10.4);
    if(onde > 0 && onde < 1){
      ctx.save(); ctx.globalAlpha = glob*(1-onde)*.9; ctx.strokeStyle = ROUGE; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(PD.bA.main.x, PD.bA.main.y, 20 + onde*70, 0, Math.PI*2); ctx.stroke(); ctx.restore();
    }
    ctx.restore();

    // bords fondus : l'escalier s'efface au lieu d'être coupé net
    ctx.save(); ctx.globalCompositeOperation = 'destination-in';
    const m = ctx.createRadialGradient(480, 600, 180, 480, 600, 540);
    m.addColorStop(0,'rgba(0,0,0,1)'); m.addColorStop(.5,'rgba(0,0,0,1)'); m.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = m; ctx.fillRect(0,0,1000,1000); ctx.restore();

    // textes
    ctx.save(); ctx.globalAlpha = glob; ctx.textAlign = 'center';
    if(t > .6){
      ctx.font = `700 40px ${MONO}`; ctx.textAlign = 'right'; ctx.fillStyle = ROUGE;
      if('letterSpacing' in ctx) ctx.letterSpacing = '8px';
      ctx.fillText('JOUR ' + String(jour).padStart(2,'0'), 950, 950);
      if('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    ctx.textAlign = 'center'; ctx.font = `800 104px ${DISPLAY}`;
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 18;
    const a1 = fen(t, 6.9, 7.5, 9.7, 10.4);
    if(a1 > 0){ ctx.globalAlpha = glob*a1; ctx.fillStyle = BLANC; ctx.fillText("SEUL, TU T'ARRÊTES.", 500, 140); }
    const a2 = rampe(t, 15.6, 16.2);
    if(a2 > 0){
      ctx.globalAlpha = glob*a2;
      ctx.fillStyle = BLANC; ctx.fillText('AVEC UN DISCIPLINEUR,', 500, 130);
      ctx.fillStyle = ROUGE; ctx.fillText('TU MONTES.', 500, 232);
    }
    ctx.restore();
  }

  // ---------- taille, lecture, pause hors écran ----------
  function taille(){
    const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(r.width * dpr);
    if(px && (canvas.width !== px || canvas.height !== px)){ canvas.width = px; canvas.height = px; }
  }
  const fige = new URLSearchParams(location.search).get('anim');
  let t0 = null, tPause = 0, visible = false, raf = 0;
  function boucle(now){
    if(t0 === null) t0 = now - tPause*1000;
    const t = ((now - t0)/1000) % DUREE;
    tPause = t; rendu(t);
    raf = visible ? requestAnimationFrame(boucle) : 0;
  }
  function demarrer(){ if(fige !== null) return; if(!raf){ t0 = null; raf = requestAnimationFrame(boucle); } }
  taille();
  window.addEventListener('resize', ()=>{ taille(); if(!raf) rendu(fige !== null ? parseFloat(fige) : reduce ? 16.8 : tPause); });
  const pret = (document.fonts && document.fonts.load) ? document.fonts.load(`800 40px 'Saira Extra Condensed'`).catch(()=>{}) : Promise.resolve();
  pret.then(()=>{
    if(reduce){ rendu(16.8); return; }                                 // mouvement réduit : image finale fixe
    rendu(0);
    if('IntersectionObserver' in window){
      new IntersectionObserver(es=>{ es.forEach(e=>{ visible = e.isIntersecting; if(visible) demarrer(); }); }, { threshold:.25 }).observe(canvas);
    } else { visible = true; demarrer(); }
  });
  // test : ?anim=12.5 fige l'animation à 12,5 s
  if(fige !== null) pret.then(()=>{ taille(); rendu(parseFloat(fige)); });
})();