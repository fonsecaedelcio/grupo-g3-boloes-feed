// Gera os cards diários de resultados das 3 lotéricas G3.
// Fonte: API pública do site grupog3lotericas.com.br (espelho dos resultados oficiais da CAIXA).
// Saída: resultados/<loja>.jpg e resultados/hoje.json
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { chromium } from "playwright";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, "..");
const OUT = resolve(ROOT, "resultados");
const API = "https://grupog3lotericas.com.br/api/resultado/";
const FIXTURES = process.env.RESULT_FIXTURES || "";

const JOGOS = {
  maismilionaria: ["+Milionária", "#2E3078", "#fff"],
  megasena: ["Mega&#8209;Sena", "#209869", "#fff"],
  lotofacil: ["Lotofácil", "#930089", "#fff"],
  quina: ["Quina", "#260085", "#fff"],
  diadesorte: ["Dia de Sorte", "#CB852B", "#fff"],
  timemania: ["Timemania", "#FFF600", "#049645"],
  lotomania: ["Lotomania", "#F78100", "#fff"],
  duplasena: ["Dupla Sena", "#A61324", "#fff"],
  supersete: ["Super Sete", "#A8CF45", "#fff"],
};
const NOME_TXT = { maismilionaria: "+Milionária", megasena: "Mega-Sena", lotofacil: "Lotofácil", quina: "Quina", diadesorte: "Dia de Sorte", timemania: "Timemania", lotomania: "Lotomania", duplasena: "Dupla Sena", supersete: "Super Sete" };

const LOJAS = {
  tomazini: { nome: "Lotérica Tomazini", end: "Av. Boturussu, 2074 · Centro de Ermelino Matarazzo", wa: "5511978962327", waTxt: "(11) 97896-2327", mkt: "013979" },
  "praca-xi": { nome: "Lotérica Praça XI", end: "Praça Rev. Mattathias Gomes dos Santos, 8 · Praça 11", wa: "5511960480263", waTxt: "(11) 96048-0263", mkt: "20665" },
  we: { nome: "Lotérica WE", end: "Estrada do Lageado Velho, 1013 · Guaianazes", wa: "5511976589981", waTxt: "(11) 97658-9981", mkt: "2484" },
};

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function hojeSP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
}
function alvo() {
  if (process.env.DATA_ALVO) { const [d, m, y] = process.env.DATA_ALVO.split("/"); return new Date(Date.UTC(+y, +m - 1, +d)); }
  const h = hojeSP();
  if (h.getUTCDay() === 0) return h; // domingo: sorteios das 11h do próprio dia
  return new Date(h.getTime() - 86400000); // demais dias: sorteios da noite anterior
}
const fmt = (d) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const cheio = (v) => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function buscar(jogo) {
  if (FIXTURES) return JSON.parse(await readFile(resolve(FIXTURES, `${jogo}.json`), "utf8").catch(() => "null"));
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(API + jogo, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch (e) { /* tenta de novo */ }
    await new Promise((s) => setTimeout(s, 3000 * t));
  }
  return null;
}

function normaliza(jogo, j) {
  const f1 = (j.premiacoes || []).find((p) => p.faixa === 1) || {};
  let extra = "";
  if (jogo === "timemania" && j.timeCoracao) extra = "Time: " + j.timeCoracao.replace(/\s+\//, "/").replace(/\s+/g, " ").trim();
  if (jogo === "diadesorte" && j.mesSorte) extra = "Mês: " + j.mesSorte;
  if (jogo === "maismilionaria" && j.trevos?.length) extra = "Trevos: " + j.trevos.join(" e ");
  if (jogo === "duplasena") extra = "1º e 2º sorteio";
  return {
    jogo, concurso: j.concurso, dezenas: j.dezenas || [], extra,
    acumulou: !!j.acumulou,
    proximo: j.valorEstimadoProximoConcurso || 0,
    ganhadores: f1.ganhadores || 0, premio: f1.valorPremio || 0,
  };
}

const IC_PIN = '<svg viewBox="0 0 56 56" width="26" height="26"><path d="M28 50s16-15 16-28a16 16 0 10-32 0c0 13 16 28 16 28z" fill="#F28C28"/><circle cx="28" cy="22" r="6" fill="#fff"/></svg>';
const IC_WA = '<svg viewBox="0 0 32 32" width="40" height="40"><circle cx="16" cy="16" r="16" fill="#25D366"/><path d="M16 6.5a9.5 9.5 0 00-8.2 14.3L6.5 25.5l4.8-1.3A9.5 9.5 0 1016 6.5z" fill="none" stroke="#fff" stroke-width="1.9"/><path d="M12.6 11.2c.3-.7.7-.7 1-.7h.6c.2 0 .5.1.6.5l.8 2c.1.2 0 .5-.1.7l-.5.7c-.1.2-.1.4 0 .6.4.7 1 1.4 1.8 1.9.6.4 1.1.7 1.5.8.2.1.4 0 .6-.1l.7-.8c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.3.4.5 0 .7-.4 1.5-1.2 1.9-.8.4-1.9.4-3.8-.4-2.2-1-3.8-3.2-4.3-4.1-.5-.9-.9-2.2-.4-3.4z" fill="#fff"/></svg>';

function linha(g, nj) {
  const [nome, bg, fg] = JOGOS[g.jogo];
  const n = g.dezenas.length;
  const base = nj <= 5 ? 58 : 44;
  const sz = Math.round(base * (n > 7 ? 0.72 : 1));
  const balls = g.dezenas.map((d) => d.length > 2
    ? `<i style="height:${sz}px;padding:0 ${Math.round(sz / 3)}px;border-radius:${sz}px;font-size:${Math.round(sz * 0.5)}px;background:${bg};color:${fg}">${d}</i>`
    : `<i style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz * 0.46)}px;background:${bg};color:${fg}">${d}</i>`).join("");
  const extra = g.extra ? `<em>${g.extra}</em>` : "";
  let lab, val, sub;
  if (g.acumulou) { lab = '<span class="ac">ACUMULOU!</span>'; val = cheio(g.proximo); sub = "estimativa do próximo concurso"; }
  else { const k = g.ganhadores; lab = '<span class="ok">SAIU!</span>'; val = cheio(g.premio); sub = `${k} aposta${k > 1 ? "s" : ""} ganhadora${k > 1 ? "s" : ""}`; }
  return `<div class="g"><div class="nm" style="background:${bg};color:${fg}">${nome}<small>concurso ${g.concurso}</small></div><div class="bl">${balls}${extra}</div><div class="pz${g.acumulou ? " acz" : ""}">${lab}<b>${val}</b><small>${sub}</small></div></div>`;
}

function html(slug, titulo, jogos, qr) {
  const d = LOJAS[slug], nj = jogos.length, big = nj <= 5;
  const ac = jogos.filter((g) => g.acumulou);
  const top = ac.length ? ac.reduce((a, b) => (b.proximo > a.proximo ? b : a)) : null;
  const hero = top ? `<div class="hero"><span>MAIOR ACUMULADO</span><b>${cheio(top.proximo)}</b><em>${JOGOS[top.jogo][0]} · estimativa do próximo concurso</em></div>` : "";
  const A = (f) => pathToFileURL(resolve(DIR, "assets", f)).href;
  const P = (a, b) => (big ? a : b);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:L;src:url(${A("lilita.woff2")})}
@font-face{font-family:B;font-weight:400;src:url(${A("baloo-400.woff2")})}
@font-face{font-family:B;font-weight:700;src:url(${A("baloo-700.woff2")})}
@font-face{font-family:B;font-weight:800;src:url(${A("baloo-800.woff2")})}
*{margin:0;box-sizing:border-box}
body{font-family:B;color:#fff;overflow:hidden;display:flex;flex-direction:column;width:1080px;height:1350px;background:linear-gradient(180deg,#0A3F99,#072C6E)}
.top{height:130px;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 40px;flex:none}
.top img{height:98px}.top .t{text-align:right;font-family:L;color:#0A3F99;font-size:44px;line-height:1}.top .t small{display:block;font-family:B;font-weight:800;color:#F28C28;font-size:25px;margin-top:4px}
.hero{flex:none;margin:18px 28px 0;background:linear-gradient(90deg,#F28C28,#FFB23E);border-radius:24px;padding:12px 26px;display:flex;flex-direction:column;align-items:center;color:#0A2A66;box-shadow:0 10px 26px rgba(0,0,0,.3)}
.hero span{font-weight:800;letter-spacing:3px;font-size:24px}
.hero b{font-family:L;font-weight:400;font-size:${P(84, 70)}px;line-height:1;color:#fff;text-shadow:0 5px 0 rgba(10,42,102,.35)}
.hero em{font-style:normal;font-weight:800;font-size:24px;margin-top:2px}
.list{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:${P(12, 8)}px;padding:14px 28px}
.g{display:flex;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 22px rgba(0,0,0,.25);min-height:${P(120, 78)}px}
.nm{width:${P(200, 180)}px;flex:none;display:flex;flex-direction:column;justify-content:center;padding:0 16px;font-family:L;font-size:${P(34, 28)}px;line-height:1}
.nm small{font-family:B;font-weight:700;font-size:17px;opacity:.85;margin-top:5px}
.bl{flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;align-content:center;padding:8px 12px}
.bl i{font-style:normal;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:800}
.bl em{font-style:normal;font-weight:800;font-size:18px;color:#0A2A66;background:#FFE7C2;border-radius:10px;padding:2px 8px}
.pz{width:${P(310, 290)}px;flex:none;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:#EEF3FC;color:#0A2A66;padding:6px 8px}
.pz.acz{background:#FFF1DE}
.pz span{font-weight:800;font-size:${P(22, 18)}px;line-height:1}.pz .ac{color:#E0700E}.pz .ok{color:#0A3F99}
.pz b{white-space:nowrap;font-family:L;font-weight:400;font-size:${P(32, 27)}px;line-height:1.05;margin-top:4px}
.pz small{font-weight:700;font-size:${P(17, 15)}px;opacity:.7}
.bot{flex:none;background:#062459;padding:12px 30px 10px 36px;display:flex;align-items:center;gap:20px}
.bl2{flex:1;display:flex;flex-direction:column;gap:4px}
.cta{font-family:L;color:#FFB23E;font-size:32px}
.l{display:flex;align-items:center;gap:10px;font-weight:700;font-size:21px}
.wa{display:flex;align-items:center;gap:10px;margin-top:2px}.wa span{font-weight:700;font-size:20px;line-height:1.05;display:flex;flex-direction:column}.wa b{font-family:L;font-weight:400;font-size:34px;color:#fff}
.f{font-size:15px;opacity:.75;display:flex;gap:10px;align-items:center}
.b18{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:3px solid #FFB23E;color:#FFB23E;font-weight:800;font-size:14px;flex:none}
.qr{flex:none;background:#fff;border-radius:16px;padding:8px 8px 4px;display:flex;flex-direction:column;align-items:center}.qr img{width:132px;height:132px}.qr small{color:#0A2A66;font-weight:800;font-size:14px}
</style></head><body>
<div class="top"><img src="${A(`logoloja_${slug}.png`)}"><div class="t">Resultados<small>${titulo}</small></div></div>
${hero}
<div class="list">${jogos.map((g) => linha(g, nj)).join("")}</div>
<div class="bot"><div class="bl2"><div class="cta">Confira seu bilhete e faça seu jogo aqui na loja!</div><div class="l">${IC_PIN}${d.end}</div>
<div class="wa">${IC_WA}<span>Bolões no WhatsApp<b>${d.waTxt}</b></span></div>
<div class="f"><span class="b18">18+</span>Resultados oficiais; prêmios estimados. Apostar é para maiores de 18 anos.</div></div>
<div class="qr"><img src="${qr}"><small>aponte a câmera</small></div></div></body></html>`;
}

function legenda(slug, titulo, jogos) {
  const d = LOJAS[slug];
  const ac = jogos.filter((g) => g.acumulou);
  const top = ac.length ? ac.reduce((a, b) => (b.proximo > a.proximo ? b : a)) : null;
  const linhas = jogos.map((g) => g.acumulou
    ? `• ${NOME_TXT[g.jogo]} (concurso ${g.concurso}): acumulou! Estimativa do próximo concurso: ${cheio(g.proximo)}`
    : `• ${NOME_TXT[g.jogo]} (concurso ${g.concurso}): saiu! ${g.ganhadores} aposta${g.ganhadores > 1 ? "s" : ""} ganhadora${g.ganhadores > 1 ? "s" : ""}, ${cheio(g.premio)}`);
  return [
    `🎯 Resultados de ${titulo}`,
    top ? `${NOME_TXT[top.jogo]} acumulou: ${cheio(top.proximo)} estimados para o próximo concurso!` : "",
    "",
    ...linhas,
    "",
    "Faça seu jogo ou garanta sua cota de bolão:",
    `👉 WhatsApp: https://wa.me/${d.wa}`,
    "👉 Bolões online: grupog3lotericas.com.br",
    `🛒 Comprando no Marketplace? Use o código da loja: ${d.mkt}`,
    "",
    `📍 ${d.end}`,
    "Resultados oficiais; prêmios estimados. Apostar é para maiores de 18 anos.",
  ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}

async function main() {
  const dt = alvo(), data = fmt(dt);
  const titulo = `${DIAS[dt.getUTCDay()]}, ${data.slice(0, 5)}`;
  const jogos = [];
  for (const jogo of Object.keys(JOGOS)) {
    const j = await buscar(jogo);
    if (j && j.data === data && (j.dezenas || []).length) jogos.push(normaliza(jogo, j));
  }
  await mkdir(OUT, { recursive: true });
  const meta = { data, titulo, gerado: new Date().toISOString(), jogos, lojas: {} };
  if (jogos.length) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    for (const slug of Object.keys(LOJAS)) {
      const qr = await QRCode.toDataURL(`https://wa.me/${LOJAS[slug].wa}?text=${encodeURIComponent("Olá! Vi o resultado e quero fazer meu jogo.")}`, { margin: 1, width: 400, color: { dark: "#0A2A66", light: "#ffffff" } });
      const tmp = resolve(OUT, `_${slug}.html`);
      await writeFile(tmp, html(slug, titulo, jogos, qr));
      await page.goto(pathToFileURL(tmp).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const arq = `${slug}.jpg`;
      await page.screenshot({ path: resolve(OUT, arq), type: "jpeg", quality: 90 });
      meta.lojas[slug] = { arquivo: `resultados/${arq}`, legenda: legenda(slug, titulo, jogos) };
    }
    await browser.close();
    const { rm } = await import("node:fs/promises");
    for (const slug of Object.keys(LOJAS)) await rm(resolve(OUT, `_${slug}.html`), { force: true });
  }
  await writeFile(resolve(OUT, "hoje.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`Data alvo ${data}: ${jogos.length} jogo(s) — ${jogos.map((g) => g.jogo).join(", ") || "nenhum sorteio"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
