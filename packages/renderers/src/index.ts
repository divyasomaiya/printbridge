import { DocumentFormat } from '@print-bridge/shared';
import { IRenderer } from './types.js';
import { TextRenderer } from './textRenderer.js';
import { ImageRenderer } from './imageRenderer.js';
import { PdfRenderer } from './pdfRenderer.js';
import { OfficeRenderer } from './officeRenderer.js';
import { WebpageRenderer } from './webpageRenderer.js';

export class RendererRegistry {
  private readonly renderers: IRenderer[] = [];

  constructor() {
    this.register(new PdfRenderer());
    this.register(new ImageRenderer());
    this.register(new TextRenderer());
    this.register(new OfficeRenderer(false));
    this.register(new WebpageRenderer());
  }

  register(renderer: IRenderer): void {
    this.renderers.push(renderer);
  }

  findRenderer(format: DocumentFormat): IRenderer | undefined {
    return this.renderers.find(r => r.canRender(format));
  }

  getAllRenderers(): readonly IRenderer[] {
    return this.renderers;
  }
}

export * from './types.js';
export * from './textRenderer.js';
export * from './imageRenderer.js';
export * from './pdfRenderer.js';
export * from './officeRenderer.js';
export * from './webpageRenderer.js';
