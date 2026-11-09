import { DocumentFormat, PrintSettings } from '@print-bridge/shared';

export interface RenderContext {
  jobId: string;
  sourceFilePath: string;
  workingDir: string;
  settings: PrintSettings;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface RenderedPage {
  pageNumber: number;
  widthPoints: number;
  heightPoints: number;
  rawBytes: Uint8Array; // Raw EMF, PostScript, PCL, or raster payload
  mimeType: string;
}

export interface RenderResult {
  success: boolean;
  totalPages: number;
  printedPages: number[];
  pages: RenderedPage[];
  error?: string;
  renderEngine: string;
  durationMs: number;
  warnings?: string[];
}

export interface IRenderer {
  readonly id: string;
  readonly name: string;
  readonly supportedFormats: readonly DocumentFormat[];

  canRender(format: DocumentFormat): boolean;
  inspect(filePath: string): Promise<{ totalPages: number; metadata?: Record<string, any> }>;
  render(context: RenderContext): Promise<RenderResult>;
}
