/**
 * Regras da chave de acesso de documentos fiscais eletrônicos.
 *
 * Layout dos 44 dígitos:
 *
 *   cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
 *
 * Este arquivo não depende de Angular de propósito, para poder ser reaproveitado
 * em qualquer lugar (testes, worker, outro app).
 */

export interface ChaveNfe {
  chave: string;
  chaveFormatada: string;
  uf: string;
  ufSigla: string;
  competencia: string;
  cnpj: string;
  cnpjFormatado: string;
  modelo: string;
  modeloDescricao: string;
  serie: string;
  numero: string;
  numeroFormatado: string;
  tipoEmissao: string;
  tipoEmissaoDescricao: string;
  codigoNumerico: string;
  dv: string;
}

export interface ResultadoValidacao {
  valido: boolean;
  motivo?: string;
}

const UF_POR_CODIGO: Record<string, string> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
  '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL',
  '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR',
  '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF'
};

const MODELOS: Record<string, string> = {
  '55': 'NF-e',
  '57': 'CT-e',
  '58': 'MDF-e',
  '59': 'CF-e (SAT)',
  '65': 'NFC-e',
  '67': 'CT-e OS'
};

const TIPOS_EMISSAO: Record<string, string> = {
  '1': 'Normal',
  '2': 'Contingência FS-IA',
  '3': 'Contingência SCAN',
  '4': 'Contingência EPEC',
  '5': 'Contingência FS-DA',
  '6': 'Contingência SVC-AN',
  '7': 'Contingência SVC-RS',
  '9': 'Contingência off-line NFC-e'
};

/** Modelos que o app aceita conferir. Os demais são lidos só para dar mensagem melhor. */
export const MODELOS_ACEITOS = ['55', '65'];

export function somenteDigitos(valor: string): string {
  return (valor ?? '').replace(/\D/g, '');
}

/**
 * Extrai a chave de qualquer coisa que a câmera devolver.
 *
 * Aceita:
 *  - os 44 dígitos crus, que é o conteúdo do CODE-128 do DANFE
 *  - a chave digitada com espaços ou pontos
 *  - a URL do QR Code da NFC-e, onde a chave vem no parâmetro p, antes do primeiro |
 *  - texto no formato chNFe=00000...
 */
export function extrairChave(texto: string): string | null {
  if (!texto) {
    return null;
  }

  const parametro = texto.match(/[?&]p=([^|&\s]+)/i);
  if (parametro) {
    const candidata = somenteDigitos(parametro[1]);
    if (candidata.length === 44) {
      return candidata;
    }
  }

  const digitos = somenteDigitos(texto);

  if (digitos.length === 44) {
    return digitos;
  }

  const sequencia = digitos.match(/\d{44}/);
  return sequencia ? sequencia[0] : null;
}

/**
 * Dígito verificador, módulo 11 com pesos de 2 a 9 da direita para a esquerda.
 * Resto 0 ou 1 resulta em dígito 0.
 */
export function calcularDv(chaveSemDv: string): number {
  let peso = 2;
  let soma = 0;

  for (let i = chaveSemDv.length - 1; i >= 0; i--) {
    soma += Number(chaveSemDv[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function validarChave(chave: string): ResultadoValidacao {
  if (!chave) {
    return { valido: false, motivo: 'Nenhuma chave informada.' };
  }

  if (!/^\d{44}$/.test(chave)) {
    return { valido: false, motivo: 'A chave precisa ter exatamente 44 dígitos.' };
  }

  const uf = chave.slice(0, 2);
  if (!UF_POR_CODIGO[uf]) {
    return { valido: false, motivo: `Código de UF inválido: ${uf}.` };
  }

  const mes = Number(chave.slice(4, 6));
  if (mes < 1 || mes > 12) {
    return { valido: false, motivo: 'Mês de emissão inválido na chave.' };
  }

  if (calcularDv(chave.slice(0, 43)) !== Number(chave[43])) {
    return { valido: false, motivo: 'Dígito verificador não confere. Leia o código novamente.' };
  }

  return { valido: true };
}

export function formatarChave(chave: string): string {
  return (chave.match(/.{1,4}/g) ?? []).join(' ');
}

export function formatarCnpj(cnpj: string): string {
  if (cnpj.length !== 14) {
    return cnpj;
  }
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

export function parseChave(chave: string): ChaveNfe {
  const uf = chave.slice(0, 2);
  const aamm = chave.slice(2, 6);
  const cnpj = chave.slice(6, 20);
  const modelo = chave.slice(20, 22);
  const serie = chave.slice(22, 25);
  const numero = chave.slice(25, 34);
  const tipoEmissao = chave.slice(34, 35);

  return {
    chave,
    chaveFormatada: formatarChave(chave),
    uf,
    ufSigla: UF_POR_CODIGO[uf] ?? '??',
    competencia: `${aamm.slice(2)}/20${aamm.slice(0, 2)}`,
    cnpj,
    cnpjFormatado: formatarCnpj(cnpj),
    modelo,
    modeloDescricao: MODELOS[modelo] ?? 'Modelo desconhecido',
    serie: String(Number(serie)),
    numero: String(Number(numero)),
    numeroFormatado: Number(numero).toLocaleString('pt-BR'),
    tipoEmissao,
    tipoEmissaoDescricao: TIPOS_EMISSAO[tipoEmissao] ?? 'Não identificado',
    codigoNumerico: chave.slice(35, 43),
    dv: chave.slice(43)
  };
}

export function modeloAceito(modelo: string): boolean {
  return MODELOS_ACEITOS.includes(modelo);
}
