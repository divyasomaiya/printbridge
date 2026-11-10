using System.Diagnostics;
using System.Runtime.InteropServices;
using PrintBridgeAgent.Models;

namespace PrintBridgeAgent.Spooler;

public interface IPrinterSpooler
{
    bool IsPrinterAvailable(string printerPath);
    SpoolResult SubmitSpoolJob(string printerPath, string jobDocName, byte[] rawPayload, PrintSettings settings);
}

/// <summary>
/// Driver-level printing abstraction for documents requiring GDI/Windows driver rendering
/// rather than raw byte stream spooling.
/// </summary>
public interface IDriverPrinter
{
    DriverPrintResult PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings);
}

public record SpoolResult(bool Success, string? SpoolJobId, string? Message);
public record DriverPrintResult(bool Success, bool PhysicalPrintConfirmed, string Message);

/// <summary>
/// Diagnostic in-memory mock spooler for automated tests, CI, and dry-run testing.
/// Does not invoke winspool.drv or hardware.
/// </summary>
public class MockSpooler : IPrinterSpooler, IDriverPrinter
{
    public List<(string Printer, string DocName, int BytesLength)> SpooledJobs { get; } = new();
    public List<(string Printer, string DocName, string Format, PrintSettings Settings)> DriverJobs { get; } = new();

    public bool IsPrinterAvailable(string printerPath) => true;

    public SpoolResult SubmitSpoolJob(string printerPath, string jobDocName, byte[] rawPayload, PrintSettings settings)
    {
        SpooledJobs.Add((printerPath, jobDocName, rawPayload.Length));
        return new SpoolResult(true, $"mock-spool-{Guid.NewGuid()}", $"Mock spooler accepted {rawPayload.Length} bytes for {printerPath}");
    }

    public DriverPrintResult PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings)
    {
        DriverJobs.Add((printerPath, docName, format, settings));
        return new DriverPrintResult(true, false, $"Mock driver accepted {docName} for {printerPath}");
    }
}

/// <summary>
/// Windows driver-level printing bridge using Windows shell print-to verb.
///
/// HARDWARE-UNTESTED NOTICE:
/// 1. Windows shell 'printto' execution delegates to whatever default application is registered
///    for that file extension on the local Windows gateway (e.g. Acrobat Reader, Word, Excel, Photo Viewer).
/// 2. If the gateway machine does not have an associated printto handler for a given extension,
///    Process.Start will throw Win32Exception (No application associated).
/// 3. Standard 'printto' does NOT programmatically guarantee custom print settings (e.g. custom page ranges,
///    n-up, scaling) are accepted by third-party viewer applications without dedicated COM/CLI automation.
/// 4. A successful process exit code (0) only confirms that the associated application closed without error.
///    It DOES NOT confirm that the HP LaserJet M1136 physically drew paper or completed the print cycle.
/// </summary>
public class WindowsDriverPrinter : IDriverPrinter
{
    private static readonly HashSet<string> CandidatePrinttoFormats = new(StringComparer.OrdinalIgnoreCase)
    {
        "pdf", "txt", "doc", "docx", "rtf", "xls", "xlsx", "ppt", "pptx", "jpg", "jpeg", "png", "bmp", "tif", "tiff"
    };

    public DriverPrintResult PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new DriverPrintResult(false, false, "Windows driver printing is only supported on Windows OS.");
        }

        if (!CandidatePrinttoFormats.Contains(format))
        {
            return new DriverPrintResult(false, false, $"Unsupported format '{format}'. No candidate driver printto handler recognized.");
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = filePath,
                Verb = "printto",
                Arguments = $"\"{printerPath}\"",
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                UseShellExecute = true
            };

            using var proc = Process.Start(psi);
            if (proc != null)
            {
                // Enforce safety timeout (30 seconds maximum)
                if (!proc.WaitForExit(30000))
                {
                    try { proc.Kill(); } catch { }
                    return new DriverPrintResult(false, false, $"Timed out (30s) waiting for Windows driver print process for {docName}.");
                }

                if (proc.ExitCode == 0)
                {
                    // ACCURATE STATUS REPORTING:
                    // Process exiting with code 0 confirms acceptance by associated application / driver,
                    // NOT confirmed physical paper discharge from printer hardware.
                    return new DriverPrintResult(true, false, $"Driver handoff complete for {docName} on {printerPath}. Physical printing pending in Windows spooler.");
                }
                return new DriverPrintResult(false, false, $"Windows driver process exited with non-zero code {proc.ExitCode}.");
            }

            return new DriverPrintResult(false, false, $"Failed to launch driver print process for {docName}.");
        }
        catch (System.ComponentModel.Win32Exception w32Ex)
        {
            return new DriverPrintResult(false, false, $"Driver printto association error for '{format}': {w32Ex.Message}. Gateway requires an installed viewer application for this format.");
        }
        catch (Exception ex)
        {
            return new DriverPrintResult(false, false, $"Windows driver execution exception: {ex.Message}");
        }
    }
}

/// <summary>
/// Direct Windows Spooler API wrapper using winspool.drv.
/// Compatible with Windows 7 SP1 and Windows 10.
/// </summary>
public class WindowsSpooler : IPrinterSpooler
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DOCINFO1
    {
        public string pDocName;
        public string? pOutputFile;
        public string? pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFO1 pDocInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public bool IsPrinterAvailable(string printerPath)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return false;
        }

        IntPtr hPrinter;
        if (OpenPrinter(printerPath, out hPrinter, IntPtr.Zero))
        {
            ClosePrinter(hPrinter);
            return true;
        }
        return false;
    }

    public SpoolResult SubmitSpoolJob(string printerPath, string jobDocName, byte[] rawPayload, PrintSettings settings)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new SpoolResult(false, null, "Native Windows Spooler is only available on Windows OS.");
        }

        IntPtr hPrinter = IntPtr.Zero;
        try
        {
            if (!OpenPrinter(printerPath, out hPrinter, IntPtr.Zero))
            {
                int err = Marshal.GetLastWin32Error();
                return new SpoolResult(false, null, $"OpenPrinter failed for '{printerPath}' with Win32 error code {err}.");
            }

            var di = new DOCINFO1
            {
                pDocName = jobDocName,
                pDataType = "RAW"
            };

            int printJobId = StartDocPrinter(hPrinter, 1, ref di);
            if (printJobId == 0)
            {
                int err = Marshal.GetLastWin32Error();
                return new SpoolResult(false, null, $"StartDocPrinter failed with Win32 error code {err}.");
            }

            if (!StartPagePrinter(hPrinter))
            {
                int err = Marshal.GetLastWin32Error();
                EndDocPrinter(hPrinter);
                return new SpoolResult(false, null, $"StartPagePrinter failed with Win32 error code {err}.");
            }

            bool writeOk = WritePrinter(hPrinter, rawPayload, rawPayload.Length, out int bytesWritten);
            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);

            if (!writeOk || bytesWritten != rawPayload.Length)
            {
                return new SpoolResult(false, null, $"WritePrinter incomplete: wrote {bytesWritten} of {rawPayload.Length} bytes.");
            }

            return new SpoolResult(true, printJobId.ToString(), $"Successfully submitted {bytesWritten} bytes to Windows Spooler (Job #{printJobId}).");
        }
        catch (Exception ex)
        {
            return new SpoolResult(false, null, $"Spooling exception: {ex.Message}");
        }
        finally
        {
            if (hPrinter != IntPtr.Zero)
            {
                ClosePrinter(hPrinter);
            }
        }
    }
}
