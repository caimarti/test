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
import { BarcodeFormat, DecodeHintType, NotFoundException, Result } from '@zxing/library';

type EstadoScanner = 'iniciando' | 'lendo' | 'foto' | 'erro';

/** Capabilities e constraints de lanterna e foco ainda não estão na tipagem padrão do DOM. */
type CapacidadesExtras = MediaTrackCapabilities & { torch?: boolean; zoom?: { max: number } };

/**
 * A ImageCapture API ainda não está na lib DOM padrão do TypeScript.
 * `takePhoto` devolve uma foto na resolução cheia do sensor, bem acima do que
 * o stream de vídeo entrega, sem precisar abrir o app de câmera do sistema.
 */
interface FotografoDeQuadro {
  takePhoto(): Promise<Blob>;
}

type ConstrutorImageCapture = new (track: MediaStreamTrack) => FotografoDeQuadro;

/** Segundos sem leitura antes de sugerir a foto manual. */
const SEGUNDOS_ATE_DICA = 8;

/** Intervalo entre fotos automáticas em alta resolução, feitas em paralelo ao vídeo. */
const INTERVALO_FOTO_ALTA_MS = 700;

/** Faixa central da mira, em fração do quadro. Usada tanto no CSS quanto no recorte da foto. */
const FAIXA_MIRA = { x: 0.08, y: 0.39, largura: 0.84, altura: 0.22 };

/** Depois dessas falhas seguidas que não sejam "não achei", desiste da foto automática. */
const LIMITE_FALHAS_FOTO_ALTA = 3;

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
  protected readonly fotoAltaAtiva = signal(false);

  private leitor?: BrowserMultiFormatReader;
  private controles?: IScannerControls;
  private dispositivos: Array<MediaDeviceInfo> = [];
  private indiceDispositivo = 0;
  private contador = 0;
  private relogioDica?: ReturnType<typeof setTimeout>;
  private relogioFotoAlta?: ReturnType<typeof setInterval>;
  private tirandoFotoAlta = false;

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

    if (trilha) {
      this.iniciarFotoAltaAutomatica(trilha);
    }
  }

  /**
   * Além de decodificar o vídeo ao vivo, tira fotos periódicas em segundo plano
   * pela ImageCapture API. A foto sai na resolução plena do sensor, muito acima
   * do stream de vídeo (que normalmente fica em 1080p mesmo em câmeras de 12MP+),
   * e é assim que os apps de banco leem um código de barras denso sem falhar.
   *
   * Nem todo navegador suporta (o Safari/iOS não suporta), então isso é um reforço
   * por cima da leitura do vídeo, nunca a única via.
   */
  private iniciarFotoAltaAutomatica(trilha: MediaStreamTrack): void {
    const Construtor = (window as unknown as { ImageCapture?: ConstrutorImageCapture }).ImageCapture;

    if (!Construtor) {
      return;
    }

    let capturador: FotografoDeQuadro;

    try {
      capturador = new Construtor(trilha);
    } catch {
      return;
    }

    let falhas = 0;
    this.fotoAltaAtiva.set(true);

    this.relogioFotoAlta = setInterval(async () => {
      if (this.tirandoFotoAlta || this.estado() !== 'lendo') {
        return;
      }

      this.tirandoFotoAlta = true;

      try {
        const blob = await capturador.takePhoto();
        const resultado = await this.decodificarFotoAlta(blob);

        if (resultado) {
          this.zone.run(() => this.leitura.emit(resultado));
          return;
        }

        falhas = 0;
      } catch (erro) {
        if (erro instanceof NotFoundException) {
          // Foto nítida, só que sem código de barras dentro do recorte. Segue tentando.
          falhas = 0;
        } else {
          falhas++;

          if (falhas >= LIMITE_FALHAS_FOTO_ALTA) {
            clearInterval(this.relogioFotoAlta);
            this.relogioFotoAlta = undefined;
            this.zone.run(() => this.fotoAltaAtiva.set(false));
          }
        }
      } finally {
        this.tirandoFotoAlta = false;
      }
    }, INTERVALO_FOTO_ALTA_MS);
  }

  /** Recorta a foto na mesma faixa mostrada na mira, para não perder tempo decodificando o fundo. */
  private async decodificarFotoAlta(foto: Blob): Promise<string | null> {
    if (!this.leitor) {
      return null;
    }

    const bitmap = await createImageBitmap(foto);

    try {
      const origemX = bitmap.width * FAIXA_MIRA.x;
      const origemY = bitmap.height * FAIXA_MIRA.y;
      const largura = bitmap.width * FAIXA_MIRA.largura;
      const altura = bitmap.height * FAIXA_MIRA.altura;

      const canvas = document.createElement('canvas');
      canvas.width = largura;
      canvas.height = altura;

      const contexto = canvas.getContext('2d');
      contexto?.drawImage(bitmap, origemX, origemY, largura, altura, 0, 0, largura, altura);

      const resultado = this.leitor.decodeFromCanvas(canvas);
      return resultado.getText();
    } catch (erro) {
      if (erro instanceof NotFoundException) {
        return null;
      }
      throw erro;
    } finally {
      bitmap.close?.();
    }
  }

  private encerrar(): void {
    clearTimeout(this.relogioDica);
    clearInterval(this.relogioFotoAlta);
    this.relogioFotoAlta = undefined;
    this.tirandoFotoAlta = false;
    this.fotoAltaAtiva.set(false);

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
