/**
 * Worker do cenário 06. Não toca no banco: só incrementa um Int32Array que vive
 * num SharedArrayBuffer compartilhado com os outros workers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsSab {
  iteracoes: number;
  /** cenário 11: escreve uma linha dentro da seção crítica, a cada iteração */
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
  // mudar o custo da escrita, que é justamente o que perturba a corrida.
  if (observando) console.error(`  [debug] li ${contador[0]}`);

  // BUG INTENCIONAL: lê, soma e escreve em três passos; outro núcleo escreve no
  // meio e o incremento dele é apagado. Atomics.add resolveria, e por isso mesmo
  // não está aqui.
  contador[0] = contador[0]! + 1;
}

const saida: SaidaWorker<ResultadoSab> = {
  ok: true,
  id: entrada.id,
  resultado: { iteracoes: entrada.params.iteracoes },
};
parentPort!.postMessage(saida);
