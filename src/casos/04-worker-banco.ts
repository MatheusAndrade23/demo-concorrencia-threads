/**
 * CASO 04 - lost update no banco, com threads de verdade
 *
 * N workers, cada um com o próprio Pool, fazendo saques read-modify-write na
 * MESMA conta. É o mesmo saque do caso 01, com a única diferença de que agora
 * várias threads o executam ao mesmo tempo.
 *
 * A janela perigosa é entre o SELECT e o UPDATE: nesse intervalo outra thread já
 * leu o mesmo saldo velho, e a segunda gravação apaga a primeira. O razão
 * registra todos os saques, a conta debita uma fração deles, e a diferença é o
 * dinheiro perdido que os gráficos medem.
 *
 * Contra o caso 01 a comparação é direta: mesma carga, mesma conta, mesma lógica
 * de saque, uma thread contra N. O tempo cai, a perda aparece.
 */
import { performance } from 'node:perf_hooks';
import {
  criarPool,
  fecharPool,
  lerConfig,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import type { OpcoesCaso, ResultadoCaso } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsBanco, ResultadoBanco } from '../workers/banco-worker.js';

export const NOME = '04-worker-banco';
const CONTA_ALVO = 1;

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const cfg = lerConfig();
  const threads = Math.max(1, opts.threads);

  const poolDeApoio = criarPool(2, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);

  // a carga total não muda com o número de threads: o que muda é entre quantas
  // threads ela é dividida, senão a comparação de tempo não valeria nada
  const base = Math.floor(opts.operacoes / threads);
  const resto = opts.operacoes % threads;
  const entradas: EntradaWorker<ParamsBanco>[] = Array.from({ length: threads }, (_, id) => ({
    id,
    config: cfg,
    params: {
      contaId: CONTA_ALVO,
      operacoes: base + (id < resto ? 1 : 0),
      valor: opts.valorSaque,
      origem: NOME,
    },
  }));

  const inicio = performance.now();
  const saidas = await rodarWorkers<ParamsBanco, ResultadoBanco>('./banco-worker.js', entradas);
  const ms = performance.now() - inicio;

  const { ok, falhas } = separar(saidas);
  const erros: Record<string, number> = {};
  for (const f of falhas) erros[f.erro.sqlstate] = (erros[f.erro.sqlstate] ?? 0) + 1;
  for (const s of ok) {
    for (const [sqlstate, n] of Object.entries(s.resultado.erros)) {
      erros[sqlstate] = (erros[sqlstate] ?? 0) + n;
    }
  }
  const concluidas = ok.reduce((soma, s) => soma + s.resultado.concluidas, 0);

  const invariante = await verificarInvariante(poolDeApoio, saldoInicial);
  await fecharPool(poolDeApoio);

  return {
    caso: NOME,
    threads,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros,
    porThread: ok.map((s) => s.resultado.concluidas),
    extra: {
      workers: threads,
      saquesEfetivados: Math.round((saldoInicial - invariante.observado) / opts.valorSaque),
      saquesRegistrados: concluidas,
    },
  };
}
