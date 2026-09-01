/**
 * CENARIO 08 - a mesma corrida, agora com paralelismo real   (Bloco B)
 *
 * N workers, cada um com o proprio Pool, fazendo saques read-modify-write na
 * mesma conta. E o cenario 02 com threads de verdade no lugar das promises.
 *
 * O ponto NAO e que fica pior. E que fica DIFERENTE. No cenario 02 uma thread so
 * intercalava as promises nos pontos de await, entao a perda seguia o ritmo do
 * event loop. Aqui os nucleos escrevem sem combinar nada, e o padrao de perda
 * muda: costuma haver menos leitores presos no mesmo valor velho ao mesmo tempo,
 * porque cada worker tem a propria fila de conexao e o proprio ritmo.
 *
 * Rodar os dois lado a lado e a melhor forma de matar a ideia de que "isso e
 * problema de thread".
 */
import { performance } from 'node:perf_hooks';
import {
  aquecerPool,
  criarPool,
  fecharPool,
  lerConfig,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import { barras, distribuicao, ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsBanco, ResultadoBanco } from '../workers/banco-worker.js';
import { executar as executarCenario02 } from './02-corrida-sem-thread.js';

export const NOME = '08-worker-banco';
const CONTA_ALVO = 1;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const workers = Math.max(1, opts.concorrencia);

  const poolDeApoio = criarPool(2, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);

  const base = Math.floor(opts.operacoes / workers);
  const resto = opts.operacoes % workers;
  const entradas: EntradaWorker<ParamsBanco>[] = Array.from({ length: workers }, (_, id) => ({
    id,
    config: cfg,
    params: {
      contaId: CONTA_ALVO,
      operacoes: base + (id < resto ? 1 : 0),
      valor: opts.valorSaque,
      origem: NOME,
    },
  }));

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsBanco, ResultadoBanco>('./banco-worker.js', entradas);
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

  const invariante = await verificarInvariante(poolDeApoio, saldoInicial);
  await fecharPool(poolDeApoio);

  return {
    cenario: NOME,
    concorrencia: workers,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros,
    porTrabalhador: ok.map((s) => s.resultado.concluidas),
    extra: {
      workers,
      saquesEfetivados: Math.round((saldoInicial - invariante.observado) / opts.valorSaque),
      saquesRegistrados: concluidas,
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  const workers = Math.min(8, Math.max(2, cfg.concorrencia));
  titulo('CENARIO 08 - a corrida do cenario 02, agora com workers');
  console.log(`  ${cfg.operacoes} saques na conta ${CONTA_ALVO}, divididos entre ${workers} workers,`);
  console.log('  cada um com o proprio Pool. Paralelismo de verdade.');

  const comWorkers = await executar({
    operacoes: cfg.operacoes,
    concorrencia: workers,
    valorSaque: cfg.valorSaque,
  });
  imprimirResumo(comWorkers);
  console.log('  saques por worker:');
  barras(comWorkers.porTrabalhador, 'w');
  console.log('  ' + distribuicao(comWorkers.porTrabalhador));

  const semThread = await executarCenario02({
    operacoes: cfg.operacoes,
    concorrencia: workers,
    valorSaque: cfg.valorSaque,
  });

  secao('lado a lado: mesma carga, mesma conta, mesma logica de saque');
  const linha = (rotulo: string, r: ResultadoCenario): void => {
    console.log(
      `  ${rotulo.padEnd(26)} divergencia ${String(r.invariante.divergencia).padStart(8)}` +
        `   debitou ${String(r.extra?.saquesEfetivados).padStart(4)} de ${r.concluidas}` +
        `   ${r.throughput.toFixed(0).padStart(5)} ops/s`,
    );
  };
  linha(`02 promises (1 thread)`, semThread);
  linha(`08 workers (${workers} threads)`, comWorkers);

  console.log('');
  console.log('  > Os dois perdem dinheiro. O bug nao veio da thread, veio do read-modify-write.');
  console.log('  > O que muda entre eles e o padrao da perda, nao a existencia dela.\n');
}
