/**
 * Worker do cenario 06. Nao toca no banco: so incrementa um Int32Array que vive
 * num SharedArrayBuffer compartilhado com os outros workers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsSab {
  iteracoes: number;
}
export interface ResultadoSab {
  iteracoes: number;
}

const entrada = workerData as EntradaWorker<ParamsSab>;
const contador = new Int32Array(entrada.sab!);

for (let i = 0; i < entrada.params.iteracoes; i++) {
  // BUG INTENCIONAL: le, soma e escreve em tres passos; outro nucleo escreve no
  // meio e o incremento dele e apagado. Atomics.add resolveria, e por isso mesmo
  // nao esta aqui.
  contador[0] = contador[0]! + 1;
}

const saida: SaidaWorker<ResultadoSab> = {
  ok: true,
  id: entrada.id,
  resultado: { iteracoes: entrada.params.iteracoes },
};
parentPort!.postMessage(saida);
