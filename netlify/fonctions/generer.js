exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { titre, classe } = JSON.parse(event.body);
        const apiKey = process.env.MISTRAL_API_KEY;

        if (!apiKey) {
            return { 
                statusCode: 500, 
                body: JSON.stringify({ error: "La variable d'environnement MISTRAL_API_KEY n'est pas configurée sur Netlify." }) 
            };
        }

        const prompt = `Génère une fiche de leçon PÉDAGOGIQUE au format JSON strict pour l'enseignement primaire (système éducatif du Sénégal / CEB).
Titre de la leçon : "${titre}"
Classe : "${classe}"

Format JSON attendu (assure-toi de renvoyer uniquement du JSON valide sans texte additionnel autour) :
{
  "sousDomaine": "...",
  "duree": "45 minutes",
  "discipline": "...",
  "cb": "...",
  "palier": "...",
  "oa": "...",
  "os": "...",
  "contenus": "...",
  "moyensMateriels": "...",
  "documentation": "...",
  "etapes": [
    {
      "nom": "Révision / Rappel des acquis",
      "partMaitre": "...",
      "partEleves": "..."
    },
    {
      "nom": "Imprégnation / Observation libre",
      "partMaitre": "...",
      "partEleves": "..."
    },
    {
      "nom": "Analyse / Observation dirigée",
      "partMaitre": "...",
      "partEleves": "..."
    },
    {
      "nom": "Synthèse / Élaboration du résumé",
      "partMaitre": "...",
      "partEleves": "..."
    },
    {
      "nom": "Évaluation / Application",
      "partMaitre": "...",
      "partEleves": "..."
    }
  ]
}`;

        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "mistral-small-latest",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            throw new Error("Erreur de communication avec l'API Mistral.");
        }

        const data = await response.json();
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};