import fs from 'node:fs';
import { DocumentFormat, resolvePageNumbers } from '@print-bridge/shared';
import { IRenderer, RenderContext, RenderResult } from './types.js';

export class ImageRenderer implements IRenderer {
  readonly id = 'image-renderer';
  readonly name = 'Raster Image Renderer';
  readonly supportedFormats: readonly DocumentFormat[] = [
    'jpg',
    'jpeg',
    'png',
    'bmp',
    'webp',
    'tif',
    'tiff'
  ];

  canRender(format: DocumentFormat): boolean {
    return this.supportedFormats.includes(format);
  }

  async inspect(filePath: string): Promise<{ totalPages: number; metadata?: Record<string, any> }> {
    const stat = await fs.promises.stat(filePath);
    return {
      totalPages: 1, // Standard raster images are single-page printouts
      metadata: {
        fileSizeBytes: stat.size
      }
    };
  }

  async render(context: RenderContext): Promise<RenderResult> {
    const startTime = Date.now();
    try {
      const inspectRes = await this.inspect(context.sourceFilePath);
      const totalPages = inspectRes.totalPages;

      const pageRes = resolvePageNumbers(
        context.settings.pageRangeType,
        context.settings.customPageRanges,
        totalPages
      );

      if (!pageRes.success) {
        return {
          success: false,
          totalPages,
          printedPages: [],
          pages: [],
          error: pageRes.error,
          renderEngine: this.name,
          durationMs: Date.now() - startTime
        };
      }

      const rawBytes = await fs.promises.readFile(context.sourceFilePath);
      const isLandscape = context.settings.orientation === 'landscape';

      const pages = [{
        pageNumber: 1,
        widthPoints: isLandscape ? 842 : 595,
        heightPoints: isLandscape ? 595 : 842,
        rawBytes: new Uint8Array(rawBytes),
        mimeType: 'image/png' // normalized raster stream
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
        error: `Image rendering failed: ${err.message}`,
        renderEngine: this.name,
        durationMs: Date.now() - startTime
      };
    }
  }
}
