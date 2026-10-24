const { CORPUS } = require("../../corpus.js");
const MIROIR = require("../../miroir.json");

// Fonction « background » : Netlify la laisse tourner jusqu'à 15 minutes (pas de limite de 10 s).
const MODEL_CHOIX = "mistral-small-latest";
const MODEL_FICHE = "mistral-large-latest";
const INTROUVABLE = "À VÉRIFIER (non trouvé dans les sources)";

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");
const compact = (t) => t.replace(/ {3,}/g, " ¦ ").replace(/\n{2,}/g, "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Appel Mistral : si « Rate limit » (429), on attend patiemment et on réessaie
async function mistral(model, messages, max) {
  let derniere = "";
  for (let t = 0; t < 8; t++) {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.MISTRAL_API_KEY },
      body: JSON.stringify({ model, temperature: 0.1, max_tokens: max, response_format: { type: "json_object" }, messages }),
    });
    if (r.status === 429 || r.status >= 500) { derniere = r.status + " " + (await r.text()).slice(0, 150); await sleep(4000 * (t + 1)); continue; }
    if (!r.ok) throw new Error("Mistral " + r.status + " : " + (await r.text()).slice(0, 300));
    const j = await r.json();
    try { return JSON.parse(j.choices[0].message.content); } catch (e) { derniere = "réponse JSON invalide"; await sleep(1500); }
  }
  throw new Error("Mistral n'a pas répondu après plusieurs essais (" + derniere + "). Ta clé est probablement limitée : réessaie dans 1 minute.");
}

function retrieveContent(titre, classe, discipline, extraits) {
  const STOP = new Set(["lecon", "dans", "pour", "avec", "sont", "leur", "leurs", "cette", "entre", "chez", "plus", "tout", "tous", "elle", "elles", "nous", "vous", "etre", "avoir", "fait", "faire", "dont", "mais", "ainsi"]);
  const words = [...new Set(norm(titre).split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)))];
  const scored = CORPUS.map((c) => {
    if (c.toujours) return { c, s: 100, always: true };
    if (c.classe && c.classe !== classe) return { c, s: 0 };
    const t = norm(c.titre + " " + c.texte);
    let s = 0;
    words.forEach((w) => { if (t.includes(w)) s += 2; });
    if (discipline && c.discipline && norm(c.discipline).includes(norm(discipline))) s += 1;
    return { c, s };
  });
  const seuil = Math.min(4, 2 * Math.max(1, words.length));
  const chosen = scored.filter((x) => x.always || x.s >= seuil).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.c);
  let found = chosen.some((c) => !c.toujours);
  if (extraits && extraits.trim()) {
    chosen.push({ id: "EXTRAIT-UTILISATEUR", titre: "Extrait collé par l'enseignant", source: "Collé dans la page", texte: extraits.trim().slice(0, 12000) });
    found = true;
  }
  return { chosen, found };
}

// Cœur du travail (séparé du handler pour pouvoir être testé)
async function run(b, put) {
  if (!process.env.MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY manquante dans Netlify (Site configuration > Environment variables), puis refaire un déploiement.");
  if (!b.titre || !b.classe) throw new Error("Titre et classe obligatoires.");

  await put({ status: "running", step: "Choix de la démarche…" });
  const menu = MIROIR.map((m) => m.id + " | " + m.titre + " | niveau: " + m.niveau).join("\n");
  const choix = await mistral(MODEL_CHOIX, [
    { role: "system", content: 'Tu choisis, dans un menu, la fiche modèle dont la démarche convient le mieux à une leçon. Réponds en JSON : {"ids":["ID1","ID2"]} avec 1 ou 2 identifiants pris EXACTEMENT dans le menu. Tiens compte de la classe (CI/CP = lecture par mot-clé et nombres ; CE/CM = lecture de textes, grammaire, etc.).' },
    { role: "user", content: "Leçon : " + b.titre + "\nClasse : " + b.classe + "\nDiscipline : " + (b.discipline || "non précisée") + "\n\nMENU :\n" + menu },
  ], 80);
  const models = (choix.ids || []).map((id) => MIROIR.find((m) => m.id === id)).filter(Boolean).slice(0, 2);
  if (!models.length) throw new Error("Aucune démarche adaptée trouvée. Précise la discipline (ex : Géographie).");

  const { chosen, found } = retrieveContent(b.titre, b.classe, b.discipline, b.extraits);
  const modelsTxt = models.map((m) => "[" + m.id + "] (" + m.source + ")\n" + compact(m.texte).slice(0, 12000)).join("\n\n---\n\n");
  const contentTxt = chosen.map((c) => "[" + c.id + "] (" + c.titre + " — " + c.source + ")\n" + c.texte).join("\n\n---\n\n");

  const system = `Tu es un assistant de préparation de fiches pédagogiques pour l'enseignement élémentaire au Sénégal.
Tu disposes de deux types de sources :
A) MODÈLES DE DÉMARCHE (extraits de "Le Miroir adapté au CEB") : ils servent UNIQUEMENT à respecter la démarche (phases, ordre, nature des questions du maître et des activités des élèves). Les faits, chiffres, noms et textes de ces modèles concernent d'AUTRES leçons : tu ne les reprends JAMAIS dans la fiche, sauf si la leçon demandée est exactement la même.
B) SOURCES DE CONTENU : seules autorisées pour les faits, chiffres, noms propres, localisations, définitions, CB, palier, OA, OS, contenus, documentation.
RÈGLES ABSOLUES (anti-hallucination) :
1. Aucun fait, chiffre, nom ou définition venant de ta mémoire. Si une information factuelle n'est pas dans les sources de contenu, écris exactement "${INTROUVABLE}".
2. ${found ? "Des sources de contenu existent : utilise-les." : 'AUCUNE source de contenu n\'existe pour cette leçon : produis seulement l\'ossature de la démarche ; toute réponse factuelle attendue des élèves, CB, palier, OA, OS, contenus = "' + INTROUVABLE + '".'}
3. Les étapes de la fiche reprennent les phases du modèle choisi (mêmes noms, même ordre). Les questions du maître et les activités des élèves sont adaptées à la leçon, détaillées (vraies questions, réponses attendues), sans inventer de faits.
4. Pas de colonne "justifications" : seulement Étape / Part du Maître / Part des Élèves. Applique la source REGLES-GENERATION (sous-domaine imposé selon la discipline, palier tiré du contenu fourni, prénoms sénégalais, objectifs "Au terme de la leçon, l'élève devra être capable de...").
5. Liste dans "a_verifier" tout point incertain ou absent des sources.
6. Réponds en français, uniquement en JSON, selon ce schéma exact :
{"entete":{"classe":"","sous_domaine":"","duree":""},
 "infos":{"discipline":"","cb":"","palier":"","oa":"","os":"","contenus":"","moyens_materiels":"","moyens_pedagogiques":"","documentation":""},
 "etapes":[{"etape":"","maitre":"","eleves":""}],
 "a_verifier":[""]}`;
  const user = `Leçon : ${b.titre}\nClasse : ${b.classe}\nDiscipline / sous-domaine : ${b.discipline || "non précisé"}\nDurée : ${b.duree || "45 minutes"}\n\n=== A) MODÈLES DE DÉMARCHE ===\n${modelsTxt}\n\n=== B) SOURCES DE CONTENU ===\n${contentTxt}`;

  await put({ status: "running", step: "Rédaction de la fiche (environ 1 minute)…" });
  const fiche = await mistral(MODEL_FICHE, [{ role: "system", content: system }, { role: "user", content: user }], 4500);

  fiche.a_verifier = fiche.a_verifier || [];
  if (!found) fiche.a_verifier.unshift("Aucun texte de contenu trouvé pour cette leçon : seule la démarche est fiable. Colle un extrait du Guide CEB ou ajoute-le dans corpus.js.");
  const allowed = (contentTxt + " " + (b.duree || "") + " " + b.titre + " " + b.classe).replace(/\s/g, "");
  const nums = [...new Set(JSON.stringify({ i: fiche.infos, e: fiche.etapes }).match(/\d[\d  .,]*\d|\d{2,}/g) || [])].map((n) => n.trim());
  nums.filter((n) => !allowed.includes(n.replace(/\s/g, "")) && !/^\d{1,2}$/.test(n))
    .forEach((n) => fiche.a_verifier.push("Chiffre « " + n + " » absent des sources de contenu : à vérifier."));
  fiche.sources_detail = [...models.map((m) => m.id + " — " + m.source), ...chosen.filter((x) => !x.toujours).map((x) => x.id + " — " + x.source)];
  return fiche;
}

exports.run = run;

exports.handler = async (event) => {
  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const id = String(b.id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60);
  if (!id) return { statusCode: 400, body: "id manquant" };
  try {
    const { connectLambda, getStore } = await import("@netlify/blobs");
    connectLambda(event);
    const store = getStore({ name: "fiches", consistency: "strong" });
    const put = (o) => store.setJSON(id, o);
    try {
      const fiche = await run(b, put);
      await put({ status: "done", fiche });
    } catch (e) {
      await put({ status: "error", erreur: String(e.message || e) });
    }
  } catch (e) {
    console.error("Stockage indisponible :", e);
  }
  return { statusCode: 202 };
};
