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

type EstadoScanner = 'iniciando' | 'lendo' | 'erro';

/** Capabilities e constraints de lanterna ainda não estão na tipagem padrão do DOM. */
type CapacidadesComLanterna = MediaTrackCapabilities & { torch?: boolean };

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

  protected readonly estado = signal<EstadoScanner>('iniciando');
  protected readonly mensagem = signal('');
  protected readonly lanternaLigada = signal(false);
  protected readonly temLanterna = signal(false);
  protected readonly temOutrasCameras = signal(false);

  private leitor?: BrowserMultiFormatReader;
  private controles?: IScannerControls;
  private dispositivos: MediaDeviceInfo[] = [];
  private indiceDispositivo = 0;

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

  private async iniciar(deviceId?: string): Promise<void> {
    if (!this.leitor) {
      return;
    }

    this.encerrar();
    this.estado.set('iniciando');

    const alvo = this.video().nativeElement;
    const aoDecodificar = (resultado: Result | undefined) => {
      if (resultado) {
        // A decodificação acontece fora do ciclo do Angular.
        this.zone.run(() => this.leitura.emit(resultado.getText()));
      }
    };

    try {
      this.controles = deviceId
        ? await this.leitor.decodeFromVideoDevice(deviceId, alvo, aoDecodificar)
        : await this.leitor.decodeFromConstraints(
            {
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
              }
            },
            alvo,
            aoDecodificar
          );

      this.zone.run(() => this.estado.set('lendo'));
      await this.mapearRecursos();
    } catch (erro) {
      this.falhar(this.traduzirErro(erro));
    }
  }

  /** Descobre se dá para usar lanterna e se existe mais de uma câmera no aparelho. */
  private async mapearRecursos(): Promise<void> {
    try {
      this.dispositivos = await BrowserCodeReader.listVideoInputDevices();
      this.zone.run(() => this.temOutrasCameras.set(this.dispositivos.length > 1));
    } catch {
      this.zone.run(() => this.temOutrasCameras.set(false));
    }

    const stream = this.video().nativeElement.srcObject as MediaStream | null;
    const trilha = stream?.getVideoTracks()[0];
    const capacidades = trilha?.getCapabilities?.() as CapacidadesComLanterna | undefined;

    this.zone.run(() => this.temLanterna.set(Boolean(capacidades?.torch)));
  }

  private encerrar(): void {
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
