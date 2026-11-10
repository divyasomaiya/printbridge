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
    private readonly IDriverPrinter? _driverPrinter;
    private readonly HttpClient _httpClient;

    public AgentWorker(AgentConfig config, IPrinterSpooler? spooler = null, HttpClient? httpClient = null, IDriverPrinter? driverPrinter = null)
    {
        _config = config;
        _sandbox = new FileSandbox(config.TempDirectory);
        _spooler = spooler ?? (config.MockPrinter ? new MockSpooler() : new WindowsSpooler());
        _driverPrinter = driverPrinter ?? (config.MockPrinter ? (IDriverPrinter)_spooler : new WindowsDriverPrinter());
        _httpClient = httpClient ?? new HttpClient { BaseAddress = new Uri(config.ApiBaseUrl) };
        if (!string.IsNullOrEmpty(config.AgentKey))
        {
            _httpClient.DefaultRequestHeaders.Add("X-Agent-Key", config.AgentKey);
        }
    }

    public FileSandbox Sandbox => _sandbox;
    public IPrinterSpooler Spooler => _spooler;
    public IDriverPrinter? DriverPrinter => _driverPrinter;

    /// <summary>
    /// Executes a single polling and processing cycle.
    /// Safe, unattended, idempotent.
    /// </summary>
    public async Task<bool> ProcessNextJobAsync()
    {
        Console.WriteLine($"[{DateTime.UtcNow:s}] Polling for jobs from {_config.ApiBaseUrl}...");

        string? claimedJobId = null;
        string? leaseToken = null;
        string? downloadUrl = null;

        try
        {
            // Dry-run mode exclusively targets diagnostic mock queues
            string[] supportedPrinters = _config.DryRun || _config.MockPrinter
                ? new[] { "mock-printer-test" }
                : new[] { "hp-laserjet-m1136", "mock-printer-test" };

            var claimRequest = new
            {
                agentId = _config.AgentId,
                agentVersion = "1.0.0",
                supportedPrinters,
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

            // Retain job identifiers across the entire execution scope
            claimedJobId = jobElem.GetProperty("id").GetString()!;
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

            Console.WriteLine($"Claimed Job {claimedJobId} ({filename}, format: {format}) for printer {printerId}");

            // Process job within safe sandbox
            var workingDir = _sandbox.CreateJobWorkingDir(claimedJobId);
            try
            {
                var safeTargetFile = _sandbox.ResolveSafeFilePath(workingDir, filename);

                // Download document safely
                if (string.IsNullOrEmpty(downloadUrl))
                {
                    string dlError = "CRITICAL: API provided no download URL for claimed job.";
                    Console.WriteLine($"[ERROR] {dlError}");
                    await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", dlError);
                    return false;
                }

                var dlResponse = await _httpClient.GetAsync(downloadUrl);
                if (!dlResponse.IsSuccessStatusCode)
                {
                    string dlFailMsg = $"Failed to download document from storage: HTTP {dlResponse.StatusCode}";
                    Console.WriteLine($"[ERROR] {dlFailMsg}");
                    await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", dlFailMsg);
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
                    string dryRunMessage = $"[DRY RUN] Verified job {claimedJobId} ({filename}, {fileBytes.Length} bytes). Settings: Copies={settings.Copies}, Orientation={settings.Orientation}, Range={settings.PageRangeType}. Spool submission skipped.";
                    Console.WriteLine(dryRunMessage);
                    await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", "Dry-run verification completed (physical printing intentionally skipped).");
                    return true;
                }

                // DRIVER-LEVEL PRINTING VS RAW SPOOLING:
                // RAW spooling is strictly confined to pre-rendered PCL/PRN files.
                // All other documents (PDF, Word, Excel, PowerPoint, Images, and text)
                // must be dispatched through the installed Windows printer driver.
                bool isPreRenderedPcl = format == "pcl" || format == "prn";

                if (isPreRenderedPcl)
                {
                    byte[] spoolPayload = await File.ReadAllBytesAsync(safeTargetFile);
                    var spoolRes = _spooler.SubmitSpoolJob(targetPrinter, $"PrintBridge_{claimedJobId}_{filename}", spoolPayload, settings);
                    if (spoolRes.Success)
                    {
                        Console.WriteLine($"Spooler acceptance confirmed: {spoolRes.Message}");
                        await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "completed", spoolRes.Message ?? "Job spooled to printer.");
                    }
                    else
                    {
                        Console.WriteLine($"Spooler rejection: {spoolRes.Message}");
                        await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", spoolRes.Message ?? "Spooler rejected job.");
                    }
                    return spoolRes.Success;
                }

                // Driver printing path (WindowsDriverPrinter on Windows OS)
                if (_driverPrinter != null)
                {
                    bool driverSuccess = _driverPrinter.PrintDocumentViaDriver(targetPrinter, $"PrintBridge_{claimedJobId}_{filename}", safeTargetFile, format, settings);
                    if (driverSuccess)
                    {
                        string msg = $"Driver accepted document {filename} for printer {targetPrinter} (Copies={settings.Copies})";
                        Console.WriteLine(msg);
                        await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "completed", msg);
                        return true;
                    }
                    else
                    {
                        string err = $"Driver failed to print document {filename}";
                        Console.WriteLine(err);
                        await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", err);
                        return false;
                    }
                }

                string unrenderedNotice = $"FORMAT_NOT_RENDERED: Format '{format}' requires driver rasterization (PDFium/GDI). Raw bytes blocked from HP LaserJet M1136.";
                Console.WriteLine($"[RENDER_CHECK] {unrenderedNotice}");
                await UpdateStatusAsync(claimedJobId, leaseToken ?? "", "failed", unrenderedNotice);
                return false;
            }
            finally
            {
                _sandbox.SecureCleanup(workingDir);
                Console.WriteLine($"[SECURITY] Working directory {workingDir} securely wiped.");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error processing job: {ex.Message}");
            if (!string.IsNullOrEmpty(claimedJobId) && !string.IsNullOrEmpty(leaseToken))
            {
                await UpdateStatusAsync(claimedJobId, leaseToken, "failed", ex.Message);
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
