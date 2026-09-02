/**
 * CENÁRIO 07 - o mesmo trabalho, agora em worker_threads   (Bloco B)
 *
 * Pega o laço de sha256 do cenário 04 e distribui entre N workers. Duas coisas
 * mudam de uma vez:
 *
 *   1. o tempo total CAI conforme se adiciona worker, porque agora são núcleos
 *      físicos diferentes trabalhando ao mesmo tempo;
 *   2. o heartbeat do event loop principal continua batendo, porque a thread
 *      principal não está fazendo hash nenhum, só esperando mensagem.
 *
 * E o contraponto exato do cenário 04. Lá, `async` não comprou paralelismo
 * nenhum. Aqui, thread de verdade compra. A lição é que async/await serve para
 * esperar I/O, e worker_threads serve para gastar CPU: trocar um pelo outro não
 * resolve nada.
 */
import { performance } from 'node:perf_hooks';
import { lerConfig, montarInvariante } from '../db.js';
import { ligarHeartbeat } from '../heartbeat.js';
import { barras, distribuicao, ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsCpu, ResultadoCpu } from '../workers/cpu-worker.js';

export const NOME = '07-worker-cpu';

/** O mesmo total de rodadas do cenário 04, para a comparação ser justa. */
export const RODADAS_TOTAIS = 700_000_000;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const workers = Math.max(1, opts.concorrencia);
  const rodadasTotais = opts.operacoes;

  // divide o trabalho; o resto vai para os primeiros workers
  const base = Math.floor(rodadasTotais / workers);
  const resto = rodadasTotais % workers;
  const entradas: EntradaWorker<ParamsCpu>[] = Array.from({ length: workers }, (_, id) => ({
    id,
    config: cfg,
    params: { rodadas: base + (id < resto ? 1 : 0) },
  }));

  const heartbeat = ligarHeartbeat(opts.silencioso !== false);

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsCpu, ResultadoCpu>('./cpu-worker.js', entradas);
  const ms = performance.now() - inicio;

  const b = heartbeat.parar();
  const { ok, falhas } = separar(saidas);
  const erros: Record<string, number> = {};
  for (const f of falhas) erros[f.erro.sqlstate] = (erros[f.erro.sqlstate] ?? 0) + 1;
  const concluidas = ok.reduce((s, x) => s + x.resultado.rodadas, 0);

  return {
    cenario: NOME,
    concorrencia: workers,
    operacoes: rodadasTotais,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    // nenhum dinheiro se move: o que se mede aqui é tempo
    invariante: montarInvariante(0, 0, 0),
    erros,
    porTrabalhador: ok.map((x) => x.resultado.rodadas),
    maiorLacunaEventLoopMs: b.maiorLacuna,
    extra: {
      workers,
      rodadasPorWorker: base,
      msDoWorkerMaisLento: Number(Math.max(0, ...ok.map((x) => x.resultado.ms)).toFixed(2)),
      msDoWorkerMaisRapido: Number(Math.min(...ok.map((x) => x.resultado.ms)).toFixed(2)),
      hashesPorSegundo: Math.round((concluidas / ms) * 1000),
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  titulo('CENÁRIO 07 - o mesmo hash do cenário 04, agora em workers');
  console.log(`  ${RODADAS_TOTAIS.toLocaleString('pt-BR')} rodadas de sha256, divididas entre N workers.`);
  console.log(`  núcleos disponíveis: ${(await import('node:os')).availableParallelism()}`);

  secao('tempo x número de workers');
  console.log('  workers |     tempo |   hashes/s | maior lacuna do loop');
  console.log('  ' + '-'.repeat(58));

  const medidas: ResultadoCenario[] = [];
  for (const workers of [1, 2, 4, 8]) {
    const r = await executar({
      operacoes: RODADAS_TOTAIS,
      concorrencia: workers,
      valorSaque: 0,
      silencioso: true,
    });
    medidas.push(r);
    const linha =
      `  ${String(workers).padStart(7)} | ` +
      `${r.ms.toFixed(0).padStart(6)} ms | ` +
      `${String(r.extra?.hashesPorSegundo).padStart(10)} | ` +
      `${(r.maiorLacunaEventLoopMs ?? 0).toFixed(1).padStart(8)} ms`;
    console.log(linha);
  }

  const um = medidas[0]!;
  const oito = medidas[medidas.length - 1]!;
  console.log('');
  console.log(`  de 1 para ${oito.concorrencia} workers: ${(um.ms / oito.ms).toFixed(2)}x mais rápido`);

  imprimirResumo(oito, [
    'Compare com o cenário 04: lá a maior lacuna do event loop passou de 1700 ms.',
    'Aqui a thread principal só espera mensagem, então ela continua respondendo.',
    'Adicionar worker acelera trabalho de CPU. Adicionar async, não.',
  ]);
  console.log('  rodadas por worker na última medida:');
  barras(oito.porTrabalhador, 'w');
  console.log('  ' + distribuicao(oito.porTrabalhador) + '\n');
}
