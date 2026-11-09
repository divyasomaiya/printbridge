using System.Text;
using System.Text.Json;
using PrintBridgeAgent.Models;
using PrintBridgeAgent.Security;
using PrintBridgeAgent.Spooler;

namespace PrintBridgeAgent;

public class AgentWorker
{
    private readonly AgentConfig _config;
    private readonly FileSandbox _sandbox;
    private readonly IPrinterSpooler _spooler;
    private readonly HttpClient _httpClient;

    public AgentWorker(AgentConfig config, IPrinterSpooler? spooler = null, HttpClient? httpClient = null)
    {
        _config = config;
        _sandbox = new FileSandbox(config.TempDirectory);
        _spooler = spooler ?? (config.MockPrinter ? new MockSpooler() : new WindowsSpooler());
        _httpClient = httpClient ?? new HttpClient { BaseAddress = new Uri(config.ApiBaseUrl) };
        if (!string.IsNullOrEmpty(config.AgentKey))
        {
            _httpClient.DefaultRequestHeaders.Add("X-Agent-Key", config.AgentKey);
        }
    }

    public FileSandbox Sandbox => _sandbox;
    public IPrinterSpooler Spooler => _spooler;

    /// <summary>
    /// Executes a single polling and processing cycle.
    /// Safe, unattended, idempotent.
    /// </summary>
    public async Task<bool> ProcessNextJobAsync()
    {
        Console.WriteLine($"[{DateTime.UtcNow:s}] Polling for jobs from {_config.ApiBaseUrl}...");

        PrintJob? job = null;
        string? leaseToken = null;
        string? downloadUrl = null;

        try
        {
            var claimRequest = new
            {
                agentId = _config.AgentId,
                agentVersion = "1.0.0",
                supportedPrinters = new[] { "hp-laserjet-m1136", "mock-printer-test" },
                leaseDurationSeconds = 120
            };

            var claimContent = new StringContent(JsonSerializer.Serialize(claimRequest), Encoding.UTF8, "application/json");
            var claimResponse = await _httpClient.PostAsync("/api/agent/claim", claimContent);

            if (!claimResponse.IsSuccessStatusCode)
            {
                Console.WriteLine($"Claim API returned status {claimResponse.StatusCode}");
                return false;
            }

            var claimJson = await claimResponse.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(claimJson);
            var root = doc.RootElement;

            if (!root.TryGetProperty("job", out var jobElem) || jobElem.ValueKind == JsonValueKind.Null)
            {
                Console.WriteLine("No pending jobs found in queue.");
                return false;
            }

            // Extract job info
            var jobId = jobElem.GetProperty("id").GetString()!;
            var filename = jobElem.GetProperty("originalFileName").GetString()!;
            var format = jobElem.GetProperty("fileFormat").GetString()!;
            var printerId = jobElem.GetProperty("printerId").GetString()!;

            if (root.TryGetProperty("leaseToken", out var ltElem))
            {
                leaseToken = ltElem.GetString();
            }
            if (root.TryGetProperty("downloadUrl", out var dlElem))
            {
                downloadUrl = dlElem.GetString();
            }

            Console.WriteLine($"Claimed Job {jobId} ({filename}, format: {format}) for printer {printerId}");

            // Process job within safe sandbox
            var workingDir = _sandbox.CreateJobWorkingDir(jobId);
            try
            {
                var safeTargetFile = _sandbox.ResolveSafeFilePath(workingDir, filename);

                // Download document safely
                if (string.IsNullOrEmpty(downloadUrl))
                {
                    // Fail closed if downloadUrl is missing: NEVER substitute fake bytes in production
                    string dlError = "CRITICAL: API provided no download URL for claimed job.";
                    Console.WriteLine($"[ERROR] {dlError}");
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "failed", dlError);
                    return false;
                }

                var dlResponse = await _httpClient.GetAsync(downloadUrl);
                if (!dlResponse.IsSuccessStatusCode)
                {
                    string dlFailMsg = $"Failed to download document from storage: HTTP {dlResponse.StatusCode}";
                    Console.WriteLine($"[ERROR] {dlFailMsg}");
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "failed", dlFailMsg);
                    return false;
                }

                var fileBytes = await dlResponse.Content.ReadAsByteArrayAsync();
                await File.WriteAllBytesAsync(safeTargetFile, fileBytes);

                // Verify file size inside sandbox
                var fileInfo = new FileInfo(safeTargetFile);
                if (fileInfo.Length > 50 * 1024 * 1024)
                {
                    throw new InvalidOperationException("File exceeds maximum safe size (50 MB).");
                }

                // Parse print settings
                var settings = new PrintSettings(1, "portrait", "a4", "all", null, "simplex", "grayscale", "fit", true, null, null);
                if (jobElem.TryGetProperty("settings", out var sElem))
                {
                    settings = new PrintSettings(
                        Copies: sElem.TryGetProperty("copies", out var c) ? c.GetInt32() : 1,
                        Orientation: sElem.TryGetProperty("orientation", out var o) ? o.GetString() ?? "portrait" : "portrait",
                        PaperSize: sElem.TryGetProperty("paperSize", out var p) ? p.GetString() ?? "a4" : "a4",
                        PageRangeType: sElem.TryGetProperty("pageRangeType", out var pr) ? pr.GetString() ?? "all" : "all",
                        CustomPageRanges: sElem.TryGetProperty("customPageRanges", out var cpr) ? cpr.GetString() : null,
                        Duplex: sElem.TryGetProperty("duplex", out var d) ? d.GetString() ?? "simplex" : "simplex",
                        ColorMode: sElem.TryGetProperty("colorMode", out var cm) ? cm.GetString() ?? "grayscale" : "grayscale",
                        Scaling: sElem.TryGetProperty("scaling", out var sc) ? sc.GetString() ?? "fit" : "fit",
                        Collate: sElem.TryGetProperty("collate", out var col) && col.GetBoolean(),
                        SelectedSheets: null,
                        SelectedSlides: null
                    );
                }

                var targetPrinter = _config.MockPrinter ? "MockPrinter" : _config.TargetPrinterUncPath;

                // CRITICAL SAFETY CHECK:
                // Dry-run mode must NEVER report a print job as 'completed' on the server.
                if (_config.DryRun)
                {
                    string dryRunMessage = $"[DRY RUN] Verified job {jobId} ({filename}, {fileBytes.Length} bytes). Settings: Copies={settings.Copies}, Orientation={settings.Orientation}, Range={settings.PageRangeType}. Spool submission skipped.";
                    Console.WriteLine(dryRunMessage);
                    // Leave job as claimed or report failed with dry-run notice so physical printer is never assumed complete
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "failed", "Dry-run verification completed (physical printing intentionally skipped).");
                    return true;
                }

                // CRITICAL PRINT ARCHITECTURE CHECK:
                // RAW spooling requires pre-rendered printer-ready PDL (Page Description Language) streams
                // such as PCL, PostScript, or Windows EMF. Sending raw PDF, Word, Excel, or image files
                // directly to a GDI/RAW queue on an HP LaserJet M1136 will output raw ASCII garbage or error out.
                //
                // In this MVP foundation:
                // - Only raw PCL or text formatted through driver can be sent directly to spooler.
                // - Non-text binary documents (PDF, Office, Images) must be rendered via a dedicated rendering engine
                //   (e.g., PDFium/Ghostscript/LibreOffice or GDI PrintDocument) into PCL6/raster before live physical spooling.
                // - If live physical printing is attempted without an active document rendering engine,
                //   the job is rejected safely rather than wasting paper with garbage text.

                bool isRawPrinterReady = format == "txt" || format == "pcl" || format == "raw";

                if (!isRawPrinterReady && !_config.MockPrinter)
                {
                    string renderLimitationNotice = $"FORMAT_NOT_RENDERED: Format '{format}' requires a configured rasterizer/engine (e.g. PDFium/Ghostscript/LibreOffice) to produce PCL for the HP LaserJet M1136. Raw bytes cannot be safely spooled to physical printer.";
                    Console.WriteLine($"[RENDER_CHECK] {renderLimitationNotice}");
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "failed", renderLimitationNotice);
                    return false;
                }

                byte[] spoolPayload = await File.ReadAllBytesAsync(safeTargetFile);

                // Submit to Spooler
                var spoolRes = _spooler.SubmitSpoolJob(targetPrinter, $"PrintBridge_{jobId}_{filename}", spoolPayload, settings);

                if (spoolRes.Success)
                {
                    Console.WriteLine($"Spooler acceptance confirmed: {spoolRes.Message}");
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "completed", spoolRes.Message ?? "Job spooled to printer.");
                }
                else
                {
                    Console.WriteLine($"Spooler rejection: {spoolRes.Message}");
                    await UpdateStatusAsync(jobId, leaseToken ?? "", "failed", spoolRes.Message ?? "Spooler rejected job.");
                }

                return spoolRes.Success;
            }
            finally
            {
                // CRITICAL DATA SAFETY: Secure cleanup of temporary working directory immediately after processing
                _sandbox.SecureCleanup(workingDir);
                Console.WriteLine($"[SECURITY] Working directory {workingDir} securely wiped.");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error processing job: {ex.Message}");
            if (job != null && leaseToken != null)
            {
                await UpdateStatusAsync(job.Id, leaseToken, "failed", ex.Message);
            }
            return false;
        }
    }

    private async Task UpdateStatusAsync(string jobId, string leaseToken, string status, string message)
    {
        try
        {
            var statusUpdate = new
            {
                jobId,
                agentId = _config.AgentId,
                leaseToken,
                status,
                statusMessage = message
            };

            var content = new StringContent(JsonSerializer.Serialize(statusUpdate), Encoding.UTF8, "application/json");
            await _httpClient.PostAsync("/api/agent/status", content);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to update job status: {ex.Message}");
        }
    }
}
