using PrintBridgeAgent.Models;
using PrintBridgeAgent.Spooler;

namespace PrintBridgeAgent;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.WriteLine("=================================================");
        Console.WriteLine("  Print Bridge by DTC — Windows Print Gateway    ");
        Console.WriteLine("=================================================");

        bool dryRun = args.Contains("--dry-run");
        bool mockPrinter = args.Contains("--mock-printer");
        bool diagnose = args.Contains("--diagnose");
        bool listPrinters = args.Contains("--list-printers");

        string? apiBaseUrl = Environment.GetEnvironmentVariable("PB_API_URL");
        string? agentKey = Environment.GetEnvironmentVariable("PB_AGENT_KEY");
        string agentId = Environment.GetEnvironmentVariable("PB_AGENT_ID") ?? $"gw-{Environment.MachineName}";
        string printerUnc = Environment.GetEnvironmentVariable("PB_PRINTER_UNC") ?? @"\\OFFICE-HOST\HP_LaserJet_M1136";
        string tempDir = Environment.GetEnvironmentVariable("PB_TEMP_DIR") ?? Path.Combine(Path.GetTempPath(), "PrintBridgeTemp");

        if (listPrinters)
        {
            Console.WriteLine("Configured target printer:");
            Console.WriteLine($"  UNC Path: {printerUnc}");
            Console.WriteLine($"  Status Check: Available via Spooler API");
            return 0;
        }

        if (diagnose)
        {
            Console.WriteLine("[DIAGNOSTICS]");
            Console.WriteLine($"  Machine Name:     {Environment.MachineName}");
            Console.WriteLine($"  OS Version:       {Environment.OSVersion}");
            Console.WriteLine($"  64-bit Process:   {Environment.Is64BitProcess}");
            Console.WriteLine($"  API Endpoint:     {apiBaseUrl ?? "(NOT CONFIGURED)"}");
            Console.WriteLine($"  Agent Key Set:    {!string.IsNullOrEmpty(agentKey)}");
            Console.WriteLine($"  Sandbox Path:     {tempDir}");
            Console.WriteLine($"  Target Printer:   {printerUnc}");
            Console.WriteLine($"  Dry Run Mode:     {dryRun}");
            Console.WriteLine($"  Mock Printer:     {mockPrinter}");

            var spooler = mockPrinter ? (IPrinterSpooler)new MockSpooler() : new WindowsSpooler();
            bool printerOk = spooler.IsPrinterAvailable(printerUnc);
            Console.WriteLine($"  Printer Reachable: {(printerOk || mockPrinter ? "YES" : "NO (Check network/sharing)")}");
            return 0;
        }

        // P0 Security requirement: Fail closed if credentials or API URL are not configured
        if (string.IsNullOrWhiteSpace(apiBaseUrl) || string.IsNullOrWhiteSpace(agentKey))
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("FATAL ERROR: Missing required configuration.");
            Console.WriteLine("PB_API_URL and PB_AGENT_KEY must be provided via environment variables.");
            Console.WriteLine("Example:");
            Console.WriteLine("  set PB_API_URL=https://print.dtc.local");
            Console.WriteLine("  set PB_AGENT_KEY=your_secure_agent_key");
            Console.ResetColor();
            return 1;
        }

        var config = new AgentConfig(
            ApiBaseUrl: apiBaseUrl,
            AgentKey: agentKey,
            AgentId: agentId,
            TargetPrinterUncPath: printerUnc,
            TempDirectory: tempDir,
            PollIntervalSeconds: 5,
            DryRun: dryRun,
            MockPrinter: mockPrinter
        );

        var worker = new AgentWorker(config);

        Console.WriteLine($"Gateway agent initialized. Mode: {(dryRun ? "DRY-RUN" : "LIVE")}, Printer: {(mockPrinter ? "MOCK" : printerUnc)}");
        Console.WriteLine($"Sandbox isolated to: {config.TempDirectory}");
        Console.WriteLine("Press Ctrl+C to terminate.");

        // Single run or loop
        if (args.Contains("--single-poll"))
        {
            await worker.ProcessNextJobAsync();
            return 0;
        }

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        while (!cts.Token.IsCancellationRequested)
        {
            try
            {
                await worker.ProcessNextJobAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Polling cycle exception: {ex.Message}");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(config.PollIntervalSeconds), cts.Token);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }

        Console.WriteLine("Agent stopped cleanly.");
        return 0;
    }
}
