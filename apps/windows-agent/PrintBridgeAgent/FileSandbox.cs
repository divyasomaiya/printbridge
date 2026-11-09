namespace PrintBridgeAgent.Security;

/// <summary>
/// Strictly confines file operations to an approved, dedicated temporary directory.
/// Enforces path traversal prevention, symlink/junction rejection, and safe cleanup.
/// Under NO circumstances will this class touch or inspect any company shares or unrelated drives.
/// </summary>
public class FileSandbox
{
    private readonly string _allowedRoot;

    public FileSandbox(string allowedRoot)
    {
        _allowedRoot = Path.GetFullPath(allowedRoot);
        if (!Directory.Exists(_allowedRoot))
        {
            Directory.CreateDirectory(_allowedRoot);
        }
    }

    public string AllowedRoot => _allowedRoot;

    public string CreateJobWorkingDir(string jobId)
    {
        // Sanitize jobId to alphanumeric and hyphens
        var safeJobId = System.Text.RegularExpressions.Regex.Replace(jobId, @"[^a-zA-Z0-9_\-]", "");
        var jobDir = Path.Combine(_allowedRoot, safeJobId);
        var fullPath = Path.GetFullPath(jobDir);

        AssertPathSafe(fullPath);

        if (!Directory.Exists(fullPath))
        {
            Directory.CreateDirectory(fullPath);
        }

        return fullPath;
    }

    public string ResolveSafeFilePath(string jobWorkingDir, string filename)
    {
        var safeFileName = Path.GetFileName(filename); // strips directory traversal components
        var fullPath = Path.GetFullPath(Path.Combine(jobWorkingDir, safeFileName));

        AssertPathSafe(fullPath);
        return fullPath;
    }

    public void AssertPathSafe(string candidatePath)
    {
        var fullCandidate = Path.GetFullPath(candidatePath);

        // Ensure candidatePath starts with _allowedRoot
        if (!fullCandidate.StartsWith(_allowedRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Path '{candidatePath}' is outside the sandbox '{_allowedRoot}'. Access denied.");
        }

        // Symlink / Junction check if path exists
        if (File.Exists(fullCandidate) || Directory.Exists(fullCandidate))
        {
            var attributes = File.GetAttributes(fullCandidate);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Symlink or junction point detected at '{fullCandidate}'. Access denied.");
            }
        }
    }

    public void SecureCleanup(string jobWorkingDir)
    {
        AssertPathSafe(jobWorkingDir);
        if (Directory.Exists(jobWorkingDir))
        {
            Directory.Delete(jobWorkingDir, recursive: true);
        }
    }
}
