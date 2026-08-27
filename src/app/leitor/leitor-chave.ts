import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  PoButtonModule,
  PoDividerModule,
  PoFieldModule,
  PoInfoModule,
  PoListViewAction,
  PoListViewModule,
  PoModalAction,
  PoModalComponent,
  PoModalModule,
  PoNotificationService,
  PoPageModule,
  PoTagModule,
  PoTagType,
  PoWidgetModule
} from '@po-ui/ng-components';

import {
  ChaveNfe,
  extrairChave,
  modeloAceito,
  parseChave,
  somenteDigitos,
  validarChave
} from '../core/chave-nfe';
import { Leitura, LeiturasStore } from '../core/leituras.store';
import { ScannerCamera } from './scanner-camera';

const PORTAL_NFE = 'https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx';

@Component({
  selector: 'app-leitor-chave',
  imports: [
    FormsModule,
    PoButtonModule,
    PoDividerModule,
    PoFieldModule,
    PoInfoModule,
    PoListViewModule,
    PoModalModule,
    PoPageModule,
    PoTagModule,
    PoWidgetModule,
    ScannerCamera
  ],
  templateUrl: './leitor-chave.html',
  styleUrl: './leitor-chave.css'
})
export class LeitorChave {
  private readonly notificacao = inject(PoNotificationService);
  private readonly leituras = inject(LeiturasStore);
  private readonly modal = viewChild.required<PoModalComponent>('modalScanner');

  protected readonly resultado = signal<ChaveNfe | null>(null);
  protected readonly alerta = signal('');
  protected readonly scannerAtivo = signal(false);
  protected readonly historico = this.leituras.historico;

  protected chaveManual = '';

  protected readonly tipoTag = PoTagType;

  protected readonly acaoFecharScanner: PoModalAction = {
    label: 'Fechar',
    action: () => this.fecharScanner()
  };


  protected readonly acoesHistorico: Array<PoListViewAction> = [
    {
      label: 'Abrir',
      icon: 'an an-arrow-square-out',
      action: (item: Leitura) => this.processar(item.chave, 'historico')
    },
    {
      label: 'Remover',
      icon: 'an an-trash',
      action: (item: Leitura) => this.leituras.remover(item.chave)
    }
  ];

  protected readonly temHistorico = computed(() => this.historico().length > 0);

  protected abrirScanner(): void {
    this.scannerAtivo.set(true);
    this.modal().open();
  }

  /** Fecha o modal. Quem desliga a câmera é o próprio evento de fechamento. */
  protected fecharScanner(): void {
    this.modal().close();
  }

  /**
   * Disparado pelo po-modal ao fechar, seja pelo botao, pelo X ou pelo Esc.
   * Derrubar o scanner aqui garante que a câmera sempre é liberada.
   */
  protected aoFecharModal(): void {
    this.scannerAtivo.set(false);
  }

  /** Recebe o texto cru do código lido pela câmera. */
  protected aoLerCodigo(texto: string): void {
    this.processar(texto, 'camera');
  }

  protected confirmarDigitacao(): void {
    this.processar(this.chaveManual, 'manual');
  }

  protected limpar(): void {
    this.resultado.set(null);
    this.alerta.set('');
    this.chaveManual = '';
  }

  protected async copiarChave(): Promise<void> {
    const atual = this.resultado();

    if (!atual) {
      return;
    }

    try {
      await navigator.clipboard.writeText(atual.chave);
      this.notificacao.success('Chave copiada.');
    } catch {
      this.notificacao.warning('O navegador não liberou a cópia. Selecione a chave manualmente.');
    }
  }

  protected consultarNoPortal(): void {
    window.open(PORTAL_NFE, '_blank', 'noopener');
  }

  protected formatarData(iso: string): string {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso)
    );
  }

  private processar(texto: string, origem: 'camera' | 'manual' | 'historico'): void {
    const chave = extrairChave(texto);

    if (!chave) {
      const digitos = somenteDigitos(texto).length;
      this.recusar(
        digitos > 0
          ? `Foram lidos ${digitos} dígitos. A chave de acesso tem 44.`
          : 'O código lido não contém uma chave de acesso.',
        origem
      );
      return;
    }

    const validacao = validarChave(chave);

    if (!validacao.valido) {
      this.recusar(validacao.motivo ?? 'Chave inválida.', origem);
      return;
    }

    const dados = parseChave(chave);

    this.resultado.set(dados);
    this.chaveManual = dados.chave;
    this.leituras.registrar(dados);

    if (!modeloAceito(dados.modelo)) {
      // A chave é legítima, mas o documento não é NF-e nem NFC-e.
      this.alerta.set(
        `Documento modelo ${dados.modelo} (${dados.modeloDescricao}). A conferência trabalha com NF-e e NFC-e.`
      );
      this.notificacao.warning(this.alerta());
    } else {
      this.alerta.set('');
      this.notificacao.success(`${dados.modeloDescricao} ${dados.numeroFormatado} lida.`);
    }

    if (origem === 'camera') {
      this.sinalizar();
      this.fecharScanner();
    }
  }

  private recusar(motivo: string, origem: 'camera' | 'manual' | 'historico'): void {
    this.notificacao.error(motivo);

    if (origem !== 'camera') {
      this.alerta.set(motivo);
    }
  }

  /** Vibra e apita, porque no galpão ninguém fica olhando para a tela. */
  private sinalizar(): void {
    navigator.vibrate?.(120);

    try {
      const contexto = new AudioContext();
      const oscilador = contexto.createOscillator();
      const ganho = contexto.createGain();

      oscilador.frequency.value = 880;
      ganho.gain.value = 0.1;

      oscilador.connect(ganho);
      ganho.connect(contexto.destination);
      oscilador.start();
      oscilador.stop(contexto.currentTime + 0.12);

      oscilador.onended = () => contexto.close();
    } catch {
      // Sem áudio disponível, a vibração já resolve.
    }
  }
}
