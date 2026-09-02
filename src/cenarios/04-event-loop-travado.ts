/**
 * CENÁRIO 04 - o event loop travado   (Bloco A)
 *
 * Um setInterval bate um heartbeat a cada 100 ms. Enquanto isso, um handler
 * `async` roda um laço apertado de sha256.
 *
 * A palavra `async` não cria thread nenhuma e não devolve o controle para o
 * loop: ela só promete que a função PODE ceder num `await`. Como o laço de hash
 * não tem await nenhum, o event loop fica parado até o último hash sair, e o
 * heartbeat simplesmente para de bater.
 *
 * Isto é o que um servidor HTTP faz quando alguém coloca processamento pesado
 * numa rota: não é um pedido lento, são TODOS os pedidos parados.
 */
import { performance } from 'node:perf_hooks';
import { lerConfig, montarInvariante } from '../db.js';
import { trabalhoDeHash } from '../hash.js';
import { esperar, INTERVALO_HEARTBEAT_MS, ligarHeartbeat } from '../heartbeat.js';
import { ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '04-event-loop-travado';

export const RODADAS_PADRAO = 700_000_000;

/** O `async` aqui é decorativo: não há um único await dentro do laço. */
async function handlerPesado(rodadas: number): Promise<number> {
  // BUG INTENCIONAL: laço CPU-bound dentro de handler async. Nada cede o
  // controle ao event loop até a última rodada terminar.
  return trabalhoDeHash(rodadas);
}

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const silencioso = opts.silencioso === true;
  const rodadas = opts.operacoes;
  const heartbeat = ligarHeartbeat(silencioso);

  // meio segundo de batidas saudáveis, para o contraste ficar visível
  await esperar(500);
  if (!silencioso) console.log(`\n  --- começou o hash (${rodadas.toLocaleString('pt-BR')} rodadas) ---\n`);

  const inicio = performance.now();
  await handlerPesado(rodadas);
  const ms = performance.now() - inicio;

  if (!silencioso) console.log('\n  --- hash terminou, o loop voltou a respirar ---\n');
  await esperar(400);

  const b = heartbeat.parar();
  const batidasEsperadas = Math.floor((500 + ms + 400) / INTERVALO_HEARTBEAT_MS);

  return {
    cenario: NOME,
    concorrencia: 1,
    operacoes: rodadas,
    concluidas: rodadas,
    ms,
    throughput: (rodadas / ms) * 1000,
    // nenhum dinheiro se move aqui: o problema deste cenário é latência
    invariante: montarInvariante(0, 0, 0),
    erros: {},
    porTrabalhador: [rodadas],
    maiorLacunaEventLoopMs: b.maiorLacuna,
    extra: {
      batidasObservadas: b.batidas,
      batidasEsperadas,
      batidasPerdidas: Math.max(0, batidasEsperadas - b.batidas),
      hashesPorSegundo: Math.round((rodadas / ms) * 1000),
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENÁRIO 04 - o event loop travado');
  console.log(`  heartbeat a cada ${INTERVALO_HEARTBEAT_MS} ms, e um handler async com`);
  console.log(`  ${RODADAS_PADRAO.toLocaleString('pt-BR')} rodadas de sha256 no meio.`);
  secao('batidas do heartbeat');

  const r = await executar({
    operacoes: RODADAS_PADRAO,
    concorrencia: 1,
    valorSaque: cfg.valorSaque,
  });

  imprimirResumo(r, [
    `O loop ficou ${r.maiorLacunaEventLoopMs?.toFixed(0)} ms sem rodar nada.`,
    `Deveriam ter saído ~${r.extra?.batidasEsperadas} batidas, saíram ${r.extra?.batidasObservadas}.`,
    'Uma única requisição pesada congelou o processo inteiro. O cenário 07 conserta isto com workers.',
  ]);
}
