import fs from 'node:fs';
import { DocumentFormat, resolvePageNumbers } from '@print-bridge/shared';
import { IRenderer, RenderContext, RenderResult } from './types.js';

export class PdfRenderer implements IRenderer {
  readonly id = 'pdf-renderer';
  readonly name = 'Portable Document Format (PDF) Renderer';
  readonly supportedFormats: readonly DocumentFormat[] = ['pdf'];

  canRender(format: DocumentFormat): boolean {
    return format === 'pdf';
  }

  /**
   * Safe PDF inspector that counts page objects (/Type /Page) without executing JavaScript or forms.
   */
  async inspect(filePath: string): Promise<{ totalPages: number; metadata?: Record<string, any> }> {
    const buffer = await fs.promises.readFile(filePath);
    const content = buffer.toString('binary');

    // Safe regex count of /Type\s*\/Page\b (not /Pages)
    const pageMatches = content.match(/\/Type\s*\/Page\b/g);
    let totalPages = pageMatches ? pageMatches.length : 1;

    // Alternative: check /Count in catalog
    const countMatch = content.match(/\/Pages[\s\S]*?\/Count\s+(\d+)/);
    if (countMatch && parseInt(countMatch[1], 10) > 0) {
      totalPages = parseInt(countMatch[1], 10);
    }

    totalPages = Math.max(1, totalPages);
    return {
      totalPages,
      metadata: {
        pdfHeader: content.substring(0, 10).trim(),
        detectedPages: totalPages
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

      // In unattended printing, PDF is delivered as individual page spools or full document spool
      const isLandscape = context.settings.orientation === 'landscape';
      const pages = pageRes.pages.map(pageNum => ({
        pageNumber: pageNum,
        widthPoints: isLandscape ? 842 : 595,
        heightPoints: isLandscape ? 595 : 842,
        rawBytes: new Uint8Array(rawBytes),
        mimeType: 'application/pdf'
      }));

      return {
        success: true,
        totalPages,
        printedPages: pageRes.pages,
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
        error: `PDF rendering failed: ${err.message}`,
        renderEngine: this.name,
        durationMs: Date.now() - startTime
      };
    }
  }
}
