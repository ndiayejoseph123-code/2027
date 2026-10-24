const { CORPUS } = require("../../corpus.js");
const MIROIR = require("../../miroir.json");

// Netlify gratuit coupe toute fonction qui dépasse ~10 secondes.
// La fiche est donc générée en plusieurs petits appels (models, phases, infos, phase).
// Modèle rapide. Tu peux essayer "mistral-medium-latest" (meilleur mais plus lent).
const MODEL = "mistral-small-latest";
const INTROUVABLE = "À VÉRIFIER (non trouvé dans les sources)";
const H = { "Content-Type": "application/json" };
const out = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");
const compact = (t) => t.replace(/ {3,}/g, " ¦ ").replace(/\n{2,}/g, "\n");

async function mistral(messages, max) {
  for (let t = 0; t < 2; t++) {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.MISTRAL_API_KEY },
      body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: max, response_format: { type: "json_object" }, messages }),
    });
    if (r.status === 429 && t === 0) { await new Promise((ok) => setTimeout(ok, 1200)); continue; }
    if (!r.ok) throw new Error("Mistral " + r.status + " : " + (await r.text()).slice(0, 300));
    const j = await r.json();
    return JSON.parse(j.choices[0].message.content);
  }
}

// Contenu officiel (corpus.js + extrait collé)
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

function context(b) {
  const models = (b.ids || []).map((id) => MIROIR.find((m) => m.id === id)).filter(Boolean).slice(0, 2);
  const { chosen, found } = retrieveContent(b.titre, b.classe, b.discipline, b.extraits);
  const modelsTxt = models.map((m) => "[" + m.id + "] (" + m.source + ")\n" + compact(m.texte).slice(0, 12000)).join("\n\n---\n\n");
  const contentTxt = chosen.map((c) => "[" + c.id + "] (" + c.titre + " — " + c.source + ")\n" + c.texte).join("\n\n---\n\n");
  return { models, chosen, found, modelsTxt, contentTxt };
}

function rules(found) {
  return `Tu es un assistant de préparation de fiches pédagogiques pour l'enseignement élémentaire au Sénégal.
Tu disposes de deux types de sources :
A) MODÈLES DE DÉMARCHE (extraits de "Le Miroir adapté au CEB") : ils servent UNIQUEMENT à respecter la démarche (phases, ordre, nature des questions du maître et des activités des élèves). Les faits, chiffres, noms et textes de ces modèles concernent d'AUTRES leçons : tu ne les reprends JAMAIS dans la fiche, sauf si la leçon demandée est exactement la même.
B) SOURCES DE CONTENU : seules autorisées pour les faits, chiffres, noms propres, localisations, définitions, CB, palier, OA, OS, contenus, documentation.
RÈGLES ABSOLUES (anti-hallucination) :
1. Aucun fait, chiffre, nom ou définition venant de ta mémoire. Si une information factuelle n'est pas dans les sources de contenu, écris exactement "${INTROUVABLE}".
2. ${found ? "Des sources de contenu existent : utilise-les." : 'AUCUNE source de contenu n\'existe pour cette leçon : toute réponse factuelle attendue des élèves, CB, palier, OA, OS, contenus = "' + INTROUVABLE + '".'}
3. Pas de colonne "justifications". Applique la source REGLES-GENERATION (sous-domaine imposé selon la discipline, palier tiré du contenu fourni, prénoms sénégalais, objectifs "Au terme de la leçon, l'élève devra être capable de...").
4. Réponds en français, uniquement en JSON.`;
}

function suspects(obj, c, b) {
  const allowed = (c.contentTxt + " " + (b.duree || "") + " " + b.titre + " " + b.classe).replace(/\s/g, "");
  const nums = [...new Set(JSON.stringify(obj).match(/\d[\d  .,]*\d|\d{2,}/g) || [])].map((n) => n.trim());
  return nums.filter((n) => !allowed.includes(n.replace(/\s/g, "")) && !/^\d{1,2}$/.test(n)).map((n) => "Chiffre « " + n + " » absent des sources de contenu : à vérifier.");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return out(405, {});
    if (!process.env.MISTRAL_API_KEY) return out(500, { erreur: "MISTRAL_API_KEY manquante dans Netlify (Site configuration > Environment variables), puis refaire un déploiement." });
    const b = JSON.parse(event.body || "{}");
    if (!b.titre || !b.classe) return out(400, { erreur: "Titre et classe obligatoires." });

    // ---- Étape 1 : choisir la démarche modèle
    if (b.step === "models") {
      const menu = MIROIR.map((m) => m.id + " | " + m.titre + " | niveau: " + m.niveau).join("\n");
      const r = await mistral([
        { role: "system", content: 'Tu choisis, dans un menu, la fiche modèle dont la démarche convient le mieux à une leçon. Réponds en JSON : {"ids":["ID1","ID2"]} avec 1 ou 2 identifiants pris EXACTEMENT dans le menu. Tiens compte de la classe (CI/CP = lecture par mot-clé et nombres ; CE/CM = lecture de textes, grammaire, etc.).' },
        { role: "user", content: "Leçon : " + b.titre + "\nClasse : " + b.classe + "\nDiscipline : " + (b.discipline || "non précisée") + "\n\nMENU :\n" + menu },
      ], 80);
      const valid = new Set(MIROIR.map((m) => m.id));
      const ids = (r.ids || []).filter((id) => valid.has(id)).slice(0, 2);
      if (!ids.length) return out(200, { erreur: "Je n'ai pas trouvé de démarche adaptée. Précise la discipline (ex : Géographie)." });
      return out(200, { ids });
    }

    const c = context(b);
    if (!c.models.length) return out(400, { erreur: "Démarche manquante." });

    // ---- Étape 2 : liste des phases du modèle
    if (b.step === "phases") {
      const r = await mistral([
        { role: "system", content: 'Tu lis une fiche modèle et tu listes, dans l\'ordre, les noms des phases de sa démarche (colonne PHASES), sans les justifier. Réponds en JSON : {"phases":["Révision","..."]}. Entre 3 et 10 phases, noms courts tels qu\'ils figurent dans le modèle.' },
        { role: "user", content: c.models[0].texte.slice(0, 12000) },
      ], 200);
      const phases = (r.phases || []).map(String).slice(0, 10);
      if (!phases.length) return out(200, { erreur: "Phases introuvables dans le modèle." });
      return out(200, { phases });
    }

    // ---- Étape 3 : en-tête et informations générales
    if (b.step === "infos") {
      const system = rules(c.found) + `\nSchéma exact :\n{"entete":{"classe":"","sous_domaine":"","duree":""},"infos":{"discipline":"","cb":"","palier":"","oa":"","os":"","contenus":"","moyens_materiels":"","moyens_pedagogiques":"","documentation":""},"a_verifier":[""]}`;
      const user = `Leçon : ${b.titre}\nClasse : ${b.classe}\nDiscipline : ${b.discipline || "non précisé"}\nDurée : ${b.duree || "45 minutes"}\n\n=== A) MODÈLES DE DÉMARCHE ===\n${c.modelsTxt.slice(0, 5000)}\n\n=== B) SOURCES DE CONTENU ===\n${c.contentTxt}`;
      const f = await mistral([{ role: "system", content: system }, { role: "user", content: user }], 800);
      f.a_verifier = (f.a_verifier || []).concat(suspects(f.infos, c, b));
      if (!c.found) f.a_verifier.unshift("Aucun texte de contenu trouvé pour cette leçon : seule la démarche est fiable. Colle un extrait du Guide CEB ou ajoute-le dans corpus.js.");
      f.sources_detail = [...c.models.map((m) => m.id + " — " + m.source), ...c.chosen.filter((x) => !x.toujours).map((x) => x.id + " — " + x.source)];
      return out(200, f);
    }

    // ---- Étape 4 : une phase à la fois
    if (b.step === "phase") {
      const system = rules(c.found) + `\nTu rédiges UNE SEULE phase de la fiche, en suivant la façon dont le modèle conduit cette phase (types de questions du maître, activités des élèves), adaptée à la leçon. Schéma exact :\n{"maitre":"","eleves":"","a_verifier":[""]}`;
      const user = `Leçon : ${b.titre}\nClasse : ${b.classe}\nPHASE À RÉDIGER : ${b.phase}\nObjectif spécifique de la fiche : ${(b.infos && b.infos.os) || ""}\nContenus : ${(b.infos && b.infos.contenus) || ""}\n\n=== A) MODÈLES DE DÉMARCHE ===\n${c.modelsTxt}\n\n=== B) SOURCES DE CONTENU ===\n${c.contentTxt}`;
      const f = await mistral([{ role: "system", content: system }, { role: "user", content: user }], 700);
      f.a_verifier = (f.a_verifier || []).concat(suspects({ m: f.maitre, e: f.eleves }, c, b));
      return out(200, { etape: b.phase, maitre: f.maitre || "", eleves: f.eleves || "", a_verifier: f.a_verifier });
    }

    return out(400, { erreur: "Étape inconnue." });
  } catch (e) {
    return out(500, { erreur: String(e.message || e) });
  }
};
