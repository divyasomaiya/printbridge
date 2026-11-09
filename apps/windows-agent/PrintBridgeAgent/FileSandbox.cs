using System.Text.RegularExpressions;

namespace PrintBridgeAgent.Security;

/// <summary>
/// Strictly confines file operations to an approved, dedicated temporary directory.
/// Enforces path traversal prevention, symlink/junction rejection, boundary validation, and safe cleanup.
/// Under NO circumstances will this class touch, inspect, or modify company shares or unrelated drives.
/// </summary>
public class FileSandbox
{
    private static readonly Regex SafeJobIdRegex = new(@"^[a-zA-Z0-9_\-]+$", RegexOptions.Compiled);
    private readonly string _allowedRoot;
    private readonly string _allowedRootWithTrailingSep;

    public FileSandbox(string allowedRoot)
    {
        if (string.IsNullOrWhiteSpace(allowedRoot))
        {
            throw new ArgumentException("Sandbox root directory cannot be empty.", nameof(allowedRoot));
        }

        _allowedRoot = Path.GetFullPath(allowedRoot);
        _allowedRootWithTrailingSep = _allowedRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                                      + Path.DirectorySeparatorChar;

        if (!Directory.Exists(_allowedRoot))
        {
            Directory.CreateDirectory(_allowedRoot);
        }

        // Validate that the sandbox root itself is safe from symlinks/reparse points
        AssertPathHierarchySafe(_allowedRoot);
    }

    public string AllowedRoot => _allowedRoot;

    public string CreateJobWorkingDir(string jobId)
    {
        if (string.IsNullOrWhiteSpace(jobId) || !SafeJobIdRegex.IsMatch(jobId))
        {
            throw new ArgumentException($"Invalid job ID '{jobId}'. Job IDs must be non-empty and contain only alphanumeric characters, underscores, or hyphens.", nameof(jobId));
        }

        var jobDir = Path.Combine(_allowedRoot, jobId);
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
        AssertJobDirectorySafe(jobWorkingDir);

        if (string.IsNullOrWhiteSpace(filename))
        {
            throw new ArgumentException("Filename cannot be empty.", nameof(filename));
        }

        var safeFileName = Path.GetFileName(filename);
        if (string.IsNullOrWhiteSpace(safeFileName) || safeFileName == "." || safeFileName == "..")
        {
            throw new ArgumentException($"Invalid filename '{filename}'.", nameof(filename));
        }

        var fullPath = Path.GetFullPath(Path.Combine(jobWorkingDir, safeFileName));
        AssertPathSafe(fullPath);
        return fullPath;
    }

    public void AssertPathSafe(string candidatePath)
    {
        if (string.IsNullOrWhiteSpace(candidatePath))
        {
            throw new ArgumentException("Path cannot be empty.", nameof(candidatePath));
        }

        var fullCandidate = Path.GetFullPath(candidatePath);

        // Exact root boundary check with trailing separator:
        // Must be inside _allowedRootWithTrailingSep (strictly a descendant) or equal to _allowedRoot
        if (!fullCandidate.Equals(_allowedRoot, StringComparison.OrdinalIgnoreCase) &&
            !fullCandidate.StartsWith(_allowedRootWithTrailingSep, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Path '{candidatePath}' is outside the sandbox root '{_allowedRoot}'. Access denied.");
        }

        AssertPathHierarchySafe(fullCandidate);
    }

    /// <summary>
    /// Inspects candidate path and every ancestor directory up to the filesystem root
    /// to ensure no reparse points (symlinks or directory junctions) exist.
    /// </summary>
    private void AssertPathHierarchySafe(string path)
    {
        var current = new DirectoryInfo(path);
        while (current != null && current.Exists)
        {
            if ((current.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Reparse point (symlink/junction) detected in path chain at '{current.FullName}'. Access denied.");
            }
            current = current.Parent;
        }

        if (File.Exists(path))
        {
            var fileInfo = new FileInfo(path);
            if ((fileInfo.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Reparse point (symlink) detected on file '{path}'. Access denied.");
            }
        }
    }

    /// <summary>
    /// Ensures candidate is an immediate child directory of the sandbox root and matches a valid job directory.
    /// Prevents deletion of the sandbox root itself or unrelated directories.
    /// </summary>
    public void AssertJobDirectorySafe(string jobWorkingDir)
    {
        var fullPath = Path.GetFullPath(jobWorkingDir);

        if (fullPath.Equals(_allowedRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("CRITICAL SECURITY VIOLATION: Attempt to clean up or delete the sandbox root itself.");
        }

        var parent = Path.GetDirectoryName(fullPath);
        if (parent == null || !parent.Equals(_allowedRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Directory '{jobWorkingDir}' is not a direct child of the sandbox root.");
        }

        var dirName = Path.GetFileName(fullPath);
        if (!SafeJobIdRegex.IsMatch(dirName))
        {
            throw new UnauthorizedAccessException($"CRITICAL SECURITY VIOLATION: Directory name '{dirName}' does not conform to valid job directory naming conventions.");
        }

        AssertPathSafe(fullPath);
    }

    public void SecureCleanup(string jobWorkingDir)
    {
        AssertJobDirectorySafe(jobWorkingDir);

        if (Directory.Exists(jobWorkingDir))
        {
            Directory.Delete(jobWorkingDir, recursive: true);
        }
    }
}
