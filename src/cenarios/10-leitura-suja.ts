/**
 * CENÁRIO 10 - o relatório que le o meio da transferência   (Bloco B)
 *
 * Workers transferem dinheiro entre pares de contas SEM transação, enquanto a
 * thread principal roda `SELECT SUM(saldo) FROM contas` em laço, como faria um
 * dashboard.
 *
 * Cada worker tem o próprio par de contas, então não há disputa por linha e no
 * fim NADA se perde: a divergência fecha em zero. Mesmo assim, a série temporal
 * do total observado balança, porque entre o débito de uma conta e o crédito da
 * outra existe um instante em que o dinheiro não está em lugar nenhum.
 *
 * A lição é que um número pode estar errado sem que nenhum dado esteja errado.
 * O erro está em ter lido no meio de uma operação que ainda não acabou.
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

/** Quanto tempo o dinheiro fica "no ar" entre o débito e o crédito. */
export const PAUSA_MS = 15;
export const VALOR_TRANSFERENCIA = 100;

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();

  const poolDeApoio = criarPool(4, cfg);
  await verificarConexao(poolDeApoio);
  await resetar(poolDeApoio, cfg);
  const saldoInicial = await somaSaldos(poolDeApoio);

  // cada worker recebe um par exclusivo de contas: sem disputa por linha,
  // nenhum lost update pode acontecer, e a única anomalia sobra a leitura
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

  // observador: le o total em laço, do começo ao fim
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
  titulo('CENÁRIO 10 - a leitura suja');
  console.log('  Transferências sem transação, e um SELECT SUM(saldo) em laço olhando.');

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

  secao('primeiras 30 amostras da série');
  for (const a of (r.serie ?? []).slice(0, 30)) {
    const desvio = a.valor - r.invariante.esperado;
    const marca = desvio === 0 ? '' : `   <-- ${desvio}`;
    console.log(`  t=${String(a.t).padStart(8)} ms   total=${a.valor.toFixed(2)}${marca}`);
  }

  imprimirResumo(r, [
    'Divergência final zero: nenhum centavo se perdeu de verdade.',
    'E mesmo assim o relatório mostrou totais que nunca foram verdade.',
    'Consistência não é só sobre o dado final, é sobre quando você olha.',
  ]);
}
