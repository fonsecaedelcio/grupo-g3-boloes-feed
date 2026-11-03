import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collect, fetchUnit, run } from "../scripts/collect-boloes.mjs";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Rede proibida nos testes"); };
after(() => { globalThis.fetch = originalFetch; });

const OLD = "2026-11-03T08:00:00.000Z";
const NOW = "2026-11-03T16:00:00.000Z";
const UNIT_IDS = ["2484", "20665", "13979"];
const UNIT = { id: "2484" };
const quiet = { log() {}, warn() {} };

function previous() {
  return {
    version: 1,
    generatedAt: OLD,
    units: Object.fromEntries(UNIT_IDS.map((id) => [id, {
      id,
      fetchedAt: OLD,
      attemptedAt: OLD,
      stale: false,
      offers: [{ id: `anterior-${id}`, modalidade: "MEGA-SENA", valor: 12 }],
    }])),
  };
}

function offer(id) {
  return {
    idBolao: id,
    modalidade: "MEGA-SENA",
    concurso: 2999,
    vrUltimaCotaComTarifa: 30,
    qtdApostas: 10,
    qtdNumeros: 6,
    qtdCotaDisponivel: 2,
    qtdCotaTotal: 10,
  };
}

function params(url) {
  const salt = "forge.random.get";
  const key = pbkdf2Sync("password", salt, 1, 16, "sha1");
  const bytes = Buffer.from(url.searchParams.get("q"), "binary");
  const trailer = 5 + key.length + 5 + Buffer.byteLength(salt);
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(salt));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(0, -trailer)),
    decipher.final(),
  ]).toString("utf8");
  return Object.fromEntries(plain.split("&&").filter(Boolean).map((pair) => pair.split("==")));
}

function mockSource(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, "https://www.loteriasonline.caixa.gov.br");
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, "error");
    const query = params(url);
    assert.equal(query.qtdPorPagina, "30");
    calls.push(query);
    const body = await reply(query, calls.length);
    return body instanceof Response ? body : Response.json(body);
  };
  return { calls, fetchImpl };
}

function collectWith(source, old = previous(), extra = {}) {
  return collect(old, { fetchImpl: source.fetchImpl, logger: quiet, now: () => NOW, ...extra });
}

test("um array cotas vazio explícito é uma vitrine válida nas duas estruturas", async () => {
  for (const body of [{ payload: { cotas: [] } }, { cotas: [] }]) {
    const source = mockSource(() => body);
    assert.deepEqual(await fetchUnit(UNIT, source), []);
    assert.equal(source.calls.length, 1);
  }
});

test("cotas ausente, nulo ou de tipo inválido não vira vitrine vazia", async () => {
  for (const body of [null, {}, { payload: {} }, { cotas: null }, { cotas: {} }, { payload: { cotas: null }, cotas: [] }]) {
    const source = mockSource(() => body);
    await assert.rejects(fetchUnit(UNIT, source), /array cotas válido/);
    assert.equal(source.calls.length, 1);
  }
});

test("IDs numéricos, string e zeros iniciais são preservados sem juntar formatos iguais", async () => {
  const source = mockSource(() => ({ cotas: [offer(123), offer("00123"), offer(0), { ...offer(undefined), codigoBolao: "COD-1" }] }));
  const offers = await fetchUnit(UNIT, source);
  assert.deepEqual(offers.map((item) => item.id), ["123", "00123", "0", "COD-1"]);
  assert.equal(offers[0].disponiveis, 2);
  assert.equal(offers[0].total, 10);
  assert.equal(offers[0].valor, 30);
});

test("pagina com 30 itens exige a próxima página antes de devolver a coleção", async () => {
  const source = mockSource(({ pagina }) => ({
    payload: { cotas: pagina === "1" ? Array.from({ length: 30 }, (_, i) => offer(i + 1)) : [offer(31)] },
  }));
  const offers = await fetchUnit(UNIT, source);
  assert.equal(offers.length, 31);
  assert.deepEqual(source.calls.map((q) => q.pagina), ["1", "2"]);
  assert.equal(offers.at(-1).id, "31");
});

test("uma página final vazia confirma coleção com exatamente 30 ofertas", async () => {
  const source = mockSource(({ pagina }) => ({ cotas: pagina === "1" ? Array.from({ length: 30 }, (_, i) => offer(i + 1)) : [] }));
  assert.equal((await fetchUnit(UNIT, source)).length, 30);
  assert.equal(source.calls.length, 2);
});

test("IDs de fallback usam a posição global ao longo das páginas", async () => {
  const source = mockSource(({ pagina }) => ({ cotas: Array.from({ length: pagina === "1" ? 30 : 1 }, () => offer(undefined)) }));
  const offers = await fetchUnit(UNIT, source);
  assert.equal(new Set(offers.map((item) => item.id)).size, 31);
  assert.equal(offers.at(-1).id, "MEGA-SENA-2999-30");
});

test("limite seguro interrompe a coleta sem devolver uma lista truncada", async () => {
  const source = mockSource(({ pagina }) => ({ cotas: Array.from({ length: 30 }, (_, i) => offer(`${pagina}-${i}`)) }));
  await assert.rejects(fetchUnit(UNIT, { ...source, maxPages: 2 }), /limite de 2 páginas.*incompleta/);
  assert.equal(source.calls.length, 2);
});

test("página repetida ou identificador repetido não permite uma coleção incompleta", async () => {
  const page = Array.from({ length: 30 }, (_, i) => offer(i + 1));
  const repeated = mockSource(() => ({ cotas: page }));
  await assert.rejects(fetchUnit(UNIT, repeated), /repetiu uma página/);
  assert.equal(repeated.calls.length, 2);
  const duplicate = mockSource(({ pagina }) => ({ cotas: pagina === "1" ? page : [offer(1)] }));
  await assert.rejects(fetchUnit(UNIT, duplicate), /identificador repetido/);
});

test("linhas inválidas, IDs numéricos imprecisos e páginas maiores que 30 não são descartados silenciosamente", async () => {
  const cases = [
    { cotas: [offer(1), {}] },
    { cotas: [offer(Number.MAX_SAFE_INTEGER + 1)] },
    { cotas: Array.from({ length: 31 }, (_, i) => offer(i + 1)) },
  ];
  for (const body of cases) await assert.rejects(fetchUnit(UNIT, mockSource(() => body)));
});

test("vitrine explicitamente vazia substitui ofertas antigas e conta como atualização", async () => {
  const old = previous();
  const before = structuredClone(old);
  const result = await collectWith(mockSource(() => ({ payload: { cotas: [] } })), old);
  assert.equal(result.complete, true);
  assert.equal(result.freshUnits, 3);
  assert.deepEqual(result.failedUnits, []);
  for (const unit of Object.values(result.units)) {
    assert.deepEqual(unit.offers, []);
    assert.equal(unit.fetchedAt, NOW);
    assert.equal(unit.attemptedAt, NOW);
    assert.equal(unit.stale, false);
  }
  assert.deepEqual(old, before);
});

test("falha na segunda página preserva toda a vitrine anterior e permite as outras unidades", async () => {
  const old = previous();
  const source = mockSource(({ numeroLoterico, pagina }) => {
    if (numeroLoterico !== "2484") return { cotas: [offer(`novo-${numeroLoterico}`)] };
    if (pagina === "1") return { cotas: Array.from({ length: 30 }, (_, i) => offer(i + 1)) };
    return new Response("indisponível", { status: 500 });
  });
  const result = await collectWith(source, old);
  assert.equal(result.complete, false);
  assert.equal(result.freshUnits, 2);
  assert.deepEqual(result.failedUnits, ["2484"]);
  assert.deepEqual(result.units["2484"].offers, old.units["2484"].offers);
  assert.equal(result.units["2484"].fetchedAt, OLD);
  assert.equal(result.units["2484"].attemptedAt, NOW);
  assert.equal(result.units["2484"].stale, true);
  assert.equal(result.units["20665"].fetchedAt, NOW);
  assert.equal(source.calls.length, 4);
});

for (const status of [403, 429]) {
  test(`HTTP ${status} encerra novas consultas à origem sem cookies ou alternativa`, async () => {
    const source = mockSource(() => new Response("bloqueado", { status }));
    const result = await collectWith(source);
    assert.equal(source.calls.length, 1);
    assert.equal(result.complete, false);
    assert.equal(result.freshUnits, 0);
    assert.deepEqual(result.failedUnits, UNIT_IDS);
    assert.equal(result.units["2484"].attemptedAt, NOW);
    assert.equal(result.units["2484"].skipped, false);
    assert.equal(result.units["20665"].attemptedAt, OLD);
    assert.equal(result.units["20665"].skipped, true);
    for (const unit of Object.values(result.units)) {
      assert.equal(unit.fetchedAt, OLD);
      assert.equal(unit.stale, true);
      assert.match(unit.error, new RegExp(String(status)));
    }
  });
}

test("falha preserva inclusive uma vitrine anterior vazia válida", async () => {
  const old = previous();
  old.units["2484"].offers = [];
  const result = await collectWith(mockSource(() => ({})), old);
  assert.equal(result.complete, false);
  assert.equal(result.freshUnits, 0);
  assert.equal(result.units["2484"].fetchedAt, OLD);
  assert.deepEqual(result.units["2484"].offers, []);
  assert.equal(result.units["2484"].stale, true);
});

test("sem snapshot anterior a falha fica explícita, sem fabricar data de coleta", async () => {
  const result = await collectWith(mockSource(() => ({})), { version: 1, units: {} });
  assert.equal(result.complete, false);
  for (const unit of Object.values(result.units)) {
    assert.equal(unit.fetchedAt, null);
    assert.equal(unit.attemptedAt, NOW);
    assert.equal(unit.stale, true);
  }
});

test("conteúdo HTML e JSON inválido não substituem o snapshot", async () => {
  for (const reply of [
    () => new Response("<html>indisponível</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
  ]) {
    const result = await collectWith(mockSource(reply));
    assert.equal(result.complete, false);
    assert.equal(result.freshUnits, 0);
    assert.equal(result.units["2484"].fetchedAt, OLD);
  }
});

test("run publica updates parciais e retorna código de falha", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "g3-feed-partial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "boloes.json");
  await writeFile(output, JSON.stringify(previous()));
  const source = mockSource(({ numeroLoterico }) => numeroLoterico === "2484" ? {} : { cotas: [] });
  const code = await run({ output, fetchImpl: source.fetchImpl, now: () => NOW, logger: quiet });
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(code, 1);
  assert.equal(result.freshUnits, 2);
  assert.equal(result.complete, false);
  assert.equal(result.units["2484"].fetchedAt, OLD);
  assert.deepEqual(result.units["20665"].offers, []);
});

test("snapshot anterior corrompido não é sobrescrito", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "g3-feed-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "boloes.json");
  await writeFile(output, "{corrompido");
  const source = mockSource(() => ({ cotas: [] }));
  await assert.rejects(run({ output, fetchImpl: source.fetchImpl, logger: quiet }));
  assert.equal(await readFile(output, "utf8"), "{corrompido");
  assert.equal(source.calls.length, 0);
});

test("CLI sai com 1 na falha e 0 na coleta completa, sem rede", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "g3-feed-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts"));
  await copyFile(new URL("../scripts/collect-boloes.mjs", import.meta.url), join(dir, "scripts/collect-boloes.mjs"));
  const output = join(dir, "boloes.json");
  const preload = join(dir, "mock-fetch.mjs");
  await writeFile(output, JSON.stringify(previous()));
  for (const [response, expected] of [
    ["new Response('bloqueado', { status: 403 })", 1],
    ["Response.json({ payload: { cotas: [] } })", 0],
  ]) {
    await writeFile(preload, `globalThis.fetch = async () => ${response};\n`);
    const child = spawnSync(process.execPath, ["--import", preload, join(dir, "scripts/collect-boloes.mjs")], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, expected, child.stderr);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.complete, expected === 0);
    assert.equal(result.freshUnits, expected === 0 ? 3 : 0);
  }
});
