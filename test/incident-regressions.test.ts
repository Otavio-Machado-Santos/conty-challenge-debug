import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;
type Result = {
  mission: { status: string };
  ledger: Array<{ id: string; amount_brl: number; idempotency_key: string }>;
  payout: { id: string; status: string; provider_status: string | null } | null;
};

async function post(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("regressões do incidente e invariantes do repasse", () => {
  let db: DatabaseSync;
  let app: App;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedIncident(db);
    app = createApp(db);
  });
  afterEach(() => db.close());

  async function approve(key: string, missionId = "msn_2044", approvedAt = "2026-03-12T21:05:00.000Z") {
    return post(app, "/approvals", {
      mission_id: missionId,
      approved_at: approvedAt,
      idempotency_key: key,
    });
  }

  async function mission(id = "msn_2044"): Promise<Result> {
    return (await (await app.request(`/missions/${id}`)).json()) as Result;
  }

  it("aceita o último milissegundo do prazo em São Paulo", async () => {
    expect((await approve("ultimo", "msn_1842", "2026-03-13T02:59:59.999Z")).status).toBe(201);
    expect((await mission("msn_1842")).ledger).toHaveLength(1);
  });

  it("recusa o primeiro milissegundo do dia seguinte, sem gravar efeitos", async () => {
    expect((await approve("seguinte", "msn_1842", "2026-03-13T03:00:00.000Z")).status).toBe(409);
    const result = await mission("msn_1842");
    expect(result.mission.status).toBe("open");
    expect(result.ledger).toEqual([]);
    expect(result.payout).toBeNull();
  });

  it("interpreta offsets explícitos pelo mesmo instante, não pela data escrita", async () => {
    expect((await approve("offset", "msn_1842", "2026-03-13T01:30:00.000+02:00")).status).toBe(201);
  });

  it("usa as regras do fuso IANA, inclusive horário de verão histórico", async () => {
    db.prepare("UPDATE missions SET deadline_date = '2018-11-04' WHERE id = 'msn_1842'").run();
    expect((await approve("dst", "msn_1842", "2018-11-05T01:59:59.999Z")).status).toBe(201);
    expect((await approve("dst-tarde", "msn_1842", "2018-11-05T02:00:00.000Z")).status).toBe(409);
  });

  it("reproduz a chave com U+200B registrada no log sem novo crédito", async () => {
    const first = await approve("pay_7c1");
    const retry = await approve("pay_7c1\u200b");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    const original = await first.json();
    expect(await retry.json()).toEqual(original);
    const result = await mission();
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ amount_brl: 80, idempotency_key: "pay_7c1" });
  });

  it("normaliza espaços externos e caixa sem colapsar espaços internos", async () => {
    expect((await approve("  PAY_Case\t")).status).toBe(201);
    expect((await approve("pay_case")).status).toBe(200);
    expect((await mission()).ledger).toHaveLength(1);
    expect((await approve("pay case", "msn_1900")).status).toBe(201);
  });

  it("rejeita chave vazia após retirar ruído invisível, sem efeitos", async () => {
    expect((await approve(" \u200b\t")).status).toBe(400);
    expect((await mission()).ledger).toEqual([]);
    expect((await mission()).payout).toBeNull();
  });

  it("uma missão recebe uma única vez mesmo quando o retry troca a chave", async () => {
    const first = await approve("primeira");
    const retry = await approve("outra");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect((await mission()).ledger).toHaveLength(1);
  });

  it("não associa a outra missão um crédito de uma chave já usada", async () => {
    expect((await approve("global")).status).toBe(201);
    expect((await approve("global\u200b ", "msn_1900")).status).toBe(409);
    const other = await mission("msn_1900");
    expect(other.mission.status).toBe("open");
    expect(other.ledger).toEqual([]);
    expect(other.payout).toBeNull();
  });

  it("serializa requisições concorrentes sem duplicar crédito ou repasse", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => approve(`retry_${i}`)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(19);
    const result = await mission();
    expect(result.ledger).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM payouts").get()).toMatchObject({ total: 1 });
  });

  it("reverte o crédito se a gravação do repasse falhar e permite retry", async () => {
    db.exec(`CREATE TRIGGER fail_payout BEFORE INSERT ON payouts
      BEGIN SELECT RAISE(ABORT, 'falha simulada do banco'); END;`);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await approve("atomic")).status).toBe(500);
    } finally {
      errorLog.mockRestore();
    }
    const result = await mission();
    expect(result.mission.status).toBe("open");
    expect(result.ledger).toEqual([]);
    expect(result.payout).toBeNull();

    db.exec("DROP TRIGGER fail_payout");
    expect((await approve("atomic")).status).toBe(201);
    expect((await mission()).ledger).toHaveLength(1);
  });

  it.each([1, 99, 101, 15000])("converte %i centavos uma única vez", async (cents) => {
    db.prepare("UPDATE missions SET amount_cents = ? WHERE id = 'msn_2044'").run(cents);
    expect((await approve("valor")).status).toBe(201);
    expect((await mission()).ledger[0]!.amount_brl).toBe(cents / 100);
  });

  it.each([
    ["PENDING", "pending"],
    ["RECEIVED", "paid"],
    ["CONFIRMED", "paid"],
    ["FAILED", "failed"],
  ])("mapeia %s para %s e repetir callback não duplica crédito", async (providerStatus, status) => {
    await approve("callback");
    const payout = (await mission()).payout!;
    for (let retry = 0; retry < 2; retry++) {
      const response = await post(app, `/payouts/${payout.id}/provider`, { provider_status: providerStatus });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ provider_status: providerStatus, status });
    }
    expect((await mission()).ledger).toHaveLength(1);
  });

  it("status desconhecido não altera o repasse existente", async () => {
    await approve("unknown");
    const payout = (await mission()).payout!;
    const response = await post(app, `/payouts/${payout.id}/provider`, { provider_status: "BANANA" });
    expect(response.status).toBe(400);
    expect((await mission()).payout).toEqual(payout);
  });

  it("data inválida retorna 400 sem gravar crédito", async () => {
    expect((await approve("data", "msn_2044", "não é data")).status).toBe(400);
    expect((await mission()).ledger).toEqual([]);
  });

  it.each([
    "2026-02-30T12:00:00.000Z",
    "2026-02-29T12:00:00.000Z",
    "1900-02-29T12:00:00.000Z",
    "2026-06-31T12:00:00.000-03:00",
    "+010000-03-12T21:00:00.000Z",
    "-000001-03-12T21:00:00.000Z",
    "0000-03-12T21:00:00.000Z",
    "9999-12-31T23:59:59.999-04:00",
  ])("rejeita calendário inexistente ou ano civil não suportado: %s", async (approvedAt) => {
    expect((await approve("calendario", "msn_1842", approvedAt)).status).toBe(400);
    const result = await mission("msn_1842");
    expect(result.mission.status).toBe("open");
    expect(result.ledger).toEqual([]);
    expect(result.payout).toBeNull();
  });

  it.each([
    "2024-02-29T12:00:00.000Z",
    "2000-02-29T12:00:00.000Z",
    "0999-03-12T12:00:00.000Z",
    "2026-03-12T23:59:59.999-03:00",
    "2026-03-12T18:11:00Z",
    "2026-03-12T18:11:00.123456+02:00",
    "2026-03-12T18:11+0200",
    "2026-03-12",
  ])("preserva calendário válido e representações ISO aceitas: %s", async (approvedAt) => {
    expect((await approve("iso-valido", "msn_1842", approvedAt)).status).toBe(201);
    expect((await mission("msn_1842")).ledger).toHaveLength(1);
  });
});
