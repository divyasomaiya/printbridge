import fs from 'node:fs';
import { DocumentFormat, resolvePageNumbers } from '@print-bridge/shared';
import { IRenderer, RenderContext, RenderResult } from './types.js';

export class TextRenderer implements IRenderer {
  readonly id = 'text-renderer';
  readonly name = 'Plain Text & CSV Document Renderer';
  readonly supportedFormats: readonly DocumentFormat[] = ['txt', 'csv'];

  canRender(format: DocumentFormat): boolean {
    return this.supportedFormats.includes(format);
  }

  async inspect(filePath: string): Promise<{ totalPages: number; metadata?: Record<string, any> }> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const linesPerPage = 55; // Standard A4 / Letter lines at 10pt with margins
    const totalPages = Math.max(1, Math.ceil(lines.length / linesPerPage));
    return {
      totalPages,
      metadata: {
        totalLines: lines.length,
        linesPerPage
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

      const content = await fs.promises.readFile(context.sourceFilePath, 'utf-8');
      const allLines = content.split(/\r?\n/);
      const linesPerPage = 55;

      const pages = pageRes.pages.map(pageNum => {
        const startLine = (pageNum - 1) * linesPerPage;
        const pageLines = allLines.slice(startLine, startLine + linesPerPage);
        const pageText = pageLines.join('\n');
        return {
          pageNumber: pageNum,
          widthPoints: 595, // A4 standard pt
          heightPoints: 842,
          rawBytes: new TextEncoder().encode(pageText),
          mimeType: 'text/plain'
        };
      });

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
        error: `Text rendering failed: ${err.message}`,
        renderEngine: this.name,
        durationMs: Date.now() - startTime
      };
    }
  }
}
