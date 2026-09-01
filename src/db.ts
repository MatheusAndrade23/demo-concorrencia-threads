/**
 * Pool, seed e verificacao da invariante.
 *
 * Este e o unico arquivo do projeto que NAO contem bug intencional: ele e a
 * regua. Se a medicao aqui estiver errada, nenhum cenario prova nada.
 */
import 'dotenv/config';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { fileURLToPath } from 'node:url';
import type { Invariante } from './tipos.js';

export type { Pool, PoolClient };

export interface Config {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** quantas contas o seed cria */
  contas: number;
  /** saldo de cada conta apos o seed */
  saldoInicial: number;
  /** padroes usados quando um cenario roda sozinho */
  operacoes: number;
  concorrencia: number;
  valorSaque: number;
}

function numeroDoAmbiente(chave: string, padrao: number): number {
  const bruto = process.env[chave];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  if (!Number.isFinite(n)) {
    throw new Error(`Variavel de ambiente ${chave} deveria ser um numero, veio "${bruto}".`);
  }
  return n;
}

export function lerConfig(): Config {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: numeroDoAmbiente('PGPORT', 5433),
    user: process.env.PGUSER ?? 'demo',
    password: process.env.PGPASSWORD ?? 'demo',
    database: process.env.PGDATABASE ?? 'banco',
    contas: numeroDoAmbiente('CONTAS', 10),
    saldoInicial: numeroDoAmbiente('SALDO_INICIAL', 1000),
    operacoes: numeroDoAmbiente('OPERACOES', 200),
    concorrencia: numeroDoAmbiente('CONCORRENCIA', 32),
    valorSaque: numeroDoAmbiente('VALOR_SAQUE', 1),
  };
}

/**
 * Cria um Pool novo.
 *
 * `max` importa: se o pool tiver menos conexoes do que a concorrencia pedida,
 * ele proprio enfileira as operacoes e a corrida do cenario 02 fica mascarada.
 * Por isso todo cenario concorrente passa max = concorrencia.
 */
export function criarPool(max = 10, cfg: Config = lerConfig()): Pool {
  return new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Um Client solto, sem pool. Usado de proposito pelo cenario 05. */
export function criarClient(cfg: Config = lerConfig()): pg.Client {
  return new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
}

/**
 * Falha com mensagem legivel em vez de despejar um ECONNREFUSED cru.
 * Encerra o processo: nenhum cenario faz sentido sem banco.
 */
export async function verificarConexao(pool: Pool): Promise<void> {
  const cfg = lerConfig();
  try {
    await pool.query('SELECT 1');
  } catch (erro) {
    const e = erro as NodeJS.ErrnoException & { code?: string };
    const alvo = `${cfg.host}:${cfg.port}/${cfg.database}`;
    console.error(`\n[ERRO] Nao consegui falar com o Postgres em ${alvo}.`);
    switch (e.code) {
      case 'ECONNREFUSED':
        console.error('       O banco esta fora do ar. Suba com:  npm run db:up');
        break;
      case 'ENOTFOUND':
        console.error(`       O host "${cfg.host}" nao resolve. Confira PGHOST no .env.`);
        break;
      case 'ETIMEDOUT':
        console.error('       A conexao expirou. O container esta rodando?  docker compose ps');
        break;
      case '28P01':
        console.error('       Usuario ou senha recusados. Confira PGUSER e PGPASSWORD no .env.');
        break;
      case '3D000':
        console.error(`       O banco "${cfg.database}" nao existe. Confira PGDATABASE no .env.`);
        break;
      default:
        console.error(`       ${e.message}`);
    }
    console.error('');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

/** DDL idempotente. */
export async function migrar(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas (
      id      SERIAL PRIMARY KEY,
      titular TEXT NOT NULL,
      -- Sem CHECK (saldo >= 0) DE PROPOSITO: a constraint transformaria parte do
      -- lost update em erro visivel e esconderia o dinheiro que some.
      saldo   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS movimentos (
      id        BIGSERIAL PRIMARY KEY,
      conta_id  INT NOT NULL REFERENCES contas(id),
      valor     NUMERIC(12,2) NOT NULL,
      origem    TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS movimentos_conta_id_idx ON movimentos (conta_id);
  `);
}

/** Zera tudo e recria as contas com saldo fixo. */
export async function semear(pool: Pool, cfg: Config = lerConfig()): Promise<void> {
  await pool.query('TRUNCATE movimentos, contas RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO contas (titular, saldo)
     SELECT 'Conta ' || g, $1::numeric
     FROM generate_series(1, $2::int) AS g`,
    [cfg.saldoInicial, cfg.contas],
  );
}

/** migrar + semear. O benchmark chama isto antes de CADA repeticao. */
export async function resetar(pool: Pool, cfg: Config = lerConfig()): Promise<void> {
  await migrar(pool);
  await semear(pool, cfg);
}

/**
 * A PEGADINHA DO pg: NUMERIC volta como string, nao como number.
 *
 * O driver faz isso de proposito, porque NUMERIC(12,2) do Postgres tem precisao
 * maior do que o double do JS e converter sozinho perderia informacao. O efeito
 * pratico e que "500" - 1 da 499, mas "500" + 1 da "5001". Toda leitura de saldo
 * neste projeto passa por aqui.
 */
export function paraNumero(v: string | number | null): number {
  if (v === null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

export interface Conta {
  id: number;
  titular: string;
  saldo: number;
}

export async function listarContas(pool: Pool): Promise<Conta[]> {
  const { rows } = await pool.query('SELECT id, titular, saldo FROM contas ORDER BY id');
  return rows.map((r) => ({ id: r.id, titular: r.titular, saldo: paraNumero(r.saldo) }));
}

export async function somaSaldos(pool: Pool): Promise<number> {
  const { rows } = await pool.query('SELECT COALESCE(SUM(saldo), 0) AS total FROM contas');
  return paraNumero(rows[0].total);
}

export function totalEsperado(cfg: Config = lerConfig()): number {
  return cfg.contas * cfg.saldoInicial;
}

/** SUM(movimentos.valor). Negativo quando saiu dinheiro do sistema. */
export async function somaMovimentos(pool: Pool): Promise<number> {
  const { rows } = await pool.query('SELECT COALESCE(SUM(valor), 0) AS total FROM movimentos');
  return paraNumero(rows[0].total);
}

/** Arredonda em centavos, para nao acusar perda por ruido de ponto flutuante. */
export function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Confere a invariante do projeto contra o razao. Ver o comentario de
 * `Invariante` em tipos.ts para a definicao e o porque.
 */
export async function verificarInvariante(pool: Pool, saldoInicial: number): Promise<Invariante> {
  const [observado, movimentos] = await Promise.all([somaSaldos(pool), somaMovimentos(pool)]);
  return montarInvariante(saldoInicial, movimentos, observado);
}

/** Mesma conta, sem banco. O cenario 06 usa isto para o contador em memoria. */
export function montarInvariante(
  saldoInicial: number,
  movimentos: number,
  observado: number,
): Invariante {
  const esperado = centavos(saldoInicial + movimentos);
  const divergencia = centavos(observado - esperado);
  return {
    saldoInicial: centavos(saldoInicial),
    movimentos: centavos(movimentos),
    esperado,
    observado: centavos(observado),
    divergencia,
    perdido: Math.abs(divergencia),
  };
}

export interface ErroClassificado {
  /** SQLSTATE quando vem do Postgres, ou um pseudo-codigo para o resto */
  sqlstate: string;
  mensagem: string;
}

/**
 * Todo erro vira {sqlstate, mensagem}. Erros que nao sao do banco recebem um
 * pseudo-codigo em maiusculas (ECONNREFUSED, JS, DESCONHECIDO) para caberem na
 * mesma contagem sem precisar de outro campo.
 */
export function classificarErro(erro: unknown): ErroClassificado {
  if (erro instanceof Error) {
    const codigo = (erro as NodeJS.ErrnoException & { code?: string }).code;
    return { sqlstate: codigo ?? 'JS', mensagem: erro.message };
  }
  return { sqlstate: 'DESCONHECIDO', mensagem: String(erro) };
}

/** Acumula erros por SQLSTATE. Nenhum cenario aborta o benchmark. */
export class ContadorDeErros {
  private readonly contagem = new Map<string, number>();
  private readonly exemplos = new Map<string, string>();

  registrar(erro: unknown): ErroClassificado {
    const c = classificarErro(erro);
    this.contagem.set(c.sqlstate, (this.contagem.get(c.sqlstate) ?? 0) + 1);
    if (!this.exemplos.has(c.sqlstate)) this.exemplos.set(c.sqlstate, c.mensagem);
    return c;
  }

  total(): number {
    let soma = 0;
    for (const n of this.contagem.values()) soma += n;
    return soma;
  }

  porSqlstate(): Record<string, number> {
    return Object.fromEntries([...this.contagem.entries()].sort((a, b) => b[1] - a[1]));
  }

  exemploDe(sqlstate: string): string | undefined {
    return this.exemplos.get(sqlstate);
  }
}

export async function fecharPool(pool: Pool): Promise<void> {
  await pool.end().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// npx tsx src/db.ts --reset
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = lerConfig();
  const pool = criarPool(2, cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);
  const total = await somaSaldos(pool);
  console.log(
    `Banco pronto: ${cfg.contas} contas x ${cfg.saldoInicial} = ${total.toFixed(2)} ` +
      `em ${cfg.host}:${cfg.port}/${cfg.database}`,
  );
  await fecharPool(pool);
}
