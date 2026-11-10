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
    bool PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings);
}

public record SpoolResult(bool Success, string? SpoolJobId, string? Message);

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

    public bool PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings)
    {
        DriverJobs.Add((printerPath, docName, format, settings));
        return true;
    }
}

/// <summary>
/// Standard Windows driver-level printing using Windows shell print-to verb or process pipeline.
/// Leverages the installed Windows printer driver on the Windows 10 gateway without implementing custom drivers.
/// </summary>
public class WindowsDriverPrinter : IDriverPrinter
{
    public bool PrintDocumentViaDriver(string printerPath, string docName, string filePath, string format, PrintSettings settings)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            Console.WriteLine("[DRIVER_PRINT] Windows driver printing is only supported on Windows OS.");
            return false;
        }

        try
        {
            // Invoke the installed Windows application or shell print-to verb with the target printer name
            // Uses ShellExecute printto: "PrintTo <PrinterName>"
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
                    Console.WriteLine($"[DRIVER_PRINT] Timed out waiting for Windows print process for {docName}.");
                    return false;
                }
                return proc.ExitCode == 0;
            }

            return false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[DRIVER_PRINT] Windows driver execution exception: {ex.Message}");
            return false;
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
