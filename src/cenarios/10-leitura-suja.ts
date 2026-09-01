/**
 * CENARIO 10 - o relatorio que le o meio da transferencia   (Bloco B)
 *
 * Workers transferem dinheiro entre pares de contas SEM transacao, enquanto a
 * thread principal roda `SELECT SUM(saldo) FROM contas` em laco, como faria um
 * dashboard.
 *
 * Cada worker tem o proprio par de contas, entao nao ha disputa por linha e no
 * fim NADA se perde: a divergencia fecha em zero. Mesmo assim, a serie temporal
 * do total observado balanca, porque entre o debito de uma conta e o credito da
 * outra existe um instante em que o dinheiro nao esta em lugar nenhum.
 *
 * A licao e que um numero pode estar errado sem que nenhum dado esteja errado.
 * O erro esta em ter lido no meio de uma operacao que ainda nao acabou.
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
import { ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { Amostra, OpcoesCenario, ResultadoCenario } from '../tipos.js';
import { rodarWorkers, separar } from '../workers/protocolo.js';
import type { EntradaWorker } from '../workers/protocolo.js';
import type { ParamsTransferencia, ResultadoTransferencia } from '../workers/transferencia-worker.js';

export const NOME = '10-leitura-suja';

/** Quanto tempo o dinheiro fica "no ar" entre o debito e o credito. */
export const PAUSA_MS = 15;
export const VALOR_TRANSFERENCIA = 100;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();

  const poolDeApoio = criarPool(4, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);

  // cada worker recebe um par exclusivo de contas: sem disputa por linha,
  // nenhum lost update pode acontecer, e a unica anomalia sobra a leitura
  const paresDisponiveis = Math.floor(cfg.contas / 2);
  const workers = Math.max(1, Math.min(opts.concorrencia, paresDisponiveis));
  const porWorker = Math.max(1, Math.floor(opts.operacoes / workers));

  const entradas: EntradaWorker<ParamsTransferencia>[] = Array.from(
    { length: workers },
    (_, id) => ({
      id,
      config: cfg,
      params: {
        de: id * 2 + 1,
        para: id * 2 + 2,
        valor: VALOR_TRANSFERENCIA,
        transferencias: porWorker,
        pausaMs: PAUSA_MS,
        origem: NOME,
      },
    }),
  );

  // observador: le o total em laco, do comeco ao fim
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
    cenario: NOME,
    concorrencia: workers,
    operacoes: porWorker * workers,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros,
    porTrabalhador: ok.map((s) => s.resultado.concluidas),
    serie,
    extra: {
      workers,
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

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENARIO 10 - a leitura suja');
  console.log('  Transferencias sem transacao, e um SELECT SUM(saldo) em laco olhando.');

  const r = await executar({
    operacoes: 60,
    concorrencia: cfg.concorrencia,
    valorSaque: cfg.valorSaque,
  });

  secao('o que o dashboard viu');
  console.log(`  amostras coletadas ....... ${r.extra?.amostras}`);
  console.log(`  amostras com total errado . ${r.extra?.amostrasSujas} (${r.extra?.percentualSujo}%)`);
  console.log(`  total real ............... ${r.invariante.esperado.toFixed(2)}`);
  console.log(`  menor total observado .... ${Number(r.extra?.totalMinimoObservado).toFixed(2)}`);
  console.log(`  maior total observado .... ${Number(r.extra?.totalMaximoObservado).toFixed(2)}`);
  console.log(`  maior buraco ............. ${r.extra?.maiorBuraco}`);

  secao('primeiras 30 amostras da serie');
  for (const a of (r.serie ?? []).slice(0, 30)) {
    const desvio = a.valor - r.invariante.esperado;
    const marca = desvio === 0 ? '' : `   <-- ${desvio}`;
    console.log(`  t=${String(a.t).padStart(8)} ms   total=${a.valor.toFixed(2)}${marca}`);
  }

  imprimirResumo(r, [
    'Divergencia final zero: nenhum centavo se perdeu de verdade.',
    'E mesmo assim o relatorio mostrou totais que nunca foram verdade.',
    'Consistencia nao e so sobre o dado final, e sobre quando voce olha.',
  ]);
}
