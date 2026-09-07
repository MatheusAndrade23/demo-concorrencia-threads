# Concorrência com worker_threads: o que muda com o número de threads

Projeto didático em TypeScript + Node.js + PostgreSQL. Seis casos de uso rodam
sob uma varredura de números de threads, dez repetições cada, e o resultado sai
em gráficos comparativos: **quanto dinheiro se perde** e **quanto tempo se leva**,
por caso e por número de threads.

O objetivo é **demonstrar problemas, não resolvê-los**. Os bugs são o produto.
Cada trecho problemático está marcado no código com
`// BUG INTENCIONAL: <explicação>`, e não existe mutex, `Atomics.add`,
`SELECT ... FOR UPDATE`, `UPDATE saldo = saldo - x`, isolamento `SERIALIZABLE`
nem retry em lugar nenhum. A única exceção é o caso 01, que é o baseline correto
e serve de régua para os outros.

O produto do projeto são os arquivos em `resultados/`. Nenhum caso imprime
demonstração no terminal: o que aparece na tela é o andamento da medição.

**As duas perguntas que os gráficos respondem:**

1. quanto se perde à medida que se adiciona thread, e o que acontece quando o
   número de threads passa do número de threads de hardware da máquina;
2. quanto tempo cada caso leva, e quais deles de fato ficam mais rápidos com mais
   thread.

---

## Como rodar

Precisa de Node 20+ e Docker.

```bash
cp .env.example .env
npm install
npm run db:up
```

A medição inteira, e depois os gráficos:

```bash
npm run bench -- --repetitions 10 2>/dev/null
```

```bash
npm run charts
```

Leva cerca de dois minutos numa máquina de 10 threads. Abra
`resultados/relatorio.html` no navegador: é a página com todos os gráficos, o
resumo numérico e a descrição da máquina que produziu os números.

Para derrubar o banco no fim: `npm run db:down`.

### Por que o `2>/dev/null`

O caso 06 escreve em `stderr` **de propósito**: o custo dessa escrita é o
experimento dele. Sem o redirecionamento, duzentas mil linhas de depuração por
repetição afogam o terminal. O redirecionamento não barateia a escrita, só tira
ela da tela, então a medição continua válida.

### Em macOS, use `caffeinate -i`

`performance.now()` conta o tempo em que a máquina esteve suspensa, então um
notebook que dorme no meio da execução produz repetições que não medem nada:

```bash
caffeinate -i npm run bench -- --repetitions 10 2>/dev/null
```

### Opções da medição

| Opção | Padrão | O que faz |
|---|---|---|
| `--cases` | `all` | lista por vírgula, aceita prefixo: `--cases 03,04` |
| `--threads` | derivado da máquina | ex: `1,2,4,8,16` |
| `--repetitions` | `10` | uma linha no CSV por repetição, nunca só a média |
| `--operations` | por caso | carga total por repetição; casos de CPU e de memória ignoram, porque a escala deles é outra |
| `--no-warmup` | desligado | não descarta a primeira execução de cada série |
| `--output` | `resultados` | diretório de saída |

---

## A varredura de threads, e a régua da máquina

O eixo x de quase todo gráfico é o número de threads de trabalho. Uma curva de
threads sem saber quantas threads a máquina tem não quer dizer nada: o ponto em
que a curva para de melhorar é o limite de paralelismo do hardware, e ele muda de
máquina para máquina.

Por isso a varredura é **derivada da máquina** por
`os.availableParallelism()`, em [src/ambiente.ts](src/ambiente.ts): potências de
dois até o dobro do que a máquina tem, mais o próprio número e o dobro dele. Numa
máquina de 10 threads sai `1, 2, 4, 8, 10, 16, 20`. São pontos antes do limite, o
limite exato, e dois pontos depois dele.

O mesmo módulo grava `resultados/ambiente.json` com CPU, número de threads de
hardware, memória, versão do Node e horário da medição. Os gráficos leem esse
arquivo e desenham uma **régua vermelha vertical** no número de threads da
máquina. Passado ela, mais worker não é mais núcleo: é revezamento.

Os números citados neste README foram medidos num **Apple M4 de 10 threads**, com
Postgres 17 em container local. Rode na sua máquina antes de citar qualquer um
deles: bug de corrida não é determinístico, e o limite de hardware é outro.

---

## Os seis casos

Todos dividem uma carga **total fixa** entre as threads. Não é detalhe: se cada
thread recebesse uma carga fixa, o trabalho total cresceria junto com o número de
threads e nem a curva de tempo nem a de perda diriam nada sobre paralelismo.

| # | Caso | Estado compartilhado | Perde dinheiro? |
|---|---|---|---|
| 01 | [baseline sequencial](src/casos/01-baseline-sequencial.ts) | nenhum (thread única) | não, por construção |
| 02 | [CPU entre threads](src/casos/02-worker-cpu.ts) | nenhum | não |
| 03 | [corrida em SharedArrayBuffer](src/casos/03-worker-sab-corrida.ts) | um `Int32Array` | muito |
| 04 | [corrida no banco](src/casos/04-worker-banco.ts) | uma linha do Postgres | muito |
| 05 | [leitura suja](src/casos/05-worker-leitura-suja.ts) | nenhum (par de contas por thread) | não, mas o relatório mente |
| 06 | [heisenbug](src/casos/06-worker-heisenbug.ts) | um `Int32Array` | depende do observador |

### 01 — baseline sequencial

Um saque por vez, em laço, na thread principal: `SELECT`, cálculo em JS,
`UPDATE`. Nenhum worker sobe aqui. Roda só com uma thread, e ignora a varredura:
a ideia de "mais threads" não se aplica a um laço que espera cada operação
terminar antes de começar a próxima.

Existe por dois motivos. Prova que a lógica do saque está certa, porque a
divergência fecha em zero e cada `SELECT` já enxerga o `UPDATE` anterior. E dá o
ponto de referência de tempo: **98 ms** para 200 saques, a linha tracejada azul do
gráfico de tempo, contra a qual o caso 04 deve ser lido.

### 02 — trabalho de CPU dividido entre threads

O caso em que thread entrega exatamente o que promete. Um laço de mistura de
inteiros, puro CPU, dividido em partes iguais entre N workers. Nenhum estado
compartilhado, nenhum banco: cada thread recebe um pedaço, calcula sozinha e
devolve um número.

O tempo cai de **1060 ms com uma thread para 223 ms com dez**, um ganho de 4,8x,
e a partir daí **piora**: 263 ms com 16 threads, 298 ms com 20. O fundo da curva
cai exatamente sobre a régua da máquina. Perda de dinheiro: zero, em qualquer
número de threads, e esse zero é o resultado, não a ausência dele. Separar o
trabalho é o que torna paralelismo seguro.

O trabalho é aritmética de inteiros pura, sem alocar um byte
([src/hash.ts](src/hash.ts)). Com `crypto.createHash`, as threads disputariam o
alocador do OpenSSL e a curva ficaria achatada por um motivo que não tem nada a
ver com paralelismo.

### 03 — lost update em memória compartilhada

N workers, cada um numa thread do sistema operacional, incrementando o **mesmo**
`Int32Array` sobre um `SharedArrayBuffer`, sem `Atomics`.

`contador[0] = contador[0] + 1` são três operações de máquina: carrega da
memória, soma, escreve de volta. Dois núcleos que carregam o mesmo valor ao mesmo
tempo escrevem o mesmo resultado, e um dos dois incrementos evapora.

É a curva de perda mais limpa do projeto: **zero com uma thread, 48% com duas,
73% com quatro**, e daí para cima entre 45% e 64%. Uma thread não perde nada
porque não há com quem disputar; a partir de duas, a perda é imediata.

### 04 — lost update no banco

O mesmo saque do caso 01, agora executado por N workers ao mesmo tempo na mesma
conta, cada um com o próprio `Pool`. A janela perigosa é entre o `SELECT` e o
`UPDATE`: nesse intervalo outra thread já leu o mesmo saldo velho, e a segunda
gravação apaga a primeira.

**Zero perdido com uma thread, 38% com duas, 67% com dez.** O razão registra os
200 saques, a conta debita uma fração deles, e a diferença é o dinheiro que soma
nenhuma auditoria explica.

A curva de tempo é o contraponto do caso 02: melhora de 164 ms para 133 ms com
duas threads e depois só piora, chegando a 442 ms com 20. Não é trabalho de CPU,
é disputa pela mesma linha, e disputa não paraleliza.

### 05 — o relatório que lê o meio da transferência

N workers transferem dinheiro entre pares de contas **sem transação**, enquanto a
thread principal roda `SELECT SUM(saldo)` em laço, como faria um dashboard.

Cada thread recebe o próprio par de contas, então não há disputa por linha e no
fim **nada se perde**: a divergência fecha em zero em qualquer número de threads.
Mesmo assim o total lido balança, porque entre o débito de uma conta e o crédito
da outra existe um instante em que o dinheiro não está em lugar nenhum.

O buraco cresce com o número de threads, e cresce de forma quase exata: cada
transferência no ar esconde 100 unidades, então o menor total observado cai 100
com uma thread, 400 com quatro, 900 com dez e 1500 com vinte. O gráfico da série
mostra isso como degraus cada vez mais fundos e mais frequentes.

Um número pode estar errado sem que nenhum dado esteja errado. O erro está em ter
lido no meio de uma operação que ainda não acabou.

O seed deste caso é dimensionado pelo **maior** número de threads da varredura, e
não pelo da execução: assim todos os pontos medem o mesmo sistema, com o mesmo
total de dinheiro, e as séries temporais podem ser postas no mesmo gráfico.

### 06 — o heisenbug

O caso 03 inteiro, com uma única diferença: uma flag que insere um `console.error`
dentro da seção crítica, entre ler e escrever o `Int32Array`. O benchmark roda os
dois lados da varredura inteira, e eles entram nos gráficos como casos distintos.

Reaproveitar o `executar` do caso 03 não é economia de código: é a garantia de
que a única variável entre as duas curvas é a linha de log.

Abaixo do limite da máquina o log **esconde** o bug: com duas threads a perda cai
de 29% para 2,4%, com quatro cai de 17% para 9,2%. A partir de oito threads a
comparação se inverte e as duas curvas passam a se cruzar, dentro de um desvio
padrão que é da ordem da própria diferença.

O log não corrige nada, só muda o tempo. E como a corrida depende de duas threads
caírem na mesma janela, mudar o tempo muda a frequência com que ela acontece: a
janela entre ler e escrever uma posição de memória é de nanossegundos, e uma
escrita em `stderr` custa microssegundos.

A conclusão não é "log esconde bug". É que o efeito de um print depende do
tamanho dele perto da janela da corrida e do que mais está disputando a CPU. Como
ninguém sabe de cabeça nenhuma dessas duas coisas, um print nunca é prova de
nada.

---

## O que é gerado em `resultados/`

| Arquivo | Conteúdo |
|---|---|
| `relatorio.html` | **a página de entrega**: todos os gráficos, a máquina e o resumo numérico |
| `perdido-x-threads-por-caso.svg` | dinheiro perdido por número de threads, um painel por caso, com cada repetição visível |
| `perdido-x-threads-comparado.svg` | a mesma perda como percentual do movimentado, todos os casos no mesmo eixo |
| `tempo-x-threads-comparado.svg` | tempo por número de threads, todos os casos, escala log |
| `tempo-x-threads-por-caso.svg` | o mesmo tempo, um painel por caso, com a dispersão entre repetições |
| `ganho-x-threads.svg` | tempo com 1 thread / tempo com N threads, contra o ganho ideal |
| `serie-leitura-suja.svg` | desvio do total lido durante as transferências do caso 05 |
| `ambiente.json` | CPU, threads de hardware, memória, Node, horário |
| `resultados.csv` | uma linha por repetição |
| `resumo.csv` | média e desvio padrão por caso e número de threads |
| `distribuicao.csv` | operações concluídas por thread |

`distribuicao.csv` não vira gráfico: a carga é dividida em partes iguais e toda
thread conclui a sua, em todos os casos, então as barras sairiam idênticas. O
arquivo continua sendo gravado como evidência dessa premissa, que é o que
sustenta toda comparação de tempo.

### Por que dois gráficos de perda

Os casos perdem em unidades incomparáveis: o caso 03 perde milhões de
incrementos, o caso 04 perde algumas centenas de unidades de saldo. O gráfico por
caso usa valor absoluto com escala de y própria por painel; o comparado usa
`perdido / total movimentado`, que é a única forma honesta de pôr os dois no
mesmo eixo.

---

## O schema e a invariante

```sql
contas(id SERIAL PK, titular TEXT, saldo NUMERIC(12,2) NOT NULL)
movimentos(id BIGSERIAL PK, conta_id INT, valor NUMERIC(12,2),
           origem TEXT, criado_em TIMESTAMPTZ DEFAULT now())
```

Não existe `CHECK (saldo >= 0)` de propósito. A constraint transformaria parte do
lost update em erro visível e esconderia justamente o dinheiro que some.

**A invariante é ancorada no razão**, não no total inicial:

```
esperado    = saldo_inicial + SUM(movimentos.valor)
divergência = observado - esperado
```

Um saque diminui a soma dos saldos de propósito, então comparar o total final com
o total inicial cru acusaria perda onde não houve. A tabela `movimentos` registra
tudo o que o banco de fato movimentou, e a pergunta passa a ser: *o saldo das
contas bate com o que o razão diz que aconteceu?*

A fórmula serve para os três formatos de caso. Num saque, cada operação grava um
movimento negativo e o esperado cai junto. Numa transferência, grava um negativo e
um positivo, que se anulam. No contador em memória dos casos 03 e 06, os
"movimentos" são os incrementos que as threads dizem ter feito e o "observado" é o
valor final do `Int32Array`.

O sinal da divergência tem significado:

- **positivo**: o banco pagou e não debitou. É o clássico do lost update em saque.
- **negativo**: dinheiro sumiu das contas.

### A pegadinha do `NUMERIC`

O driver `pg` devolve `NUMERIC` como **string**, não como número. Ele faz isso de
propósito: `NUMERIC(12,2)` do Postgres tem precisão maior que o `double` do JS, e
converter sozinho perderia informação. O efeito prático é que `"500" - 1` dá `499`
por coerção, mas `"500" + 1` dá `"5001"`. Toda leitura de saldo neste projeto
passa por `paraNumero()` em [src/db.ts](src/db.ts).

---

## Regras da medição

- uma execução de warm-up é descartada antes de cada série;
- o estado do banco é recriado antes de **cada** repetição;
- grava uma linha por repetição, nunca só a média: a dispersão entre repetições é
  metade do que este projeto mostra, e por isso ela aparece como pontos nos
  gráficos por caso;
- nenhum caso aborta o benchmark: uma repetição que estoura vira uma linha com
  `falhou=sim` e o erro na coluna ao lado;
- a série temporal só é gravada da primeira repetição, senão o CSV cresce sem
  acrescentar nada ao gráfico.

---

## Estrutura

```
docker-compose.yml
package.json
tsconfig.json                       strict ligado
.env.example
README.md
src/ambiente.ts                     a máquina e a varredura de threads
src/db.ts                           pool, seed, invariante, classificação de erro
src/tipos.ts                        ResultadoCaso, Invariante, OpcoesCaso
src/relatorio.ts                    saída de terminal do benchmark
src/hash.ts                         o trabalho de CPU do caso 02
src/casos/01..06
src/workers/protocolo.ts            workerData na entrada, postMessage na saída
src/workers/cpu-worker.ts
src/workers/sab-worker.ts
src/workers/banco-worker.ts
src/workers/transferencia-worker.ts
src/benchmark.ts                    a medição
src/charts.ts                       os gráficos e o relatório HTML
resultados/                         CSV, SVG e relatorio.html gerados
```

### Como os workers recebem parâmetros e devolvem resultado

Entrada por `workerData`, saída por `parentPort.postMessage`. O pai também espera
o evento `exit`, então uma thread que morre antes de responder vira um resultado
`{ ok: false }` em vez de derrubar o benchmark: a promise nunca rejeita.

```ts
interface EntradaWorker<P> {
  id: number;                 // índice, usado na distribuição por thread
  config: Config;             // o worker abre o PRÓPRIO Pool a partir daqui
  params: P;
  sab?: SharedArrayBuffer;    // só nos casos 03 e 06
}

type SaidaWorker<R> =
  | { ok: true;  id: number; resultado: R }
  | { ok: false; id: number; erro: { sqlstate: string; mensagem: string } };
```

### Tratamento de erro

Todo erro de banco é capturado e classificado por `SQLSTATE` pela classe
`ContadorDeErros`. Erros que não vêm do Postgres recebem um pseudo-código em
maiúsculas (`ECONNREFUSED`, `JS`, `WORKER_SEM_RESPOSTA`, `DESCONHECIDO`) para
caberem na mesma contagem.

## Configuração

Tudo por variável de ambiente, com `.env.example` versionado. O número de threads
**não** vem daqui: é derivado da máquina.

| Variável | Padrão | O que é |
|---|---|---|
| `PGHOST` / `PGPORT` | `localhost` / `5433` | conexão |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `demo` / `demo` / `banco` | conexão |
| `CONTAS` | `10` | quantas contas o seed cria (o caso 05 semeia mais quando precisa) |
| `SALDO_INICIAL` | `1000` | saldo de cada conta |
| `OPERACOES` | `200` | carga total por repetição, dividida entre as threads |
| `VALOR_SAQUE` | `1` | valor de cada saque |
