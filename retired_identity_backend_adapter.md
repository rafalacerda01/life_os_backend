# D2-C-02-R13 — adapter backend de teste e correção P3

## Escopo, arquivos e versões

COMPROVADO localmente: backend main no HEAD
8516468d7313a4f4da9a46df7228fa5d11134d39; root na branch
security-audit-before-circles-fix, HEAD d9bd305d0d717770d2f3ec767b2f89b1604157f9.
Dependências instaladas: firebase-admin 14.2.0, @google-cloud/firestore 8.7.1 e
google-auth-library 10.9.1. Nenhum manifesto de dependência foi alterado.

Arquivos backend: test/retired-identity-conformance.test.cjs (P3),
tools/retired_identity_firestore_test_adapter.cjs (novo suporte isolado de teste),
test/retired-identity-firestore-adapter.test.cjs (novos testes) e este relatório.
No root: apenas o runner P3 e functions/retired_identity_conformance.md.
Nenhum endpoint, cleaner, modelo, adapter Functions, Flutter, Rule ou configuração
foi alterado. O helper em tools não é importado por endpoints nem cria uma rota.

## Causa e correção P3

COMPROVADO: JSON.stringify sem indentação compactava o manifesto, causando
RELEASE_HASH_MISMATCH mesmo quando canonical.commit era mantido. A reprodução
sem mutação mostrou hash aprovado fe095417e3406a5949937e1775df18924363cd91e8af9dafb4d87fce8118b310
e hash compactado 0b707e93dc4ddbf228132d66baaad76ea94b71d365d9e11a608a125cc4774dee.
O negativo anterior não isolava a procedência como causa.

Agora um controle substitui o token do commit por ele mesmo e exige texto
exatamente igual e validação bem-sucedida. O negativo substitui somente o SHA
entre aspas, com ocorrência única. Restaurá-lo reproduz o texto original;
comparação estrutural confirma alteração exclusiva de canonical.commit.
Somente então se exige RELEASE_HASH_MISMATCH. Mesma alteração nos dois runners,
cuja única diferença continua sendo RUNTIME. Não houve alteração dos hashes,
manifestos, fonte canônica, referência ou 54 vetores aprovados.

## Interface e fronteiras

classifyLoadedRetiredIdentitySnapshots(input), síncrona, recebe exatamente scope,
reservation, guard, auth, expectedDeletionId, expectedOrigin e now. scope contém
projectId, databaseId e uid. Os envelopes de leitura são {snapshot: SDKSnapshot}
ou {readError: true}. Não consulta o Firestore nem observa Auth.

classifyRetiredIdentityFromEmulator(input), assíncrona, recebe scope, emulatorHost
e os mesmos quatro campos de contexto. Constrói seu próprio cliente de teste;
não aceita referências, credenciais, callbacks ou flags de autorização externos.

Ambas retornam {classification, normalization, acquisition}, congelado e
sanitizado. Frames, payloads, UID, projeto, host e deletionId não são publicados.
classification mantém destructiveAuthority=false, admissionAuthority=false,
provenance=UNPROVEN e terminalProof=NOT_PERFORMED, inclusive em falhas.

COMPROVADO: a implementação de normalização/aquisição mantém o mesmo corpo do
R11. Timestamps SDK são extraídos por seconds/nanoseconds sem toMillis, toDate,
arredondamento, relógio implícito ou metadata Auth. NULL, MISSING, UNSUPPORTED,
INVALID e SDK_TIMESTAMP continuam distintos. Accessors/converters inesperados
são recusados. Ausência exige snapshot SDK confirmado, com readTime suportado;
erro, timeout, snapshot parcial ou schema inválido nunca autoriza ausência.

## Classificador, integridade e diferença para R11

| Fronteira | R11 Functions | R13 backend |
|---|---|---|
| Classificador | Import local do canônico | Referência R12 somente de teste |
| Verificação | Regressões/canônico R12 | Manifesto aprovado, versão, hashes de source/vetores antes da compilação |
| Dependência do outro checkout | Nenhuma | Nenhuma |
| SDK de teste | Firestore 8.7.1 | Firestore 8.7.1 instalado no backend |
| Normalização e aquisição | Contrato R11 | Mesmo comportamento; sem algoritmo novo de identidade |

O carregador lê apenas os três artefatos R12 locais em test, valida o hash de
release fixado e os hashes aprovados de referência e vetores, verifica a versão
do wrapper e só então compila a referência, proibindo imports nessa referência.
Erro gera TEST_REFERENCE_INTEGRITY_INVALID, sem payload, causa ou identificadores.
Não importa ../functions, não transforma o runner de testes em biblioteca pública
e não distribui atualizações automaticamente. A verificação ocorre ao carregar o
módulo; a função aprovada fica capturada. Os testes de adulteração usam mocks em
memória, sem modificar artefatos aprovados no disco.

## Isolamento e consistência

COMPROVADO em fixtures/mocks: projeto explícito demo-*, banco (default), UID
canônico e host 127.0.0.1:porta válidos antes de construir referências. Host deve
coincidir com FIRESTORE_EMULATOR_HOST; configurações de projeto devem ser
compatíveis. Recusa credenciais reais, proxies HTTP/gRPC e tracing configurados,
sem imprimir seus valores. O cliente usa autenticação sintética do Emulator,
host explícito e ssl=false, sem ADC, login ou fallback Google Cloud.

Aquisição: uma chamada runTransaction com {readOnly: true}, um tx.getAll para
retired_auth_identities/{uid} e account_deletion_guards/{uid}. Confere dois
resultados, referências do cliente/UID/projeto/banco/coleção esperados e readTime
igual em segundos e nanossegundos. Revalida configuração antes/durante/depois,
captura contexto antes do await e termina o cliente em finally. Não faz writes.

O pipeline real do SDK, com RPC simulado, enviou newTransaction.readOnly e os dois
caminhos corretos, sem commit. O SDK instalado documenta snapshot consistente
possivelmente até 60 segundos no passado e ausência de retry do callback read-only.
Isso não prova atualidade, terminalidade, continuidade de UID ou atomicidade com
Auth. Snapshots previamente carregados retornam LOADED_ONLY; esse modo não
afirma aquisição consistente, mesmo quando seus contextos são compatíveis.

PENDENTE: validar o servidor/transportes, concorrência real e deadlines efetivos
no Firestore Emulator. Nenhum Emulator foi iniciado ou acessado nesta rodada;
o bloqueio anterior de socket não foi reavaliado nem contornado. Não substituir
essa evidência por Firebase real. Não declarar R13 validada contra Emulator.

## Testes e matriz

COMPROVADO, Node v24.17.0:

| Escopo | Resultado |
|---|---|
| P3 controle/negativo | 2/2 em cada repositório |
| R12 Functions/backend | 74/74 e 73/73 |
| Novo adapter backend | 143/143 |
| Focais Functions R2/R8/R10/FIX1/R11/R12 | 329/329 |
| Functions completa | 769 descobertos, 768 aprovados, zero falhas, 1 skip R3 |
| Backend exclusão/Auth/Billing/Círculos + R12/R13 | 696/696 |
| Backend completa | 1803/1803, zero falhas/skips |

Os 143 testes incluem 85 cenários SDK/segurança, os 54 resultados completos R12 e
quatro recusas de adulteração/versão dos artefatos. Fixtures usam objetos SDK com
protobufs sintéticos; testes de aquisição usam mocks e um pipeline SDK com RPC
simulado. Nenhum socket ou descoberta ADC ocorreu nos testes novos.

O codec dos 54 vetores usa somente tempos explicitamente presentes no teste.
Metadados ausentes continuam ausentes; frames contraditórios continuam inválidos.
Timestamps não normalizados em metadata são objetos estrangeiros; em campos de
documentos são mapas Firestore de teste, sem promoção a Timestamp válido. O codec
é suporte de fixtures, não aquisição de produção nem outro algoritmo de identidade.
Todas as classificações completas coincidiram com os goldens R12 imutáveis.

Cobertos: V1, três origens V2, IN_PROGRESS/COMPLETE, retenção nula/expirada/válida,
ausência confirmada, negação/deadline/falha, resposta parcial, referências e
configurações divergentes, limites de um nanossegundo, mudança de guard entre
operações, contexto alterado durante await, ausência de writes/Auth/imports externos,
sanitização e imutabilidade. Provas do SDK/Emulator não são fabricadas pelas fixtures.

Node 22 permanece PENDENTE: as instalações no PATH são v24.17.0 e v24.19.0.
Nenhum runtime ou dependência instalado. Sintaxe, whitespace, hashes e Git são
registrados também na entrega final; git status indisponível no sandbox.

## Custos, limites e gates

A normalização custa zero operações Firestore. O carregamento do helper faz três
leituras locais de arquivos aprovados. B solicita dois documentos por chamada
explícita, sem polling, queries globais ou retry próprio. Timeout RPC configurado
em 5 segundos não representa prova de deadline total. Nenhum custo Google Cloud,
serviço permanente, cache persistente, banco ou recurso novo.

INFERIDO: o adapter poderá apoiar uma futura leitura compatível, após revisão;
não fornece autorização administrativa nem segurança de geração Auth por si só.
PENDENTES antes de qualquer integração: Emulator real, Node 22, revisão coordenada
de versões nos dois repositórios, IAM/custódia de credenciais, política comprovada
de não reutilização de UID, procedência confiável e provas terminais independentes.
PRESENT/ABSENT não identifica geração e Auth ausente não prova exclusão integral.

D2-A-R2/ACTIVE, Billing, Círculos, contas legadas e confirmação Flutter D2-B não
foram substituídos ou alterados. Nenhuma reabertura de COMPLETE, reserva, conversão
V1/V2, writer V2 ou recuperação pós-Auth foi integrada. R14 não iniciada.

COMPROVADO: 37 arquivos protegidos coincidem com seus HEADs, incluindo manifesto,
vetores, referência R12, R10/FIX1, R11, modelos, harness, cleaners e configurações
inspecionadas. Staging vazio nos dois repositórios. Root ahead 13 e backend ahead 7.
Gitlink HEAD/index intacto: d2af978f3aa99eae2d21e50a89d411894c449b37.
git status e git diff --check não funcionaram no sandbox (saída 128); estado
completo das working trees não foi reconfirmado. Não houve elevação nem mudança
de configuração. Sintaxe/JSON e whitespace dos arquivos autorizados e aplicação
dos patches em cópias temporárias são verificados na entrega.
