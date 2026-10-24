// Le site demande ici où en est la fiche (toutes les 3 secondes).
exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  try {
    const { connectLambda, getStore } = await import("@netlify/blobs");
    connectLambda(event);
    const id = String((event.queryStringParameters || {}).id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60);
    const store = getStore("fiches");
    const data = (await store.get(id + "-result", { type: "json" })) || (await store.get(id + "-step", { type: "json" }));
    return { statusCode: 200, headers: H, body: JSON.stringify(data || { status: "pending" }) };
  } catch (e) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ status: "error", erreur: "Stockage Netlify indisponible : " + String(e.message || e) }) };
  }
};
