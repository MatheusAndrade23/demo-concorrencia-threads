/**
 * O trabalho de CPU usado pelos cenários 04 e 07.
 *
 * Mora num arquivo só para que a comparação entre "event loop único" e
 * "worker_threads" seja honesta: os dois rodam exatamente a mesma função.
 *
 * POR QUE NÃO crypto.createHash: a versão com sha256 do node:crypto aloca um
 * contexto do OpenSSL a cada rodada, e com 8 threads a disputa pelo alocador
 * derruba o desempenho de cada worker para menos de um terço. A curva do
 * cenário 07 ficava achatada por um motivo que não tem nada a ver com o assunto
 * da aula. O misturador abaixo é aritmética de inteiros pura, sem alocar um
 * byte, então o único limite é núcleo físico disponível.
 */

/** Mistura inteiros em laço apertado. Puro CPU, zero I/O, zero alocação. */
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
