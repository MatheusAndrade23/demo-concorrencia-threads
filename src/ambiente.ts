/**
 * A máquina que produziu os números.
 *
 * Todo gráfico deste projeto tem o número de threads no eixo x, e uma curva de
 * threads sem saber quantas threads a máquina tem não quer dizer nada: o ponto
 * em que a curva para de melhorar é justamente o limite de paralelismo do
 * hardware. Por isso o benchmark grava este bloco junto dos resultados e os
 * gráficos desenham uma linha vertical em `threadsDaMaquina`.
 */
import os from 'node:os';

export interface Ambiente {
  /** os.availableParallelism(): threads de hardware que o Node pode usar */
  threadsDaMaquina: number;
  modeloCpu: string;
  plataforma: string;
  arquitetura: string;
  node: string;
  memoriaGb: number;
  medidoEm: string;
}

export function lerAmbiente(): Ambiente {
  const cpus = os.cpus();
  return {
    threadsDaMaquina: os.availableParallelism(),
    modeloCpu: cpus[0]?.model.trim() ?? 'desconhecido',
    plataforma: os.platform(),
    arquitetura: os.arch(),
    node: process.version,
    memoriaGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    medidoEm: new Date().toISOString(),
  };
}

/**
 * A varredura de threads usada por todos os casos.
 *
 * Potências de dois até o dobro do que a máquina tem, mais o próprio número de
 * threads da máquina e o dobro dele. Numa máquina de 10 threads isso dá
 * 1, 2, 4, 8, 10, 16, 20: pontos suficientes antes do limite do hardware, o
 * limite exato, e dois pontos depois dele, que é onde a curva de tempo para de
 * cair e a de perda costuma continuar subindo.
 */
export function varreduraDeThreads(threadsDaMaquina = lerAmbiente().threadsDaMaquina): number[] {
  const teto = threadsDaMaquina * 2;
  const pontos = new Set<number>([threadsDaMaquina, teto]);
  for (let n = 1; n <= teto; n *= 2) pontos.add(n);
  return [...pontos].sort((a, b) => a - b);
}
