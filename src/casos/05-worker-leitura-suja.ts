/**
 * CASO 05 - o relatório que lê o meio da transferência
 *
 * N workers transferem dinheiro entre pares de contas SEM transação, enquanto a
 * thread principal roda `SELECT SUM(saldo) FROM contas` em laço, como faria um
 * dashboard.
 *
 * Cada thread recebe o próprio par de contas, então não há disputa por linha e
 * no fim NADA se perde: a divergência fecha em zero, em qualquer número de
 * threads. Mesmo assim a série temporal do total observado balança, porque entre
 * o débito de uma conta e o crédito da outra existe um instante em que o
 * dinheiro não está em lugar nenhum.
 *
 * É o caso que separa duas coisas que costumam ser confundidas: um número pode
 * estar errado sem que nenhum dado esteja errado. Quanto mais threads
 * transferindo, mais frequente é a chance de a leitura cair dentro de uma dessas
 * janelas, e é isso que o gráfico de série temporal mostra.
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
import type { Amostra, OpcoesCaso, ResultadoCaso } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsTransferencia, ResultadoTransferencia } from '../workers/transferencia-worker.js';

export const NOME = '05-worker-leitura-suja';

/** Quanto tempo o dinheiro fica "no ar" entre o débito e o crédito. */
export const PAUSA_MS = 15;
export const VALOR_TRANSFERENCIA = 100;

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const cfg = lerConfig();
  const threads = Math.max(1, opts.threads);

  // cada thread precisa de um par exclusivo de contas: sem disputa por linha,
  // nenhum lost update pode acontecer, e a única anomalia que sobra é a leitura.
  // O seed é dimensionado pelo MAIOR número de threads da varredura, não pelo
  // desta execução: assim todos os pontos medem o mesmo sistema, com o mesmo
  // total de dinheiro, e as séries temporais podem ser postas no mesmo gráfico.
  const contasNecessarias = Math.max(threads, opts.threadsMaximas ?? threads) * 2;
  const cfgDoCaso = { ...cfg, contas: Math.max(cfg.contas, contasNecessarias) };

  const poolDeApoio = criarPool(4, cfgDoCaso);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfgDoCaso);
  const saldoInicial = await somaSaldos(poolDeApoio);

  const porThread = Math.max(1, Math.floor(opts.operacoes / threads));

  const entradas: EntradaWorker<ParamsTransferencia>[] = Array.from(
    { length: threads },
    (_, id) => ({
      id,
      config: cfgDoCaso,
      params: {
        de: id * 2 + 1,
        para: id * 2 + 2,
        valor: VALOR_TRANSFERENCIA,
        transferencias: porThread,
        pausaMs: PAUSA_MS,
        origem: NOME,
      },
    }),
  );

  // observador: lê o total em laço, do começo ao fim
  const serie: Amostra[] = [];
  let observando = true;
  const inicio = performance.now();
  const observador = (async (): Promise<void> => {
    while (observando) {
      const total = await somaSaldos(poolDeApoio);
      serie.push({ t: Number((performance.now() - inicio).toFixed(2)), valor: total });
    }
  })();

  const saidas = await rodarWorkers<ParamsTransferencia, ResultadoTransferencia>(
    './transferencia-worker.js',
    entradas,
  );
  const ms = performance.now() - inicio;
  observando = false;
  await observador;

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

  const valores = serie.map((a) => a.valor);
  const sujas = valores.filter((v) => v !== saldoInicial);
  const minimo = valores.length > 0 ? Math.min(...valores) : saldoInicial;
  const maximo = valores.length > 0 ? Math.max(...valores) : saldoInicial;

  return {
    caso: NOME,
    threads,
    operacoes: porThread * threads,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros,
    porThread: ok.map((s) => s.resultado.concluidas),
    serie,
    extra: {
      workers: threads,
      contasSemeadas: cfgDoCaso.contas,
      amostras: serie.length,
      amostrasSujas: sujas.length,
      percentualSujo: Number(((sujas.length / Math.max(1, serie.length)) * 100).toFixed(1)),
      totalMinimoObservado: minimo,
      totalMaximoObservado: maximo,
      maiorBuraco: Number((saldoInicial - minimo).toFixed(2)),
      pausaMs: PAUSA_MS,
    },
  };
}
