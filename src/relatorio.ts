/**
 * Formatação da saída de terminal do benchmark e do gerador de gráficos.
 *
 * Os casos de uso não imprimem nada por conta própria: o produto deste projeto
 * são os arquivos em `resultados/`. O que sai no terminal é só o andamento da
 * medição, para dar para acompanhar uma rodada que leva minutos.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** true quando o arquivo foi chamado direto, e não importado. */
export function ehPrincipal(urlDoModulo: string): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  return resolve(argv) === resolve(fileURLToPath(urlDoModulo));
}

const LARGURA = 72;

export function titulo(texto: string): void {
  console.log('\n' + '='.repeat(LARGURA));
  console.log(' ' + texto);
  console.log('='.repeat(LARGURA));
}

export function secao(texto: string): void {
  console.log('\n' + '-'.repeat(LARGURA));
  console.log(' ' + texto);
  console.log('-'.repeat(LARGURA));
}

export function media(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Desvio padrão populacional. Vai para o resumo, porque perda não é determinística. */
export function desvio(v: number[]): number {
  if (v.length === 0) return 0;
  const m = media(v);
  return Math.sqrt(media(v.map((x) => (x - m) ** 2)));
}
