/**
 * CASO 03 - lost update em memória compartilhada
 *
 * Paralelismo de verdade contra uma variável só: N workers, cada um numa thread
 * do sistema operacional, incrementando o MESMO Int32Array sobre um
 * SharedArrayBuffer. Nenhum banco envolvido.
 *
 * `contador[0] = contador[0] + 1` são três operações de máquina: carrega da
 * memória, soma, escreve de volta. Dois núcleos que carregam o mesmo valor ao
 * mesmo tempo escrevem o mesmo resultado, e um dos dois incrementos evapora.
 *
 * É o caso onde a curva de perda por número de threads é mais limpa: com uma
 * thread não se perde nada, e a partir de duas a perda sobe junto com o número
 * de threads que disputam a mesma posição de memória. `Atomics.add` resolveria,
 * e por isso mesmo não está aqui.
 */
import { performance } from 'node:perf_hooks';
import { lerConfig, montarInvariante } from '../db.js';
import type { OpcoesCaso, ResultadoCaso } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsSab, ResultadoSab } from '../workers/sab-worker.js';

export const NOME = '03-worker-sab-corrida';

/**
 * Total de incrementos, dividido entre as threads.
 *
 * O total é fixo de propósito, como nos casos 02 e 04: se cada thread fizesse um
 * número fixo de incrementos, o trabalho total cresceria junto com o número de
 * threads e nem a curva de tempo nem a de perda diriam alguma coisa sobre
 * paralelismo. Precisa ser grande para a janela da corrida abrir.
 */
export const INCREMENTOS_TOTAIS = 16_000_000;

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const cfg = lerConfig();
  const threads = Math.max(1, opts.threads);
  const total = Math.max(threads, Math.round(opts.operacoes));

  // divide o total; o resto vai para as primeiras threads
  const base = Math.floor(total / threads);
  const resto = total % threads;

  // 4 bytes: um único Int32 compartilhado entre todas as threads
  const sab = new SharedArrayBuffer(4);
  const contador = new Int32Array(sab);
  contador[0] = 0;

  const entradas: EntradaWorker<ParamsSab>[] = Array.from({ length: threads }, (_, id) => ({
    id,
    config: cfg,
    params: {
      iteracoes: base + (id < resto ? 1 : 0),
      logNaSecaoCritica: opts.logNaSecaoCritica === true,
    },
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

  // saldoInicial 0, "movimentos" = incrementos que as threads dizem ter feito,
  // "observado" = o que sobrou no Int32Array. Mesma conta dos casos de banco.
  const invariante = montarInvariante(0, prometido, observado);

  return {
    caso: NOME,
    threads,
    operacoes: prometido,
    concluidas: observado,
    ms,
    throughput: (prometido / ms) * 1000,
    invariante,
    erros,
    porThread: ok.map((s) => s.resultado.iteracoes),
    extra: {
      workers: threads,
      incrementosPorThread: base,
      incrementosPerdidos: prometido - observado,
      percentualPerdido: Number((((prometido - observado) / Math.max(1, prometido)) * 100).toFixed(2)),
    },
  };
}
