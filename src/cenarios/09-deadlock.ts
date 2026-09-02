/**
 * CENÁRIO 09 - deadlock sem nenhum lock no código   (Bloco B)
 *
 * Metade dos workers transfere da conta A para a B, a outra metade da B para a
 * A, ao mesmo tempo. Não existe mutex, semáforo nem `LOCK TABLE` em lugar nenhum
 * do código: quem trava é o UPDATE, porque no Postgres um UPDATE segura a linha
 * até o COMMIT.
 *
 * A transação que vai de A para B trava A e depois quer B. A que vai de B para A
 * trava B e depois quer A. As duas esperam para sempre, e o Postgres detecta o
 * ciclo e mata uma delas com SQLSTATE 40P01 (deadlock_detected).
 *
 * O erro é capturado, classificado e contado. Não há retry: retry seria a
 * correção, e a correção não é o produto aqui.
 */
import { performance } from 'node:perf_hooks';
import {
  criarPool,
  fecharPool,
  lerConfig,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import { barras, ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsDeadlock, ResultadoDeadlock } from '../workers/deadlock-worker.js';

export const NOME = '09-deadlock';
const CONTA_A = 1;
const CONTA_B = 2;

/** Tempo que cada transação segura a primeira linha antes de pedir a segunda. */
export const PAUSA_MS = 20;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  // número par: metade vai numa direção, metade na outra
  const workers = Math.max(2, opts.concorrencia % 2 === 0 ? opts.concorrencia : opts.concorrencia + 1);

  const poolDeApoio = criarPool(2, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);

  const porWorker = Math.max(1, Math.floor(opts.operacoes / workers));
  const entradas: EntradaWorker<ParamsDeadlock>[] = Array.from({ length: workers }, (_, id) => {
    const vaiDeAparaB = id % 2 === 0;
    return {
      id,
      config: cfg,
      params: {
        de: vaiDeAparaB ? CONTA_A : CONTA_B,
        para: vaiDeAparaB ? CONTA_B : CONTA_A,
        valor: opts.valorSaque,
        transferencias: porWorker,
        pausaMs: PAUSA_MS,
        origem: NOME,
      },
    };
  });

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsDeadlock, ResultadoDeadlock>(
    './deadlock-worker.js',
    entradas,
  );
  const ms = performance.now() - inicio;

  const { ok, falhas } = separar(saidas);
  const erros: Record<string, number> = {};
  for (const f of falhas) erros[f.erro.sqlstate] = (erros[f.erro.sqlstate] ?? 0) + 1;
  for (const s of ok) {
    for (const [sqlstate, n] of Object.entries(s.resultado.erros)) {
      erros[sqlstate] = (erros[sqlstate] ?? 0) + n;
    }
  }
  const concluidas = ok.reduce((soma, s) => soma + s.resultado.concluidas, 0);
  const deadlocks = ok.reduce((soma, s) => soma + s.resultado.deadlocks, 0);
  const tentativas = porWorker * workers;

  const invariante = await verificarInvariante(poolDeApoio, saldoInicial);
  await fecharPool(poolDeApoio);

  return {
    cenario: NOME,
    concorrencia: workers,
    operacoes: tentativas,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros,
    porTrabalhador: ok.map((s) => s.resultado.concluidas),
    extra: {
      workers,
      deadlocks,
      tentativas,
      transferenciasAbortadas: tentativas - concluidas,
      percentualAbortado: Number((((tentativas - concluidas) / tentativas) * 100).toFixed(1)),
      pausaMs: PAUSA_MS,
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  const workers = Math.min(8, Math.max(2, cfg.concorrencia));
  titulo('CENÁRIO 09 - deadlock sem nenhum lock no código');
  console.log(`  ${workers} workers: metade transfere ${CONTA_A} -> ${CONTA_B},`);
  console.log(`  metade ${CONTA_B} -> ${CONTA_A}, tudo ao mesmo tempo.`);

  const r = await executar({
    operacoes: workers * 10,
    concorrencia: workers,
    valorSaque: 10,
  });

  secao('o que o Postgres fez com as transações');
  console.log(`  tentativas ............... ${r.extra?.tentativas}`);
  console.log(`  commitadas ............... ${r.concluidas}`);
  console.log(`  abortadas ................ ${r.extra?.transferenciasAbortadas} (${r.extra?.percentualAbortado}%)`);
  console.log(`  destas, deadlock 40P01 ... ${r.extra?.deadlocks}`);

  imprimirResumo(r, [
    'Nenhuma linha deste projeto pede um lock. O UPDATE pede por você.',
    'O 40P01 não é bug do Postgres, é o Postgres avisando que o código travou.',
    'Não há retry aqui: a transferência abortada simplesmente não aconteceu.',
  ]);
  console.log('  transferências commitadas por worker (par = A->B, ímpar = B->A):');
  barras(r.porTrabalhador, 'w');
  console.log('');
}
