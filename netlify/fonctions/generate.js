const { CORPUS } = require("../../corpus.js");
const MIROIR = require("../../miroir.json");

const MODEL = "mistral-large-latest";
const INTROUVABLE = "À VÉRIFIER (non trouvé dans les sources)";

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");

// Compacte la mise en page du PDF (colonnes) pour économiser des jetons
const compact = (t) => t.replace(/ {3,}/g, " ¦ ").replace(/\n{2,}/g, "\n");

async function mistral(messages, max) {
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.MISTRAL_API_KEY },
    body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: max || 3500, response_format: { type: "json_object" }, messages }),
  });
  if (!r.ok) throw new Error("Mistral " + r.status + " : " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

// Étape 1 : choisir la ou les fiches modèles du Miroir qui correspondent à la leçon
async function chooseModels(titre, classe, discipline) {
  const menu = MIROIR.map((m) => m.id + " | " + m.titre + " | niveau: " + m.niveau).join("\n");
  const out = await mistral(
    [
      { role: "system", content: 'Tu choisis, dans un menu, la fiche modèle dont la démarche convient le mieux à une leçon. Réponds en JSON : {"ids":["ID1","ID2"]} avec 1 ou 2 identifiants pris EXACTEMENT dans le menu. Tiens compte de la classe (CI/CP = lecture par mot-clé et nombres ; CE/CM = lecture de textes, grammaire, etc.).' },
      { role: "user", content: "Leçon : " + titre + "\nClasse : " + classe + "\nDiscipline : " + (discipline || "non précisée") + "\n\nMENU :\n" + menu },
    ],
    200
  );
  const valid = new Set(MIROIR.map((m) => m.id));
  return (out.ids || []).filter((id) => valid.has(id)).slice(0, 2).map((id) => MIROIR.find((m) => m.id === id));
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
  // Un seul mot en commun ne suffit pas (ex. « Sénégal ») : il faut au moins 2 mots, ou tous les mots si le titre est court
  const seuil = Math.min(4, 2 * Math.max(1, words.length));
  const chosen = scored.filter((x) => x.always || x.s >= seuil).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.c);
  let found = chosen.some((c) => !c.toujours);
  if (extraits && extraits.trim()) {
    chosen.push({ id: "EXTRAIT-UTILISATEUR", titre: "Extrait collé par l'enseignant", source: "Collé dans la page", texte: extraits.trim().slice(0, 15000) });
    found = true;
  }
  return { chosen, found };
}

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json" };
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, headers: H, body: "{}" };
    if (!process.env.MISTRAL_API_KEY) return { statusCode: 500, headers: H, body: JSON.stringify({ erreur: "MISTRAL_API_KEY manquante dans Netlify (Site settings > Environment variables)." }) };

    const { titre, classe, discipline, duree, extraits } = JSON.parse(event.body || "{}");
    if (!titre || !classe) return { statusCode: 400, headers: H, body: JSON.stringify({ erreur: "Titre et classe obligatoires." }) };

    const models = await chooseModels(titre, classe, discipline);
    const { chosen, found } = retrieveContent(titre, classe, discipline, extraits);

    const modelsTxt = models.map((m) => "[" + m.id + "] (" + m.source + ")\n" + compact(m.texte)).join("\n\n---\n\n");
    const contentTxt = chosen.map((c) => "[" + c.id + "] (" + c.titre + " — " + c.source + ")\n" + c.texte).join("\n\n---\n\n");

    const system = `Tu es un assistant de préparation de fiches pédagogiques pour l'enseignement élémentaire au Sénégal.
Tu disposes de deux types de sources :
A) MODÈLES DE DÉMARCHE (extraits de "Le Miroir adapté au CEB") : ils servent UNIQUEMENT à respecter la démarche (phases, ordre, nature des questions du maître et des activités des élèves). Les faits, chiffres, noms et textes de ces modèles concernent d'AUTRES leçons : tu ne les reprends JAMAIS dans la fiche, sauf si la leçon demandée est exactement la même.
B) SOURCES DE CONTENU : seules autorisées pour les faits, chiffres, noms propres, localisations, définitions, CB, palier, OA, OS, contenus, documentation.
RÈGLES ABSOLUES (anti-hallucination) :
1. Aucun fait, chiffre, nom ou définition venant de ta mémoire. Si une information factuelle n'est pas dans les sources de contenu, écris exactement "${INTROUVABLE}".
2. Les étapes de la fiche reprennent les phases du modèle choisi (mêmes noms de phases, même ordre). Les questions du maître et les activités des élèves sont adaptées à la leçon, sans inventer de faits.
3. ${found ? "Des sources de contenu existent : utilise-les." : "AUCUNE source de contenu n'existe pour cette leçon : produis seulement l'ossature de la démarche ; toute réponse factuelle attendue des élèves, CB, palier, OA, OS, contenus = \"" + INTROUVABLE + "\"."}
4. Pas de colonne "justifications" : la fiche a seulement Étape / Part du Maître / Part des Élèves. Applique la source REGLES-GENERATION (sous-domaine imposé selon la discipline, palier tiré du contenu fourni, prénoms sénégalais, objectifs "Au terme de la leçon, l'élève devra être capable de...").
5. Liste dans "sources_utilisees" les identifiants réellement utilisés (modèles et contenus). Liste dans "a_verifier" tout point incertain ou absent des sources.
6. Réponds en français, uniquement en JSON, selon ce schéma exact :
{"entete":{"classe":"","sous_domaine":"","duree":""},
 "infos":{"discipline":"","cb":"","palier":"","oa":"","os":"","contenus":"","moyens_materiels":"","moyens_pedagogiques":"","documentation":""},
 "etapes":[{"etape":"","maitre":"","eleves":""}],
 "sources_utilisees":[""],
 "a_verifier":[""]}`;

    const user = `Leçon : ${titre}\nClasse : ${classe}\nDiscipline / sous-domaine : ${discipline || "non précisé"}\nDurée : ${duree || "45 minutes"}\n\n=== A) MODÈLES DE DÉMARCHE ===\n${modelsTxt}\n\n=== B) SOURCES DE CONTENU ===\n${contentTxt}`;

    const fiche = await mistral([{ role: "system", content: system }, { role: "user", content: user }], 4000);

    const all = [...models.map((m) => ({ id: m.id, source: m.source })), ...chosen.map((c) => ({ id: c.id, source: c.source }))];
    const ids = new Set(all.map((x) => x.id));
    fiche.sources_utilisees = (fiche.sources_utilisees || []).filter((id) => ids.has(id));
    fiche.a_verifier = fiche.a_verifier || [];
    if (!found) fiche.a_verifier.unshift("Aucun texte de contenu trouvé pour cette leçon : seule la démarche est fiable. Colle un extrait du Guide CEB ou ajoute-le dans corpus.js.");

    // Contrôle des chiffres : seuls les chiffres des sources de CONTENU (pas des modèles) sont autorisés
    const allowed = (contentTxt + " " + (duree || "") + " " + titre + " " + classe).replace(/\s/g, "");
    const ficheText = JSON.stringify({ i: fiche.infos, e: fiche.etapes });
    const nums = [...new Set(ficheText.match(/\d[\d  .,]*\d|\d{2,}/g) || [])].map((n) => n.trim());
    nums.filter((n) => !allowed.includes(n.replace(/\s/g, "")) && !/^\d{1,2}$/.test(n))
      .forEach((n) => fiche.a_verifier.push("Chiffre « " + n + " » absent des sources de contenu : à vérifier."));

    fiche.sources_detail = all.filter((x) => fiche.sources_utilisees.includes(x.id)).map((x) => x.id + " — " + x.source);

    return { statusCode: 200, headers: H, body: JSON.stringify(fiche) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ erreur: String(e.message || e) }) };
  }
};
