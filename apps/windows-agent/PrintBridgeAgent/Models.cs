namespace PrintBridgeAgent.Models;

public record PrintSettings(
    int Copies,
    string Orientation,
    string PaperSize,
    string PageRangeType,
    string? CustomPageRanges,
    string Duplex,
    string ColorMode,
    string Scaling,
    bool Collate,
    string[]? SelectedSheets,
    string? SelectedSlides
);

public record PrintJob(
    string Id,
    string TenantId,
    string UserId,
    string UserEmail,
    string PrinterId,
    string PrinterName,
    string OriginalFileName,
    long FileSizeBytes,
    string FileFormat,
    string MimeType,
    string R2StorageKey,
    PrintSettings Settings,
    string Status,
    string? StatusMessage,
    string? ClaimedByAgentId,
    long? LeaseExpiresAt,
    long CreatedAt,
    long UpdatedAt
);

public record AgentConfig(
    string ApiBaseUrl,
    string AgentKey,
    string AgentId,
    string TargetPrinterUncPath,
    string TempDirectory,
    int PollIntervalSeconds,
    bool DryRun,
    bool MockPrinter
);
