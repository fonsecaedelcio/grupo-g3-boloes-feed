import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "boloes.json");
const API_PATH = "boloes/recuperar-boloes-disponiveis-link";
const SALT = "forge.random.get";
const WEB_ORIGIN = "https://www.loteriasonline.caixa.gov.br";
const PAGE_SIZE = 30;
const MAX_PAGES = 10;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const units = [
  { id: "2484", slug: "we", name: "Casa Lotérica WE" },
  { id: "20665", slug: "praca-xi", name: "Praça XI · Shiaku" },
  { id: "13979", slug: "tomazini", name: "Lotérica Tomazini" },
];

function encryptedQuery(caixaId, page) {
  const params = {
    tipoConsulta: 3,
    numeroLoterico: caixaId,
    idMunicipio: 0,
    idUf: 0,
    pagina: page,
    qtdPorPagina: PAGE_SIZE,
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

function officialUrl(caixaId, page) {
  const path = Buffer.from(API_PATH).toString("base64");
  const url = new URL(`/silce-servico-rest/rest/v1/${path}/`, WEB_ORIGIN);
  url.searchParams.set("q", encryptedQuery(caixaId, page));
  return url;
}

function headers() {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/silce-web/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Subcanal: "1",
    "User-Agent": USER_AGENT,
  };
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

function identifier(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("identificador numérico inválido");
    return String(value);
  }
  return text(value);
}

function normalize(raw, index) {
  const modalidade = text(raw?.modalidade);
  if (!modalidade) throw new Error(`oferta ${index + 1} sem modalidade`);
  const base = number(raw?.vrUltimaCotaSemTarifa);
  const fee = number(raw?.vrTarifaServicoUltimaCota);
  const valor =
    number(raw?.vrUltimaCotaComTarifa) ??
    number(raw?.vrCotaComTarifa) ??
    (base !== null && fee !== null ? base + fee : base);
  return {
    id:
      identifier(raw?.codigoBolao) ??
      identifier(raw?.idBolao) ??
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

function readCotas(root) {
  const raw = Object.hasOwn(root?.payload ?? {}, "cotas")
    ? root.payload.cotas
    : root?.cotas;
  if (!Array.isArray(raw)) throw new Error("resposta sem array cotas válido");
  if (raw.length > PAGE_SIZE) throw new Error("página excede o tamanho solicitado");
  return raw;
}

async function requestJson(caixaId, page, fetchImpl) {
  const response = await fetchImpl(officialUrl(caixaId, page), {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error(`fonte oficial respondeu HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("fonte oficial respondeu conteúdo não JSON");
  }
  return response.json();
}

export async function fetchUnit(unit, { fetchImpl = globalThis.fetch, maxPages = MAX_PAGES } = {}) {
  const offers = [];
  const ids = new Set();
  const pages = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = readCotas(await requestJson(unit.id, page, fetchImpl));
    const signature = JSON.stringify(raw);
    if (pages.has(signature)) throw new Error("fonte repetiu uma página; coleta incompleta");
    pages.add(signature);
    for (const item of raw) {
      const offer = normalize(item, offers.length);
      if (ids.has(offer.id)) throw new Error("identificador repetido; coleta incompleta");
      ids.add(offer.id);
      offers.push(offer);
    }
    // A página curta, inclusive vazia, confirma o fim da coleção.
    if (raw.length < PAGE_SIZE) return offers;
  }
  throw new Error(`limite de ${maxPages} páginas atingido; coleta incompleta`);
}

async function readPrevious(output) {
  try {
    return JSON.parse(await readFile(output, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, units: {} };
  }
}

export async function collect(previous, {
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  logger = console,
  maxPages = MAX_PAGES,
} = {}) {
  const result = {
    version: 1,
    source: "CAIXA Loterias",
    attemptedAt: now(),
    freshUnits: 0,
    failedUnits: [],
    units: { ...(previous.units ?? {}) },
  };
  let blockedStatus;
  for (const unit of units) {
    const cached = previous.units?.[unit.id];
    const attemptedAt = blockedStatus ? null : now();
    try {
      if (blockedStatus) {
        throw new Error(`consulta não executada após HTTP ${blockedStatus} na mesma origem`);
      }
      const offers = await fetchUnit(unit, { fetchImpl, maxPages });
      result.units[unit.id] = {
        ...unit,
        attemptedAt,
        fetchedAt: now(),
        stale: false,
        offers,
      };
      result.freshUnits += 1;
      logger.log(`${unit.name}: ${offers.length} ofertas atualizadas`);
    } catch (error) {
      const skipped = attemptedAt === null;
      if (error.status === 403 || error.status === 429) blockedStatus = error.status;
      result.failedUnits.push(unit.id);
      result.units[unit.id] = {
        ...cached,
        ...unit,
        attemptedAt: attemptedAt ?? cached?.attemptedAt ?? null,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: true,
        skipped,
        error: error.message,
        offers: Array.isArray(cached?.offers) ? cached.offers : [],
      };
      logger.warn(`${unit.name}: atualização falhou; vitrine anterior preservada (${error.message})`);
    }
  }
  result.complete = result.failedUnits.length === 0;
  result.generatedAt = now();
  return result;
}

export async function run({ output = OUTPUT, ...options } = {}) {
  const result = await collect(await readPrevious(output), options);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, output);
  const logger = options.logger ?? console;
  logger.log(`Arquivo atualizado: ${output}; ${result.freshUnits}/${units.length} unidades atualizadas`);
  return result.complete ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`Falha na coleta: ${error.message}`);
    process.exitCode = 1;
  }
}
