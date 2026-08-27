import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  inject,
  output,
  signal,
  viewChild
} from '@angular/core';
import { PoButtonModule, PoTagModule, PoTagType } from '@po-ui/ng-components';
import { BrowserCodeReader, BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, Result } from '@zxing/library';

type EstadoScanner = 'iniciando' | 'lendo' | 'foto' | 'erro';

/** Capabilities e constraints de lanterna e foco ainda não estão na tipagem padrão do DOM. */
type CapacidadesExtras = MediaTrackCapabilities & { torch?: boolean; zoom?: { max: number } };

/** Segundos sem leitura antes de sugerir a foto. */
const SEGUNDOS_ATE_DICA = 8;

@Component({
  selector: 'app-scanner-camera',
  imports: [PoButtonModule, PoTagModule],
  templateUrl: './scanner-camera.html',
  styleUrl: './scanner-camera.css'
})
export class ScannerCamera implements AfterViewInit, OnDestroy {
  /** Texto cru devolvido pelo código lido. Quem recebe decide se é uma chave válida. */
  readonly leitura = output<string>();

  protected readonly tipoTag = PoTagType;

  private readonly zone = inject(NgZone);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly arquivo = viewChild.required<ElementRef<HTMLInputElement>>('arquivo');

  protected readonly estado = signal<EstadoScanner>('iniciando');
  protected readonly mensagem = signal('');
  protected readonly mensagemFoto = signal('');
  protected readonly lanternaLigada = signal(false);
  protected readonly temLanterna = signal(false);
  protected readonly temOutrasCameras = signal(false);
  protected readonly resolucao = signal('');
  protected readonly tentativas = signal(0);
  protected readonly demorando = signal(false);

  private leitor?: BrowserMultiFormatReader;
  private controles?: IScannerControls;
  private dispositivos: Array<MediaDeviceInfo> = [];
  private indiceDispositivo = 0;
  private contador = 0;
  private relogioDica?: ReturnType<typeof setTimeout>;

  async ngAfterViewInit(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.falhar(
        'Este navegador não libera o acesso à câmera. A página precisa estar em HTTPS ou em localhost.'
      );
      return;
    }

    const hints = new Map<DecodeHintType, any>();

    // O DANFE traz a chave em CODE-128. O QR Code cobre a NFC-e.
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    this.leitor = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 100,
      delayBetweenScanSuccess: 1500
    });

    await this.iniciar();
  }

  ngOnDestroy(): void {
    this.encerrar();
  }

  protected async alternarLanterna(): Promise<void> {
    const desejado = !this.lanternaLigada();

    try {
      await this.controles?.switchTorch?.(desejado);
      this.lanternaLigada.set(desejado);
    } catch {
      this.temLanterna.set(false);
    }
  }

  protected async trocarCamera(): Promise<void> {
    if (this.dispositivos.length < 2) {
      return;
    }

    this.indiceDispositivo = (this.indiceDispositivo + 1) % this.dispositivos.length;
    this.lanternaLigada.set(false);
    await this.iniciar(this.dispositivos[this.indiceDispositivo].deviceId);
  }

  protected async tentarNovamente(): Promise<void> {
    await this.iniciar();
  }

  protected escolherFoto(): void {
    this.arquivo().nativeElement.click();
  }

  /**
   * Leitura a partir de uma foto.
   *
   * A foto sai na resolução cheia da câmera, muito acima do vídeo ao vivo, então
   * resolve os casos em que o código de barras é denso demais ou a impressão está gasta.
   */
  protected async aoEscolherFoto(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const foto = input.files?.[0];
    input.value = '';

    if (!foto || !this.leitor) {
      return;
    }

    // No iOS a câmera do sistema derruba o vídeo ao vivo, então paramos antes.
    this.encerrar();
    this.estado.set('foto');
    this.mensagemFoto.set('');

    const url = URL.createObjectURL(foto);

    try {
      const resultado = await this.leitor.decodeFromImageUrl(url);
      this.leitura.emit(resultado.getText());
    } catch {
      this.mensagemFoto.set(
        'Não encontrei um código de barras nessa foto. Enquadre só a faixa de barras, bem de frente e com boa luz.'
      );
      await this.iniciar();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async iniciar(deviceId?: string): Promise<void> {
    if (!this.leitor) {
      return;
    }

    this.encerrar();
    this.estado.set('iniciando');
    this.contador = 0;
    this.tentativas.set(0);
    this.demorando.set(false);

    const alvo = this.video().nativeElement;
    const aoDecodificar = (resultado: Result | undefined) => {
      // A decodificação acontece fora do ciclo do Angular.
      if (resultado) {
        this.zone.run(() => this.leitura.emit(resultado.getText()));
        return;
      }

      this.contador++;

      // Publicar a cada dez tentativas evita disparar detecção de mudança sem parar.
      if (this.contador % 10 === 0) {
        this.zone.run(() => this.tentativas.set(this.contador));
      }
    };

    try {
      this.controles = deviceId
        ? await this.leitor.decodeFromVideoDevice(deviceId, alvo, aoDecodificar)
        : await this.leitor.decodeFromConstraints(
            { video: this.restricoesDeVideo() },
            alvo,
            aoDecodificar
          );

      this.zone.run(() => this.estado.set('lendo'));
      this.relogioDica = setTimeout(
        () => this.zone.run(() => this.demorando.set(true)),
        SEGUNDOS_ATE_DICA * 1000
      );

      await this.mapearRecursos();
    } catch (erro) {
      this.falhar(this.traduzirErro(erro));
    }
  }

  /**
   * A chave de acesso tem 44 dígitos, o que dá um CODE-128 estreito e denso.
   * Em 720p o celular costuma não resolver as barras, por isso pedimos o máximo
   * que a câmera oferecer e foco contínuo.
   */
  private restricoesDeVideo(): MediaTrackConstraints {
    return {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet]
    };
  }

  /** Descobre se dá para usar lanterna, se existe outra câmera e em que resolução ficou. */
  private async mapearRecursos(): Promise<void> {
    try {
      this.dispositivos = await BrowserCodeReader.listVideoInputDevices();
      this.zone.run(() => this.temOutrasCameras.set(this.dispositivos.length > 1));
    } catch {
      this.zone.run(() => this.temOutrasCameras.set(false));
    }

    const stream = this.video().nativeElement.srcObject as MediaStream | null;
    const trilha = stream?.getVideoTracks()[0];
    const capacidades = trilha?.getCapabilities?.() as CapacidadesExtras | undefined;
    const ajustes = trilha?.getSettings?.();

    this.zone.run(() => {
      this.temLanterna.set(Boolean(capacidades?.torch));
      this.resolucao.set(ajustes?.width && ajustes?.height ? `${ajustes.width}x${ajustes.height}` : '');
    });
  }

  private encerrar(): void {
    clearTimeout(this.relogioDica);

    this.controles?.stop();
    this.controles = undefined;

    const stream = this.video().nativeElement.srcObject as MediaStream | null;
    stream?.getTracks().forEach(trilha => trilha.stop());
    this.video().nativeElement.srcObject = null;
  }

  private falhar(mensagem: string): void {
    this.zone.run(() => {
      this.mensagem.set(mensagem);
      this.estado.set('erro');
    });
  }

  private traduzirErro(erro: unknown): string {
    const nome = (erro as DOMException)?.name;

    switch (nome) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Permissão de câmera negada. Libere o acesso nas configurações do navegador e tente de novo.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'Nenhuma câmera compatível foi encontrada neste aparelho.';
      case 'NotReadableError':
        return 'A câmera está ocupada por outro aplicativo. Feche o outro app e tente de novo.';
      default:
        return 'Não foi possível abrir a câmera. Verifique se a página está em HTTPS e tente de novo.';
    }
  }
}
