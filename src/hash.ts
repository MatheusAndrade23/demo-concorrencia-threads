/**
 * O trabalho de CPU usado pelos cenarios 04 e 07.
 *
 * Mora num arquivo so para que a comparacao entre "event loop unico" e
 * "worker_threads" seja honesta: os dois rodam exatamente a mesma funcao.
 *
 * POR QUE NAO crypto.createHash: a versao com sha256 do node:crypto aloca um
 * contexto do OpenSSL a cada rodada, e com 8 threads a disputa pelo alocador
 * derruba o desempenho de cada worker para menos de um terco. A curva do
 * cenario 07 ficava achatada por um motivo que nao tem nada a ver com o assunto
 * da aula. O misturador abaixo e aritmetica de inteiros pura, sem alocar um
 * byte, entao o unico limite e nucleo fisico disponivel.
 */

/** Mistura inteiros em laco apertado. Puro CPU, zero I/O, zero alocacao. */
export function trabalhoDeHash(rodadas: number, semente = 1): number {
  let h = (2166136261 ^ semente) | 0;
  for (let i = 0; i < rodadas; i++) {
    h ^= i;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h | 0;
}
