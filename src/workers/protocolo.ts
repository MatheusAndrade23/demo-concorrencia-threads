/**
 * Como os workers recebem parametros e devolvem resultado.
 *
 * Entrada por `workerData`, saida por `parentPort.postMessage`. O pai espera o
 * evento `exit`, entao um worker que morre antes de responder vira um resultado
 * `{ ok: false }` em vez de derrubar o benchmark: a promise NUNCA rejeita.
 */
import { Worker } from 'node:worker_threads';
import { classificarErro } from '../db.js';
import type { Config } from '../db.js';

export interface EntradaWorker<P> {
  /** indice do worker, usado na distribuicao de operacoes por trabalhador */
  id: number;
  /** o worker abre o PROPRIO Pool a partir daqui (menos no cenario 05) */
  config: Config;
  params: P;
  /** memoria compartilhada, so nos cenarios que precisam (06) */
  sab?: SharedArrayBuffer;
}

export type SaidaWorker<R> =
  | { ok: true; id: number; resultado: R }
  | { ok: false; id: number; erro: { sqlstate: string; mensagem: string } };

/** Sobe um worker por entrada e espera todos. Nunca rejeita. */
export function rodarWorkers<P, R>(
  arquivo: string,
  entradas: EntradaWorker<P>[],
): Promise<SaidaWorker<R>[]> {
  const url = new URL(arquivo, import.meta.url);
  return Promise.all(entradas.map((entrada) => umWorker<P, R>(url, entrada)));
}

function umWorker<P, R>(url: URL, entrada: EntradaWorker<P>): Promise<SaidaWorker<R>> {
  return new Promise((resolver) => {
    const worker = new Worker(url, { workerData: entrada });
    let resposta: SaidaWorker<R> | undefined;

    worker.on('message', (m: SaidaWorker<R>) => {
      resposta = m;
    });
    worker.on('error', (e) => {
      resposta = { ok: false, id: entrada.id, erro: classificarErro(e) };
    });
    worker.on('exit', (codigo) => {
      if (resposta !== undefined) {
        resolver(resposta);
        return;
      }
      resolver({
        ok: false,
        id: entrada.id,
        erro: {
          sqlstate: 'WORKER_SEM_RESPOSTA',
          mensagem: `worker ${entrada.id} saiu com codigo ${codigo} sem responder`,
        },
      });
    });
  });
}

/** Ajuda os cenarios a separarem o joio do trigo sem repetir o filtro. */
export function separar<R>(saidas: SaidaWorker<R>[]): {
  ok: { id: number; resultado: R }[];
  falhas: { id: number; erro: { sqlstate: string; mensagem: string } }[];
} {
  const ok: { id: number; resultado: R }[] = [];
  const falhas: { id: number; erro: { sqlstate: string; mensagem: string } }[] = [];
  for (const s of saidas) {
    if (s.ok) ok.push({ id: s.id, resultado: s.resultado });
    else falhas.push({ id: s.id, erro: s.erro });
  }
  return { ok, falhas };
}
