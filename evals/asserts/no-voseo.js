// no-voseo.js — assert determinista ($0, sin LLM).
// Falla si la respuesta del tutor usa voseo rioplatense. Se apoya en la TILDE
// final, que es lo que distingue el voseo del trato neutro de "tú":
//   voseo "explicá / tenés / vení"   vs   tú "explica / tienes / ven"
// Por eso formas correctas como "crea", "usa", "busca", "lista" NO disparan.

const VOSEO = /\b(ten[ée]s|quer[ée]s|pod[ée]s|sab[ée]s|deb[ée]s|hac[ée]s|hacé|us[áa]s|usá|necesit[áa]s|prefer[íi]s|mirá|tomá|poné|ponés|elegí|elegís|vení|venís|decí|decís|preguntá|preguntás|explicá|explicás|respondé|respondés|completá|ofrecé|evaluá|listá|cambiá|buscá|generá|creá|empezá|terminá|esperá|resolvé|metés|rompés|repetís|fijate|aflojá|mandá|sumá|agregá|revisá|probá|seguí)\b/i;

module.exports = (output) => {
  const m = String(output).match(VOSEO);
  if (m) {
    return { pass: false, score: 0, reason: `Voseo detectado: "${m[0]}"` };
  }
  return { pass: true, score: 1, reason: "Sin voseo" };
};
