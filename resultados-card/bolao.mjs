// Gera a peça padrão "Bolão pronto no balcão" (chamada + botão de ação) de cada loja. Só gera se a loja tem bolão à venda na vitrine (boloes.json).
// Sem nome de modalidade nem marca CAIXA na arte (Circular CAIXA 1.129).
// Saída: pecas/bolao_<loja>.jpg e pecas/bolao.json (lido pelo robô Postagem G3 no n8n).
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..");
const CARD = path.join(RAIZ, "pecas-card");
const SAIDA = path.join(RAIZ, "pecas");

const LOJAS = {
  tomazini: { nome: "Lotérica Tomazini", end: "Av. Boturussu, 2074 · Centro de Ermelino Matarazzo", wa: "5511978962327", mkt: "013979" },
  "praca-xi": { nome: "Lotérica Praça XI", end: "Praça Rev. Mattathias Gomes dos Santos, 8 · Praça Onze", wa: "5511960480263", mkt: "020665" },
  we: { nome: "Lotérica WE", end: "Estrada do Lageado Velho, 1013 · Guaianazes (dentro do Rossi)", wa: "5511976589981", mkt: "002484" },
};

const brl = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

function resumo(unit) {
  if (!unit || unit.stale) return null;
  const idade = Date.now() - Date.parse(unit.fetchedAt || 0);
  if (!(idade < 6 * 3600e3)) return null;
  const ofertas = (unit.offers || []).filter((o) => o.disponiveis > 0 && o.valor > 0);
  if (!ofertas.length) return null;
  return {
    preco: Math.min(...ofertas.map((o) => o.valor)),
    cotas: ofertas.reduce((s, o) => s + o.disponiveis, 0),
    qtd: ofertas.length,
  };
}

function legenda(d) {
  return [
    `Bolão pronto na ${d.nome}: mais números no jogo, e você paga só a sua cota.`,
    `As cotas são limitadas. Reserve a sua pelo WhatsApp 👇\nhttps://wa.me/${d.wa}\nou passe no balcão e peça a sua.`,
    `🛒 Comprando no Marketplace? Use o código da loja: ${d.mkt}`,
    `📍 ${d.end}`,
    "Lotérica credenciada CAIXA. Aposte com responsabilidade. Proibido para menores de 18 anos.",
  ].join("\n\n");
}

const feed = JSON.parse(await readFile(path.join(RAIZ, "boloes.json"), "utf8"));
const porSlug = Object.fromEntries(Object.values(feed.units || {}).map((u) => [u.slug, u]));
await mkdir(SAIDA, { recursive: true });
const out = { data: hojeSP(), gerado: new Date().toISOString(), lojas: {} };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
for (const [slug, d] of Object.entries(LOJAS)) {
  const r = resumo(porSlug[slug]);
  if (!r) { out.lojas[slug] = null; console.log(slug, "sem bolão à venda: não gera"); continue; }
  let html = await readFile(path.join(CARD, `bolao_${slug}.html`), "utf8");
  html = html.replaceAll("__A__", "file://" + path.join(CARD, "assets"))
;
  const tmp = path.join(CARD, `_tmp_${slug}.html`);
  await writeFile(tmp, html);
  await page.goto("file://" + tmp);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const arquivo = `bolao_${slug}.jpg`;
  await page.screenshot({ path: path.join(SAIDA, arquivo), type: "jpeg", quality: 90 });
  out.lojas[slug] = { arquivo, legenda: legenda(d), ...r };
  console.log(slug, JSON.stringify(r));
}
await browser.close();
await writeFile(path.join(SAIDA, "bolao.json"), JSON.stringify(out, null, 2));
