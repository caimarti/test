import {
  calcularDv,
  extrairChave,
  formatarCnpj,
  formatarChave,
  modeloAceito,
  parseChave,
  validarChave
} from './chave-nfe';

// Chave real de homologacao, usada como referencia do digito verificador.
const CHAVE_VALIDA = '35120859597245000190550000000095831710040056';
const CHAVE_NFCE = '35240659597245000190650010000123451876543214';

describe('chave-nfe', () => {
  describe('calcularDv', () => {
    it('reproduz o digito verificador de uma chave conhecida', () => {
      expect(calcularDv(CHAVE_VALIDA.slice(0, 43))).toBe(Number(CHAVE_VALIDA[43]));
    });

    it('devolve 0 quando o resto do modulo 11 e menor que 2', () => {
      // 43 zeros somam 0, entao resto 0 e digito 0.
      expect(calcularDv('0'.repeat(43))).toBe(0);
    });
  });

  describe('validarChave', () => {
    it('aceita uma chave integra', () => {
      expect(validarChave(CHAVE_VALIDA).valido).toBe(true);
    });

    it('recusa quando o tamanho e diferente de 44', () => {
      const resultado = validarChave(CHAVE_VALIDA.slice(0, 43));
      expect(resultado.valido).toBe(false);
      expect(resultado.motivo).toContain('44');
    });

    it('recusa um digito verificador trocado', () => {
      const adulterada = CHAVE_VALIDA.slice(0, 43) + ((Number(CHAVE_VALIDA[43]) + 1) % 10);
      expect(validarChave(adulterada).valido).toBe(false);
    });

    it('recusa um codigo de UF inexistente', () => {
      const base = '99' + CHAVE_VALIDA.slice(2, 43);
      expect(validarChave(base + calcularDv(base)).valido).toBe(false);
    });

    it('recusa um mes de emissao invalido', () => {
      const base = CHAVE_VALIDA.slice(0, 4) + '13' + CHAVE_VALIDA.slice(6, 43);
      expect(validarChave(base + calcularDv(base)).valido).toBe(false);
    });
  });

  describe('extrairChave', () => {
    it('aceita os 44 digitos crus do CODE-128', () => {
      expect(extrairChave(CHAVE_VALIDA)).toBe(CHAVE_VALIDA);
    });

    it('aceita a chave digitada com espacos', () => {
      expect(extrairChave(formatarChave(CHAVE_VALIDA))).toBe(CHAVE_VALIDA);
    });

    it('aceita o QR Code da NFC-e, onde a chave vem no parametro p', () => {
      const qr = `https://www.fazenda.sp.gov.br/nfce/qrcode?p=${CHAVE_NFCE}|2|1|1|abc123`;
      expect(extrairChave(qr)).toBe(CHAVE_NFCE);
    });

    it('aceita o formato chNFe=', () => {
      expect(extrairChave(`chNFe=${CHAVE_VALIDA}`)).toBe(CHAVE_VALIDA);
    });

    it('devolve nulo para um codigo de barras de produto', () => {
      expect(extrairChave('7891234567895')).toBeNull();
    });

    it('devolve nulo para texto sem digitos', () => {
      expect(extrairChave('etiqueta do fornecedor')).toBeNull();
    });
  });

  describe('parseChave', () => {
    it('separa os campos da chave', () => {
      const dados = parseChave(CHAVE_VALIDA);

      expect(dados.ufSigla).toBe('SP');
      expect(dados.competencia).toBe('08/2012');
      expect(dados.cnpj).toBe('59597245000190');
      expect(dados.modelo).toBe('55');
      expect(dados.modeloDescricao).toBe('NF-e');
      expect(dados.serie).toBe('0');
      expect(dados.numero).toBe('9583');
      expect(dados.tipoEmissaoDescricao).toBe('Normal');
      expect(dados.dv).toBe('6');
    });

    it('identifica a NFC-e', () => {
      expect(parseChave(CHAVE_NFCE).modeloDescricao).toBe('NFC-e');
    });
  });

  describe('modeloAceito', () => {
    it('aceita NF-e e NFC-e', () => {
      expect(modeloAceito('55')).toBe(true);
      expect(modeloAceito('65')).toBe(true);
    });

    it('recusa CT-e e MDF-e', () => {
      expect(modeloAceito('57')).toBe(false);
      expect(modeloAceito('58')).toBe(false);
    });
  });

  describe('formatarCnpj', () => {
    it('formata os 14 digitos', () => {
      expect(formatarCnpj('59597245000190')).toBe('59.597.245/0001-90');
    });

    it('devolve o valor original quando nao tem 14 digitos', () => {
      expect(formatarCnpj('123')).toBe('123');
    });
  });
});
