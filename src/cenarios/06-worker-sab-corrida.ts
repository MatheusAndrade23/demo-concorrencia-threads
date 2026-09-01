/**
 * CENARIO 06 - corrida em memoria com worker_threads   (Bloco B)
 *
 * Agora sim ha paralelismo de verdade: N workers, cada um numa thread do
 * sistema operacional, incrementando o MESMO Int32Array sobre um
 * SharedArrayBuffer. Nenhum banco de dados envolvido.
 *
 * `contador[0] = contador[0] + 1` sao tres operacoes de maquina: carrega da
 * memoria, soma, escreve de volta. Dois nucleos que carregam o mesmo valor ao
 * mesmo tempo escrevem o mesmo resultado, e um dos dois incrementos evapora.
 *
 * O contraste com o cenario 02 e a tese da apresentacao: la o intervalo perigoso
 * era um `await`, aqui e uma instrucao de maquina. O bug e o mesmo lost update.
 */
import { performance } from 'node:perf_hooks';
import { lerConfig, montarInvariante } from '../db.js';
import { barras, distribuicao, ehPrincipal, imprimirResumo, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsSab, ResultadoSab } from '../workers/sab-worker.js';

export const NOME = '06-worker-sab-corrida';

/** Quantos incrementos cada worker faz. Precisa ser grande para a janela abrir. */
export const ITERACOES_POR_WORKER = 2_000_000;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const workers = Math.max(2, opts.concorrencia);
  const iteracoes = Math.max(1, Math.round(opts.operacoes));

  // 4 bytes: um unico Int32 compartilhado entre todas as threads
  const sab = new SharedArrayBuffer(4);
  const contador = new Int32Array(sab);
  contador[0] = 0;

  const entradas: EntradaWorker<ParamsSab>[] = Array.from({ length: workers }, (_, id) => ({
    id,
    config: cfg,
    params: { iteracoes, logNaSecaoCritica: opts.logNaSecaoCritica === true },
    sab,
  }));

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsSab, ResultadoSab>('./sab-worker.js', entradas);
  const ms = performance.now() - inicio;

  const { ok, falhas } = separar(saidas);
  const prometido = ok.reduce((soma, s) => soma + s.resultado.iteracoes, 0);
  const observado = contador[0]!;

  const erros: Record<string, number> = {};
  for (const f of falhas) erros[f.erro.sqlstate] = (erros[f.erro.sqlstate] ?? 0) + 1;

  // saldoInicial 0, "movimentos" = incrementos que os workers dizem ter feito,
  // "observado" = o que sobrou no Int32Array. Mesma conta dos cenarios de banco.
  const invariante = montarInvariante(0, prometido, observado);

  return {
    cenario: NOME,
    concorrencia: workers,
    operacoes: prometido,
    concluidas: observado,
    ms,
    throughput: (prometido / ms) * 1000,
    invariante,
    erros,
    porTrabalhador: ok.map((s) => s.resultado.iteracoes),
    extra: {
      workers,
      iteracoesPorWorker: iteracoes,
      incrementosPerdidos: prometido - observado,
      percentualPerdido: Number((((prometido - observado) / prometido) * 100).toFixed(2)),
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const workers = Math.max(2, lerConfig().concorrencia >= 4 ? 4 : 2);
  titulo('CENARIO 06 - lost update em memoria, com threads de verdade');
  console.log(`  ${workers} workers x ${ITERACOES_POR_WORKER.toLocaleString('pt-BR')} incrementos`);
  console.log('  no mesmo Int32Array, sem Atomics.');

  // roda tres vezes: o valor final nunca bate e nunca se repete
  for (let rep = 1; rep <= 3; rep++) {
    const r = await executar({
      operacoes: ITERACOES_POR_WORKER,
      concorrencia: workers,
      valorSaque: 0,
    });
    console.log(`\n  execucao ${rep}`);
    imprimirResumo(r, [
      `esperado ${r.invariante.esperado.toLocaleString('pt-BR')}, ` +
        `contador ficou em ${r.invariante.observado.toLocaleString('pt-BR')} ` +
        `(${r.extra?.percentualPerdido}% perdido)`,
    ]);
    if (rep === 1) {
      console.log('  incrementos por worker (o que cada um ACHA que fez):');
      barras(r.porTrabalhador, 'w');
      console.log('  ' + distribuicao(r.porTrabalhador));
    }
  }
  console.log('\n  > Rode de novo: o numero muda toda vez. Bug de corrida nao e deterministico.\n');
}
