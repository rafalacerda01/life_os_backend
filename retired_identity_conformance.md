# D2-C-02-R12 — conformidade local V1/V2, versão 1

## Escopo e referência

COMPROVADA: a referência canônica continua sendo
`functions/retired_identity_contract_v2.js`, contrato R10-FIX1, no root
`afe2e73d5ffe03823682155eb7c35c01e8ac1884`. O backend permanece no HEAD
`593b826cedffe8039f6f78e74a61f548a2c58d02`. Esta rodada cria somente testes,
fixtures JSON e esta documentação. R2/R8/R10/FIX1/R11 e os cleaners não mudam.
Não há terceiro modelo, dependência nova, writer, endpoint ou leitor de produção.

| Artefato novo | Functions | Backend independente |
|---|---|---|
| Runner de testes | test/retired-identity-conformance.test.cjs | mesmo caminho |
| Vetores e resultados completos | test/retired-identity-conformance.vectors.json | mesmo caminho, bytes iguais |
| Manifesto de versão/hashes | test/retired-identity-conformance.manifest.json | mesmo caminho, bytes iguais |
| Referência pura extraída | calculada em memória do canônico | test/retired-identity-conformance.reference.json |
| Relatório | retired_identity_conformance.md | mesmo caminho |

O runner backend compila somente a fixture local validada por hash e bloqueia
qualquer require dessa referência. Não abre nem importa arquivos do repositório
Functions. O modo FUNCTIONS do runner usa somente o canônico dentro de seu próprio
repositório; o modo BACKEND é fixado no arquivo backend. Não há descoberta do outro
checkout, pacote compartilhado, publicação automática ou mecanismo de atualização.

## Versão e detecção de divergência

COMPROVADA: `formatVersion: 1` versiona o protocolo de testes; não cria uma versão
nova da identidade. `contractVersion: R10-FIX1` identifica o comportamento aprovado.
O manifesto fixa fonte canônica, commit, hash integral, hash da extração pura, hash
dos vetores, os 12 campos de saída e os quatro campos de segurança. O próprio
manifesto tem SHA-256 fixado literalmente nos dois runners. Hashes usam UTF-8/LF.

| Conteúdo | SHA-256 |
|---|---|
| Arquivo canônico completo | 2fe8be9e92ba6f15de6d621aaf5e96108a574043c7d0831527eeea5d6adfcc87 |
| Extração pura | 643cfdb487aa5a15cb4b0f2385849525ada03b497fd08f877525a742f582a9f0 |
| Vetores | 420387c2a98220a6a9bb5a07d2fb063e09ced1bc9555f59a7650f344154404de |
| Manifesto/release | fe095417e3406a5949937e1775df18924363cd91e8af9dafb4d87fce8118b310 |

A extração copia trechos literais: UUID/GUARD_KEYS/ORIGINS, exact/millis,
recordStructure e a seção do leitor puro até antes da factory sintética. Não copia
a factory, operações com colaboradores ou SDK. O teste Functions verifica a
extração e o hash contra a fonte atual, sem reescrever nada automaticamente.
Os resultados esperados foram explicitados segundo o contrato aprovado, sem
gerá-los pela execução do classificador durante os testes.

COMPROVADA: hashes, versões, campos adicionais de manifesto/vetor/saída, mudança de
segurança e alteração do corpo da referência causam falha. Comparam-se respostas
completas, incluindo requiredEvidence e sua ordem, contexto temporal, operation,
auth e todos os campos auxiliares; não apenas status. Cada caso verifica objeto
e array de evidências congelados, recusa de mutação e ausência de identificadores
sintéticos na resposta.

PENDENTE/processual: um backend isolado pode continuar passando com sua release
antiga enquanto o root evolui. Não existe comunicação entre checkouts. Uma mudança
canônica exige revisão e atualização manual coordenada de versão, manifesto,
fixture e vetores antes de qualquer ativação futura. O hash detecta divergência
acidental; não é assinatura, atestação Auth nem autorização contra quem pode editar
os próprios testes. Não atualizar goldens automaticamente para encobrir regressões.

## Matriz dos 54 vetores

| Família | Interpretação comum demonstrada |
|---|---|
| Reserva ausente | ABSENT, sem admissão; distinguir guard ausente/ativo. |
| V1 | Reconhecimento estrutural separado de metadata insuficiente e contexto inconsistente. |
| V2 PRE_AUTH/AUTH_EVENT/LEGACY_REVIEW | Revalidação da origem correspondente, nunca procedência comprovada. |
| Versão futura/schema malformado | VERSION_UNSUPPORTED/RECORD_INVALID, sem adoção/conversão. |
| Guard IN_PROGRESS/COMPLETE | Contexto e prova terminal separados. |
| COMPLETE retido/expirado/sem clock | TERMINAL_PROOF_REQUIRED; não reabrir. |
| COMPLETE retainUntil null | GUARD_INVALID, preservando FIX1. |
| Guard ausente/deletionId/origem divergentes | Revisão obrigatória ou conflito, sem autoridade. |
| Auth PRESENT/ABSENT/AMBIGUOUS/UNAVAILABLE | Presença bloqueia recuperação; ausência não prova geração nem limpeza. |
| Limites temporais | Igualdade e diferença de um nanossegundo preservadas. |
| Metadata SDK não normalizada | Inconclusiva, sem chamar toMillis/toDate/toJSON. |
| Frames contraditórios e campos extras | Recusa conservadora; erro de leitura não promove registro inválido. |

COMPROVADA: paridade local dos 54 resultados completos nos dois runtimes de teste,
sem diferenças encontradas no contrato. As fixtures SDK não normalizadas são
classes sintéticas usadas somente para decorar dados do teste; não são snapshots
ou RPCs reais. Em todas as respostas: destructiveAuthority=false,
admissionAuthority=false, provenance=UNPROVEN, terminalProof=NOT_PERFORMED.

## Três fronteiras e regressões que uma integração deve evitar

COMPROVADA: R12 testa A, classificação de frames já carregados. R11 também oferece
B, normalização de snapshots SDK, e C, aquisição restrita ao Emulator com pedido de
transação read-only. A/B não comprovam aquisição conjunta. O backend ainda não tem
B/C equivalente. PENDENTE: adaptar/testar essa fronteira sem fazer leituras
independentes parecerem consistentes ou aceitar condições mais permissivas.
Mesmo C não inclui Firebase Auth nem garante a leitura mais recente.

| Código vigente, somente inspecionado | Risco de integração futura |
|---|---|
| backend/api/account/_shared.js:255-327; delete.js:392-446 | Preservar token não revogado, App Check, UID próprio, autenticação recente, limites e confirmação apenas depois do fluxo terminal. |
| functions/index.js:531-578; birth_ledger_cleanup.js:193-229 | Evento gerenciado tem admissão própria; não exigir PRE_AUTH retroativo nem bloquear contas legadas só por ausência de reserva. |
| Helpers circle_cleanup:71-101 nos dois projetos | Manter revalidação IN_PROGRESS/deletionId em cada transação preparatória; um resultado do leitor não substitui a capability ACTIVE D2-A-R2. |
| Birth cleanup finish: Functions 240-266; backend 263-293 | Preservar provas de Billing, tokens, Círculos, runtime, raiz/descendentes e ledger antes de COMPLETE. |
| Birth cleanup prepare: Functions 219-223; backend 226-230 | Há tratamento legado restrito de resíduos com COMPLETE; R12 não autoriza reabertura nem altera essa lógica preexistente. |
| Helpers validateGuard:44-49 | Helpers atuais usam toMillis; a paridade do leitor puro não certifica equivalência operacional ou precisão desses parsers. Não foram alterados. |
| lib/features/auth/data/repositories/auth_repository_impl.dart:65-100 | D2-B mantém erro ambíguo/unconfirmed mesmo se Auth já sumiu; não mapear ABSENT/COMPLETE do leitor para sucesso Flutter. |

INFERIDA: ligar diretamente status do classificador a esses fluxos pode bloquear
exclusões legítimas ou remover fences/provas. Não existe tal ligação na R12.
PENDENTE: política comprovada de UID não reutilizado, procedência administrativa,
IAM mínimo, retenção e recuperação pós-Auth. Nenhum hash resolve a corrida Auth/
Firestore ou comprova ausência histórica de reutilização de UID.

## Execução e isolamento

COMPROVADA, Node v24.17.0:

- Functions R12: 73/73; backend R12: 72/72 (Functions possui teste canônico adicional).
- Functions R2/V2/R10/FIX1/R11/R12: 328/328, zero falhas/skips.
- Functions completa: 768 descobertos, 767 aprovados, zero falhas, 1 skip R3 opt-in.
- Backend exclusão/Auth/Billing/Círculos + R12: 552/552.
- Backend completa: 1659/1659, zero falhas/skips.

Comandos independentes: `node --test test/retired-identity-conformance.test.cjs`
em cada projeto. Regressões completas: `node --test` em functions e backend.
Nenhuma fixture de um repositório precisa do checkout do outro para executar.

PENDENTE: Node 22 não foi encontrado no PATH; as duas instalações consultadas são
v24.17.0 e v24.19.0. Nenhum runtime instalado. Firestore Emulator não
foi executado nesta rodada: restrição anterior de socket não reavaliada ou
contornada; R3 permaneceu skip. Não apresentar testes locais como validação real
do Emulator, IAM, eventos Auth ou serviços implantados.

COMPROVADA: zero uso de produção, consultas remotas, serviços novos, dependências,
polling, writes Firestore ou exclusões Auth na R12. Custo adicional Google/Firebase
zero. Os 31 arquivos protegidos comparados com seus HEADs permanecem iguais.
Staging vazio nos dois repositórios; gitlink HEAD/index preservado em
`d2af978f3aa99eae2d21e50a89d411894c449b37`. git status e git diff --check
falharam no sandbox com saída 128; não foram contornados. A verificação dos patches
usou --whitespace=error-all e reprodução integral em diretórios temporários.

Próxima etapa mínima proposta, sem início nesta rodada: especificar e testar a
fronteira SDK/aquisição consistente do backend em isolamento, reaproveitando estes
vetores. Validar Emulator quando permitido e resolver gates de identidade/IAM
antes de integrar leituras a rotinas reais. Rollback desta rodada é retirar apenas
os artefatos novos de teste/documentação; não há schema ou dados para migrar.
A recuperação destrutiva continua bloqueada. R13 não iniciada.
