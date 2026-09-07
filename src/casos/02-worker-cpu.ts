/**
 * CASO 02 - trabalho de CPU dividido entre threads
 *
 * O caso onde thread entrega exatamente o que promete. Um laço de mistura de
 * inteiros, puro CPU, dividido em partes iguais entre N workers. Nenhum estado
 * compartilhado, nenhum banco: cada thread recebe um pedaço, calcula sozinha e
 * devolve um número.
 *
 * É o contraponto de tudo o que vem depois. Aqui o tempo cai quase na proporção
 * do número de threads ATÉ o limite de threads da máquina, e depois para de
 * cair: passado esse ponto os workers passam a disputar os mesmos núcleos, e o
 * sistema operacional só reveza quem espera.
 *
 * Como não há estado compartilhado, o dinheiro perdido é zero em qualquer número
 * de threads. Esse zero é o resultado, não a ausência dele: separar o trabalho é
 * o que torna paralelismo seguro.
 */
import { performance } from 'node:perf_hooks';
import { lerConfig, montarInvariante } from '../db.js';
import type { OpcoesCaso, ResultadoCaso } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsCpu, ResultadoCpu } from '../workers/cpu-worker.js';

export const NOME = '02-worker-cpu';

/** Total de rodadas de mistura, sempre o mesmo, não importa quantas threads. */
export const RODADAS_TOTAIS = 400_000_000;

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const cfg = lerConfig();
  const threads = Math.max(1, opts.threads);
  const rodadasTotais = opts.operacoes;

  // divide o trabalho; o resto vai para as primeiras threads
  const base = Math.floor(rodadasTotais / threads);
  const resto = rodadasTotais % threads;
  const entradas: EntradaWorker<ParamsCpu>[] = Array.from({ length: threads }, (_, id) => ({
    id,
    config: cfg,
    params: { rodadas: base + (id < resto ? 1 : 0) },
  }));

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsCpu, ResultadoCpu>('./cpu-worker.js', entradas);
  const ms = performance.now() - inicio;

  const { ok, falhas } = separar(saidas);
  const erros: Record<string, number> = {};
  for (const f of falhas) erros[f.erro.sqlstate] = (erros[f.erro.sqlstate] ?? 0) + 1;
  const concluidas = ok.reduce((s, x) => s + x.resultado.rodadas, 0);

  return {
    caso: NOME,
    threads,
    operacoes: rodadasTotais,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    // nenhum dinheiro se move: o que se mede aqui é tempo, e a perda é zero
    invariante: montarInvariante(0, 0, 0),
    erros,
    porThread: ok.map((x) => x.resultado.rodadas),
    extra: {
      workers: threads,
      rodadasPorThread: base,
      msDaThreadMaisLenta: Number(Math.max(0, ...ok.map((x) => x.resultado.ms)).toFixed(2)),
      msDaThreadMaisRapida: Number(Math.min(...ok.map((x) => x.resultado.ms)).toFixed(2)),
      rodadasPorSegundo: Math.round((concluidas / ms) * 1000),
    },
  };
}
