/**
 * CENARIO 05 - a conexao compartilhada   (Bloco A)
 *
 * Todas as operacoes usam o MESMO `Client` do pg em vez de um `Pool`.
 *
 * O efeito nao e corrupcao, e serializacao: o driver mantem uma fila interna por
 * conexao e so manda a proxima query depois que a anterior respondeu. As 32
 * promises "concorrentes" viram uma fila unica, e o throughput desaba para o
 * nivel do cenario 01, sem que ninguem tenha escrito um laco sequencial.
 *
 * SOBRE A LATENCIA SIMULADA: com o Postgres em loopback cada query responde em
 * ~0.15 ms e o gargalo vira a CPU do proprio Node, o que esconde o efeito. Um
 * banco de verdade, na rede, custa alguns milissegundos por ida e volta. Por
 * isso cada SELECT carrega um pg_sleep de LATENCIA_DE_REDE_MS: e a latencia que
 * o loopback nao tem, e e ela que revela a fila do driver.
 *
 * Detalhe que costuma surpreender: a corrida do cenario 02 CONTINUA aqui. O
 * driver serializa as queries, nao as transacoes. A ordem vira SELECT-A,
 * SELECT-B, UPDATE-A, UPDATE-B, e os dois leem o mesmo saldo velho do mesmo
 * jeito. Perde-se o desempenho e nao se ganha a correcao.
 */
import { performance } from 'node:perf_hooks';
import {
  aquecerPool,
  ContadorDeErros,
  criarClient,
  criarPool,
  fecharPool,
  lerConfig,
  paraNumero,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import { ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '05-conexao-compartilhada';
const CONTA_ALVO = 1;

/** Latencia por query, em ms. Simula um banco na rede em vez de em loopback. */
export const LATENCIA_DE_REDE_MS = 2;

/** Aceita Client ou Pool: os dois tem `query`. A diferenca esta em quem chama. */
interface Executor {
  query(texto: string, valores?: unknown[]): Promise<{ rows: any[] }>;
}

async function saque(executor: Executor, contaId: number, valor: number): Promise<void> {
  const { rows } = await executor.query(
    'SELECT saldo, pg_sleep($2) FROM contas WHERE id = $1',
    [contaId, LATENCIA_DE_REDE_MS / 1000],
  );
  const saldo = paraNumero(rows[0].saldo);
  await executor.query('UPDATE contas SET saldo = $1 WHERE id = $2', [saldo - valor, contaId]);
  await executor.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
    contaId,
    -valor,
    NOME,
  ]);
}

/** Dispara `operacoes` saques com `concorrencia` promises puxando de uma fila. */
async function rodarCarga(
  executor: Executor,
  opts: OpcoesCenario,
  erros: ContadorDeErros,
): Promise<{ ms: number; concluidas: number; porTrabalhador: number[] }> {
  const porTrabalhador = new Array<number>(opts.concorrencia).fill(0);
  let concluidas = 0;
  let restantes = opts.operacoes;

  async function trabalhador(indice: number): Promise<void> {
    while (restantes > 0) {
      restantes--;
      try {
        await saque(executor, CONTA_ALVO, opts.valorSaque);
        porTrabalhador[indice]++;
        concluidas++;
      } catch (erro) {
        erros.registrar(erro);
      }
    }
  }

  const inicio = performance.now();
  await Promise.all(Array.from({ length: opts.concorrencia }, (_, i) => trabalhador(i)));
  return { ms: performance.now() - inicio, concluidas, porTrabalhador };
}

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const poolDeApoio = criarPool(2, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);
  const erros = new ContadorDeErros();

  // -------- fase A: um Client so, compartilhado por todas as promises --------
  // BUG INTENCIONAL: Client unico onde deveria haver Pool. Toda a concorrencia
  // do processo passa por um cano de uma via so.
  const client = criarClient(cfg);
  await client.connect();
  const faseA = await rodarCarga(client as unknown as Executor, opts, erros);
  const invariante = await verificarInvariante(poolDeApoio, saldoInicial);
  await client.end();

  // -------- fase B: a mesma carga, com Pool de verdade, so para comparar -----
  await resetar(poolDeApoio, cfg);
  const pool = criarPool(opts.concorrencia, cfg);
  await aquecerPool(pool, opts.concorrencia);
  const faseB = await rodarCarga(pool as unknown as Executor, opts, new ContadorDeErros());
  await fecharPool(pool);
  await fecharPool(poolDeApoio);

  const throughputClient = (faseA.concluidas / faseA.ms) * 1000;
  const throughputPool = (faseB.concluidas / faseB.ms) * 1000;

  return {
    cenario: NOME,
    concorrencia: opts.concorrencia,
    operacoes: opts.operacoes,
    concluidas: faseA.concluidas,
    ms: faseA.ms,
    throughput: throughputClient,
    invariante,
    erros: erros.porSqlstate(),
    porTrabalhador: faseA.porTrabalhador,
    extra: {
      msClientCompartilhado: Number(faseA.ms.toFixed(2)),
      msComPool: Number(faseB.ms.toFixed(2)),
      throughputClientCompartilhado: Number(throughputClient.toFixed(1)),
      throughputComPool: Number(throughputPool.toFixed(1)),
      vezesMaisLento: Number((faseB.concluidas / faseB.ms === 0 ? 0 : faseA.ms / faseB.ms).toFixed(2)),
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENARIO 05 - a conexao compartilhada');
  console.log(`  ${cfg.operacoes} saques com ${cfg.concorrencia} promises concorrentes,`);
  console.log('  primeiro num Client unico, depois num Pool. Mesma carga, mesmo codigo.');

  const r = await executar({
    operacoes: cfg.operacoes,
    concorrencia: cfg.concorrencia,
    valorSaque: cfg.valorSaque,
  });

  secao('a fila escondida dentro do driver');
  console.log(`  Client compartilhado ... ${r.extra?.msClientCompartilhado} ms  (${r.extra?.throughputClientCompartilhado} ops/s)`);
  console.log(`  Pool com max=${cfg.concorrencia} ......... ${r.extra?.msComPool} ms  (${r.extra?.throughputComPool} ops/s)`);
  console.log(`  o Client foi ${r.extra?.vezesMaisLento}x mais lento com a MESMA concorrencia declarada.`);

  imprimirResumo(r, [
    'Ninguem escreveu um laco sequencial. A fila e do driver, uma por conexao.',
    'Repare que a divergencia continua diferente de zero: serializar a conexao',
    'nao serializa a transacao, entao o lost update do cenario 02 sobrevive.',
  ]);
}
