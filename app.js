async function genererFiche() {
    const titre = document.getElementById('titre').value;
    const classe = document.getElementById('classe').value;

    if (!titre || !classe) {
        alert("Veuillez remplir le titre et la classe.");
        return;
    }

    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('ficheResultat').classList.add('hidden');

    try {
        const response = await fetch("/.netlify/functions/generer", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ titre, classe })
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || "Erreur lors de la communication avec le serveur.");
        }

        let content = data.choices[0].message.content;
        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const fiche = JSON.parse(content);

        // Remplissage de la fiche dans le DOM
        document.getElementById('resClasse').innerText = classe;
        document.getElementById('resSousDomaine').innerText = fiche.sousDomaine || '';
        document.getElementById('resDuree').innerText = fiche.duree || '';
        document.getElementById('resDiscipline').innerText = fiche.discipline || '';
        document.getElementById('resCB').innerText = fiche.cb || '';
        document.getElementById('resPalier').innerText = fiche.palier || '';
        document.getElementById('resOA').innerText = fiche.oa || '';
        document.getElementById('resOS').innerText = fiche.os || '';
        document.getElementById('resContenus').innerText = fiche.contenus || '';
        document.getElementById('resMateriels').innerText = fiche.moyensMateriels || '';
        document.getElementById('resDoc').innerText = fiche.documentation || '';

        const tbody = document.getElementById('etapesBody');
        tbody.innerHTML = '';
        fiche.etapes.forEach(etape => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="border border-black p-2 font-semibold align-top">${etape.nom}</td>
                <td class="border border-black p-2 align-top whitespace-pre-line">${etape.partMaitre}</td>
                <td class="border border-black p-2 align-top whitespace-pre-line">${etape.partEleves}</td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('loading').classList.add('hidden');
        document.getElementById('ficheResultat').classList.remove('hidden');

    } catch (error) {
        console.error(error);
        alert("Erreur : " + error.message);
        document.getElementById('loading').classList.add('hidden');
    }
}
