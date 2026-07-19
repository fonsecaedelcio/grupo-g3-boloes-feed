import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "boloes.json");
const API_PATH = "boloes/recuperar-boloes-disponiveis-link";
const SALT = "forge.random.get";
const WEB_ORIGIN = "https://www.loteriasonline.caixa.gov.br";
const MOBILE_ORIGIN = "https://mobileloterias.caixa.gov.br";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const units = [
  { id: "2484", slug: "we", name: "Casa Lotérica WE" },
  { id: "20665", slug: "praca-xi", name: "Praça XI · Shiaku" },
  { id: "13979", slug: "tomazini", name: "Lotérica Tomazini" },
];

function encryptedQuery(caixaId) {
  const params = {
    tipoConsulta: 3,
    numeroLoterico: caixaId,
    idMunicipio: 0,
    idUf: 0,
    pagina: 1,
    qtdPorPagina: 30,
  };
  const plain = Object.entries(params)
    .map(([key, value]) => `${key}==${value}&&`)
    .join("");
  const key = pbkdf2Sync("password", SALT, 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.from(SALT));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([
    encrypted,
    Buffer.from("!#!#!", "binary"),
    key,
    Buffer.from("!#!#!" + SALT, "binary"),
  ]).toString("binary");
}

function officialUrl(caixaId, origin) {
  const path = Buffer.from(API_PATH).toString("base64");
  const url = new URL(`/silce-servico-rest/rest/v1/${path}/`, origin);
  url.searchParams.set("q", encryptedQuery(caixaId));
  return url;
}

function headers(origin, cookie) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(cookie ? { Cookie: cookie } : {}),
    Origin: origin,
    Referer: `${origin}/silce-web/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Subcanal: "1",
    "User-Agent": USER_AGENT,
  };
}

function challengeCookies(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  return Array.from(raw.matchAll(/(__uzm[a-e])=([^;,\s]+)/g))
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalize(raw, index) {
  const modalidade = text(raw?.modalidade);
  if (!modalidade) return null;
  const base = number(raw?.vrUltimaCotaSemTarifa);
  const fee = number(raw?.vrTarifaServicoUltimaCota);
  const valor =
    number(raw?.vrUltimaCotaComTarifa) ??
    number(raw?.vrCotaComTarifa) ??
    (base !== null && fee !== null ? base + fee : base);
  return {
    id:
      text(raw?.codigoBolao) ??
      text(raw?.idBolao) ??
      `${modalidade}-${number(raw?.concurso) ?? "sem-concurso"}-${index}`,
    concurso: number(raw?.concurso),
    modalidade,
    premio: number(raw?.vrPremioEstimado),
    valor,
    apostas: number(raw?.qtdApostas),
    numeros: number(raw?.qtdNumeros),
    disponiveis: number(raw?.qtdCotaDisponivel),
    total: number(raw?.qtdCotaTotal),
    cidade: text(raw?.municipio?.nome),
    uf: text(raw?.uf?.sigla),
  };
}

async function requestJson(caixaId, origin, cookie) {
  const response = await fetch(officialUrl(caixaId, origin), {
    headers: headers(origin, cookie),
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) {
    throw new Error(`${origin} respondeu ${response.status}`);
  }
  return response.json();
}

async function fetchUnit(unit) {
  const attempts = [
    () => requestJson(unit.id, WEB_ORIGIN),
    () => requestJson(unit.id, MOBILE_ORIGIN),
    async () => {
      const bootstrap = await fetch(`${WEB_ORIGIN}/silce-web/`, {
        headers: { Accept: "text/html", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      return requestJson(unit.id, WEB_ORIGIN, challengeCookies(bootstrap));
    },
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const root = await attempt();
      const raw = root?.payload?.cotas ?? root?.cotas ?? [];
      const offers = Array.isArray(raw)
        ? raw.map(normalize).filter(Boolean)
        : [];
      if (!offers.length) throw new Error("resposta sem ofertas");
      return offers;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("fonte oficial indisponível");
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUTPUT, "utf8"));
  } catch {
    return { version: 1, units: {} };
  }
}

const previous = await readPrevious();
const result = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: "CAIXA Loterias",
  units: { ...(previous.units ?? {}) },
};

let freshUnits = 0;
for (const unit of units) {
  try {
    const offers = await fetchUnit(unit);
    result.units[unit.id] = {
      id: unit.id,
      slug: unit.slug,
      name: unit.name,
      fetchedAt: new Date().toISOString(),
      stale: false,
      offers,
    };
    freshUnits += 1;
    console.log(`${unit.name}: ${offers.length} ofertas atualizadas`);
  } catch (error) {
    const cached = result.units[unit.id];
    if (!cached?.offers?.length) {
      throw new Error(`${unit.name}: sem vitrine válida (${error.message})`);
    }
    result.units[unit.id] = { ...cached, stale: true };
    console.warn(`${unit.name}: mantida a última vitrine válida (${error.message})`);
  }
}

if (!freshUnits && !Object.values(result.units).some((unit) => unit?.offers?.length)) {
  throw new Error("Nenhuma vitrine válida disponível");
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`Arquivo atualizado: ${OUTPUT}`);

