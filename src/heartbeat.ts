/**
 * Heartbeat de event loop, usado pelos cenarios 04 e 07.
 *
 * Um setInterval que deveria bater a cada 100 ms. A distancia entre duas
 * batidas mede quanto tempo o event loop passou sem conseguir rodar nada.
 */
import { performance } from 'node:perf_hooks';

export const INTERVALO_HEARTBEAT_MS = 100;

export interface Batidas {
  /** intervalos medidos entre batidas consecutivas, em ms */
  lacunas: number[];
  batidas: number;
  maiorLacuna: number;
}

export function ligarHeartbeat(silencioso: boolean): { parar: () => Batidas } {
  const lacunas: number[] = [];
  let ultima = performance.now();
  let batidas = 0;

  const timer = setInterval(() => {
    const agora = performance.now();
    const lacuna = agora - ultima;
    ultima = agora;
    batidas++;
    lacunas.push(lacuna);
    if (!silencioso) {
      const atraso = lacuna - INTERVALO_HEARTBEAT_MS;
      const alerta = atraso > 50 ? `   <-- atrasou ${atraso.toFixed(0)} ms` : '';
      console.log(
        `  batida ${String(batidas).padStart(2)} | intervalo ${lacuna.toFixed(1)} ms${alerta}`,
      );
    }
  }, INTERVALO_HEARTBEAT_MS);

  return {
    parar: (): Batidas => {
      clearInterval(timer);
      return { lacunas, batidas, maiorLacuna: Math.max(0, ...lacunas) };
    },
  };
}

export const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
