export type DocumentFormat =
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'rtf'
  | 'xls'
  | 'xlsx'
  | 'csv'
  | 'ppt'
  | 'pptx'
  | 'jpg'
  | 'jpeg'
  | 'png'
  | 'bmp'
  | 'webp'
  | 'tif'
  | 'tiff'
  | 'txt'
  | 'html';

export type JobStatus =
  | 'pending'
  | 'claimed'
  | 'rendering'
  | 'spooling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type Orientation = 'portrait' | 'landscape';
export type PaperSize = 'a4' | 'letter' | 'legal';
export type DuplexMode = 'simplex' | 'duplex_long_edge' | 'duplex_short_edge' | 'manual_duplex';
export type ColorMode = 'grayscale' | 'color';
export type PageRangeType = 'all' | 'custom' | 'odd' | 'even';
export type ScalingMode = 'fit' | 'fill' | 'actual';

export interface PrintSettings {
  copies: number; // 1 to 99
  orientation: Orientation;
  paperSize: PaperSize;
  pageRangeType: PageRangeType;
  customPageRanges?: string; // e.g. "1-5, 8, 11-13"
  duplex: DuplexMode;
  colorMode: ColorMode;
  scaling: ScalingMode;
  collate: boolean;
  selectedSheets?: string[]; // for spreadsheets (e.g. ['Sheet1', 'Sheet2'])
  selectedSlides?: string;   // for presentations (e.g. '1-10')
}

export interface PrinterCapability {
  id: string;
  name: string;
  host: string; // e.g. "SILVERTOUCH-PC" or local gateway
  shareName: string; // e.g. "HP LaserJet Professional M1136 MFP"
  fullUncPath: string; // e.g. "\\SILVERTOUCH-PC\HP LaserJet Professional M1136 MFP"
  isOnline: boolean;
  supportsColor: boolean;
  supportsAutoDuplex: boolean;
  supportsManualDuplex: boolean;
  supportedPaperSizes: PaperSize[];
  maxCopies: number;
  description: string;
}

export interface PrintJob {
  id: string;
  tenantId: string;
  userId: string;
  userEmail: string;
  printerId: string;
  printerName: string;
  originalFileName: string;
  fileSizeBytes: number;
  fileFormat: DocumentFormat;
  mimeType: string;
  r2StorageKey: string;
  settings: PrintSettings;
  status: JobStatus;
  statusMessage?: string;
  claimedByAgentId?: string;
  leaseExpiresAt?: number; // Unix timestamp ms
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ClaimJobRequest {
  agentId: string;
  agentVersion: string;
  supportedPrinters: string[];
  leaseDurationSeconds?: number;
}

export interface ClaimJobResponse {
  job: PrintJob | null;
  downloadUrl?: string;
  leaseToken?: string;
}

export interface UpdateJobStatusRequest {
  jobId: string;
  agentId: string;
  leaseToken: string;
  status: JobStatus;
  statusMessage?: string;
  errorCode?: string;
}
