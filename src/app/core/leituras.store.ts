import { Injectable, signal } from '@angular/core';
import { ChaveNfe } from './chave-nfe';

export interface Leitura {
  chave: string;
  chaveFormatada: string;
  documento: string;
  emitente: string;
  lidaEm: string;
}

const ITEM_STORAGE = 'leitor-chave:historico';
const LIMITE = 20;

/**
 * Histórico das últimas chaves lidas, guardado no próprio aparelho.
 *
 * Serve para o conferente voltar em uma nota sem precisar escanear de novo.
 * Quando a integração com o Protheus entrar, este histórico continua sendo local,
 * quem manda no que foi conferido de verdade é o ERP.
 */
@Injectable({ providedIn: 'root' })
export class LeiturasStore {
  private readonly itens = signal<Array<Leitura>>(this.carregar());

  readonly historico = this.itens.asReadonly();

  registrar(dados: ChaveNfe): void {
    const leitura: Leitura = {
      chave: dados.chave,
      chaveFormatada: dados.chaveFormatada,
      documento: `${dados.modeloDescricao} ${dados.numeroFormatado} / série ${dados.serie}`,
      emitente: dados.cnpjFormatado,
      lidaEm: new Date().toISOString()
    };

    const semDuplicada = this.itens().filter(item => item.chave !== leitura.chave);
    this.persistir([leitura, ...semDuplicada].slice(0, LIMITE));
  }

  remover(chave: string): void {
    this.persistir(this.itens().filter(item => item.chave !== chave));
  }

  limpar(): void {
    this.persistir([]);
  }

  private persistir(lista: Array<Leitura>): void {
    this.itens.set(lista);

    try {
      localStorage.setItem(ITEM_STORAGE, JSON.stringify(lista));
    } catch {
      // Navegação privada ou storage cheio. O histórico segue só em memória.
    }
  }

  private carregar(): Array<Leitura> {
    try {
      const bruto = localStorage.getItem(ITEM_STORAGE);
      const lista = bruto ? JSON.parse(bruto) : [];
      return Array.isArray(lista) ? lista : [];
    } catch {
      return [];
    }
  }
}
