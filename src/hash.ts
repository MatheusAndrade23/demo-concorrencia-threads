/**
 * O trabalho de CPU do caso 02.
 *
 * Mora num arquivo só porque a comparação entre números de threads só é honesta
 * se todas rodarem exatamente a mesma função.
 *
 * POR QUE NÃO crypto.createHash: a versão com sha256 do node:crypto aloca um
 * contexto do OpenSSL a cada rodada, e com 8 threads a disputa pelo alocador
 * derruba o desempenho de cada thread para menos de um terço, e a curva de
 * tempo por número de threads ficava achatada por um motivo que não tem nada a
 * ver com paralelismo. O misturador abaixo é aritmética de inteiros pura, sem
 * alocar um byte, então o único limite é núcleo físico disponível.
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
