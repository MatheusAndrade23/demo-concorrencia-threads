/**
 * Worker do cenario 06. Nao toca no banco: so incrementa um Int32Array que vive
 * num SharedArrayBuffer compartilhado com os outros workers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsSab {
  iteracoes: number;
  /** cenario 11: escreve uma linha dentro da secao critica, a cada iteracao */
  logNaSecaoCritica?: boolean;
}
export interface ResultadoSab {
  iteracoes: number;
}

const entrada = workerData as EntradaWorker<ParamsSab>;
const contador = new Int32Array(entrada.sab!);

const observando = entrada.params.logNaSecaoCritica === true;

for (let i = 0; i < entrada.params.iteracoes; i++) {
  // O log vai para stderr para dar para limpar a tela com 2>/dev/null sem
  // mudar o custo da escrita, que e justamente o que perturba a corrida.
  if (observando) console.error(`  [debug] li ${contador[0]}`);

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
