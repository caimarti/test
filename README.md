# Leitor de chave de acesso

Aplicação Angular com [PO UI](https://po-ui.io) que lê a chave de acesso de NF-e e NFC-e
pela câmera do celular, valida a chave e mostra os dados que ela carrega.

É o primeiro passo de um fluxo de separação e conferência: a chave é o identificador
que depois vai buscar a nota no Protheus.

## O que já funciona

- Leitura pela câmera do código de barras CODE-128 do DANFE, onde ficam os 44 dígitos
- Leitura do QR Code da NFC-e, extraindo a chave do parâmetro `p` da URL
- Digitação manual, com ou sem espaços, para quando o DANFE está amassado ou apagado
- Validação do dígito verificador pelo módulo 11, além de UF e mês de emissão
- Leitura dos campos embutidos na chave: UF, competência, CNPJ do emitente, modelo,
  série, número, tipo de emissão e DV
- Aviso quando a chave é válida mas o documento não é NF-e nem NFC-e, por exemplo um CT-e
- Lanterna e troca de câmera, quando o aparelho oferece
- Vibração e bipe na leitura, porque no galpão ninguém fica olhando para a tela
- Histórico das últimas 20 leituras, guardado no próprio aparelho

## Como rodar

```bash
npm install
npm start
```

A aplicação sobe em `http://localhost:4200`.

### Testando no celular

A câmera só é liberada em contexto seguro. `localhost` conta como seguro, qualquer
outro endereço precisa de HTTPS. Para abrir no celular durante o desenvolvimento,
use um túnel HTTPS ou um certificado local:

```bash
npm start -- --host 0.0.0.0 --ssl
```

Sem HTTPS o navegador nem pede permissão, apenas bloqueia o acesso à câmera.

## Testes

```bash
npm test
```

Os testes cobrem o núcleo fiscal: cálculo do DV, validação da chave, extração a partir
do QR Code da NFC-e e a separação dos campos.

## Estrutura

```
src/app/
  core/
    chave-nfe.ts          regras da chave, sem dependência de Angular
    chave-nfe.spec.ts     testes do parser e do dígito verificador
    leituras.store.ts     histórico local das chaves lidas
  leitor/
    scanner-camera.*      acesso à câmera e decodificação com ZXing
    leitor-chave.*        tela principal, validação e exibição
```

O arquivo `core/chave-nfe.ts` é propositalmente independente de Angular, para poder ser
reaproveitado em um worker, em outro app ou nos testes.

## Layout da chave de acesso

| Posição | Tamanho | Conteúdo |
|---|---|---|
| 0 a 1 | 2 | Código da UF |
| 2 a 5 | 4 | AAMM da emissão |
| 6 a 19 | 14 | CNPJ do emitente |
| 20 a 21 | 2 | Modelo, 55 para NF-e e 65 para NFC-e |
| 22 a 24 | 3 | Série |
| 25 a 33 | 9 | Número da NF |
| 34 | 1 | Tipo de emissão |
| 35 a 42 | 8 | Código numérico |
| 43 | 1 | Dígito verificador |

## Próximos passos

Integração com o Protheus, buscando a nota pela chave:

- Endpoint REST no Protheus recebendo os 44 dígitos
- Consulta na SF2 por `F2_CHVNFE`, com índice próprio para não varrer a tabela
- Itens da nota vindos da SD2
- Gravação da conferência em tabela customizada, nunca na SD2, que é fiscal

A chave é o identificador correto para essa busca. Número e série se repetem entre
filiais, a chave é única no país.
