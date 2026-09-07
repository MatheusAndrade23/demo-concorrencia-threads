/**
 * Worker do caso 02. Recebe um pedaço do total de rodadas, mistura inteiros na
 * própria thread e devolve o resultado. Não toca no banco e não compartilha
 * memória com ninguém: é trabalho de CPU separado, do jeito que dá certo.
 */
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { trabalhoDeHash } from '../hash.js';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsCpu {
  rodadas: number;
}
export interface ResultadoCpu {
  rodadas: number;
  ms: number;
  /** só para provar que o trabalho aconteceu de verdade */
  digest: number;
}

const entrada = workerData as EntradaWorker<ParamsCpu>;

const inicio = performance.now();
const digest = trabalhoDeHash(entrada.params.rodadas, entrada.id);
const ms = performance.now() - inicio;

const saida: SaidaWorker<ResultadoCpu> = {
  ok: true,
  id: entrada.id,
  resultado: { rodadas: entrada.params.rodadas, ms, digest },
};
parentPort!.postMessage(saida);
