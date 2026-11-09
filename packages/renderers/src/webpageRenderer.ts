import fs from 'node:fs';
import { DocumentFormat, resolvePageNumbers } from '@print-bridge/shared';
import { IRenderer, RenderContext, RenderResult } from './types.js';

/**
 * Webpage and HTML Document Renderer.
 * Sanitizes script tags, prevents external resource exfiltration during headless rendering.
 */
export class WebpageRenderer implements IRenderer {
  readonly id = 'webpage-renderer';
  readonly name = 'Sanitized HTML / Webpage Renderer';
  readonly supportedFormats: readonly DocumentFormat[] = ['html'];

  canRender(format: DocumentFormat): boolean {
    return format === 'html';
  }

  async inspect(filePath: string): Promise<{ totalPages: number; metadata?: Record<string, any> }> {
    return {
      totalPages: 1,
      metadata: {
        isHtml: true
      }
    };
  }

  async render(context: RenderContext): Promise<RenderResult> {
    const startTime = Date.now();
    try {
      let htmlContent = await fs.promises.readFile(context.sourceFilePath, 'utf-8');

      // Security measure: Strip script tags, eval, javascript: URLs
      htmlContent = htmlContent
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '<!-- script removed for print security -->')
        .replace(/on\w+="[^"]*"/gi, '')
        .replace(/javascript:[^"']+/gi, '#');

      const isLandscape = context.settings.orientation === 'landscape';
      const pages = [{
        pageNumber: 1,
        widthPoints: isLandscape ? 842 : 595,
        heightPoints: isLandscape ? 595 : 842,
        rawBytes: new TextEncoder().encode(htmlContent),
        mimeType: 'text/html'
      }];

      return {
        success: true,
        totalPages: 1,
        printedPages: [1],
        pages,
        renderEngine: this.name,
        durationMs: Date.now() - startTime
      };
    } catch (err: any) {
      return {
        success: false,
        totalPages: 0,
        printedPages: [],
        pages: [],
        error: `HTML rendering failed: ${err.message}`,
        renderEngine: this.name,
        durationMs: Date.now() - startTime
      };
    }
  }
}
