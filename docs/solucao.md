# Correção dos repasses

O incidente reunia quatro falhas pequenas em regras diferentes: o prazo usava o dia escrito em UTC, o valor era dividido por 100 duas vezes, a chave de retry preservava espaços e U+200B, e o status `PENDING` caía no mesmo ramo que os estados pagos. As funções responsáveis foram corrigidas sem alterar as rotas, os formatos de resposta, o README do desafio ou os testes originais.

## Regras corrigidas

| Regra | Correção | Evidência |
| --- | --- | --- |
| Prazo civil | `Intl.DateTimeFormat` extrai o dia em `America/Sao_Paulo`; a comparação continua inclusiva no dia do prazo. | Último milissegundo, primeiro milissegundo seguinte, offset explícito e horário de verão histórico. |
| Data de entrada | A parte civil precisa ter ano YYYY de 0001 a 9999 e um dia existente no calendário gregoriano. O dia convertido em São Paulo também precisa caber nessa faixa. | Fevereiro 30, ano não bissexto, anos ISO expandidos e offset que cruza para o ano 10000 são rejeitados sem gravar efeitos. |
| Dinheiro | Centavos são divididos por 100 uma única vez. | 15000 → 150; 8000 → 80; valores de 1, 99 e 101 centavos. |
| Idempotência | Preserva a comparação sem distinção de caixa já existente, remove U+200B mostrado no log e espaços externos. Chaves vazias após a normalização são inválidas. | Caso `pay_7c1\u200b`, espaços finais, caixa e chave composta apenas de ruído. |
| Um pagamento por missão | A busca também verifica a missão; uma nova chave não permite novo crédito. Uma chave de outra missão retorna 409. | Retry com chave diferente, conflito entre missões e 20 requisições concorrentes. |
| Gravação completa | A verificação e a gravação de ledger, repasse e estado da missão ocorrem numa transação SQLite `BEGIN IMMEDIATE`. O log de crédito sai depois do commit. | Falha simulada ao inserir o repasse reverte todos os efeitos e permite retry. |
| Provedor | `PENDING` → `pending`; `RECEIVED`/`CONFIRMED` → `paid`; `FAILED` → `failed`. | Todos os estados e callbacks repetidos; status desconhecido mantém o estado anterior. |

A normalização remove o caractere invisível efetivamente observado no incidente; espaços internos permanecem significativos. A transação torna a decisão de idempotência e seus efeitos uma operação indivisível, sem migração do esquema ou dependência externa.

## Verificação reproduzível

Em Node 22:

```bash
npm ci
npm test
npm run typecheck
TZ=Asia/Tokyo npm test
npm start
```

Resultado local em Node v22.23.3: **46 testes passaram**, incluindo os **9 testes originais preservados** e 37 regressões; typecheck passou. A mesma suíte passou com o fuso do processo configurado para Tóquio, verificando que a regra depende do fuso de São Paulo.

- [Falhas originais: 4 de 9 testes](evidence/before-test.txt).
- [Suíte corrigida: 46 de 46 testes](evidence/after-test.txt).
- [Typecheck](evidence/typecheck.txt).
- [Suíte com TZ=Asia/Tokyo](evidence/timezone-test.txt).
- [Seis chamadas HTTP reais e suas respostas](evidence/http-live.json).
- [Auditoria das dependências de execução](evidence/runtime-audit.json).

O transcript HTTP foi obtido de um servidor local real, com SQLite e dados sintéticos do seed. Aprovar `msn_1842` em `2026-03-13T02:59:59.999Z` devolveu 201 e R$150; repetir a chave com U+200B e espaço devolveu 200, com o mesmo lançamento. O callback `PENDING` permaneceu pendente e `CONFIRMED` quitou; a consulta final mostrou um único crédito. Em `2026-03-13T03:00:00.000Z`, a aprovação devolveu 409.

A revisão independente apontou que `Date` normaliza dias inexistentes e aceita anos ISO expandidos. A validação agora recusa essas entradas com 400, antes de gravar efeitos, e formata anos menores que 1000 com quatro dígitos para preservar a comparação do prazo. Permanecem aceitas as representações ISO já usadas pela API, incluindo `Z`, offsets explícitos, segundos sem fração, frações longas e a forma ISO de data sem hora. A regra de calendário inclui a exceção dos séculos: 2000 foi bissexto; 1900 não foi.

## Limites

Esta correção protege novas chamadas. Ela não reconcilia retroativamente créditos duplicados ou valores históricos registrados antes da correção. Os estados recebidos do provedor são mapeados conforme o contrato; não há timestamp ou identificador de evento no contrato para ordenar callbacks históricos.

`npm audit --omit=dev` encontrou zero vulnerabilidades de execução. A versão do Vitest fornecida pelo desafio ainda tem três avisos de desenvolvimento (Vitest, `@vitest/mocker` e Tinypool); a remediação indicada exige troca de versão principal. As dependências foram preservadas para manter esta correção centrada no incidente.

## Uso de IA e revisão

Codex produziu código, testes e documentação. Dois agentes Codex independentes do implementador revisaram o commit `b0b8034bb393ac05dde45ad8d11f618da31ac725` e liberaram a entrega após testes e sondagens próprias. Os pareceres completos estão em `docs/reviews/`. O coordenador conferiu a instalação e os testes em checkout isolado e registrou o fluxo HTTP real. Não foi realizada revisão humana do código. A validação usa dados sintéticos e ambiente local; limites e interpretações do contrato estão documentados.

[Verificação final, pareceres e gravação do fluxo](verificacao-final.md).
