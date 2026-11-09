using System.Text;
using PrintBridgeAgent.Models;
using PrintBridgeAgent.Security;
using PrintBridgeAgent.Spooler;
using Xunit;

namespace PrintBridgeAgent.Tests;

public class AgentTests
{
    [Fact]
    public void FileSandbox_RestrictsAccessToAllowedRoot()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "pb_test_sandbox_" + Guid.NewGuid());
        var sandbox = new FileSandbox(tempRoot);

        try
        {
            var jobDir = sandbox.CreateJobWorkingDir("job-123");
            Assert.StartsWith(tempRoot, jobDir);

            // Valid safe file path
            var safeFile = sandbox.ResolveSafeFilePath(jobDir, "document.pdf");
            Assert.StartsWith(jobDir, safeFile);

            // Directory traversal attempt: ../../etc/passwd
            var maliciousPath = Path.Combine(jobDir, "../../etc/passwd");
            Assert.Throws<UnauthorizedAccessException>(() =>
            {
                sandbox.AssertPathSafe(maliciousPath);
            });
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, true);
            }
        }
    }

    [Fact]
    public void FileSandbox_Adversarial_PreventsSiblingPrefixBypass()
    {
        var baseDir = Path.Combine(Path.GetTempPath(), "pb_sb_base_" + Guid.NewGuid());
        var allowedRoot = Path.Combine(baseDir, "PrintBridgeTemp");
        var siblingBypassPath = Path.Combine(baseDir, "PrintBridgeTemp2"); // Sibling prefix match

        Directory.CreateDirectory(allowedRoot);
        Directory.CreateDirectory(siblingBypassPath);

        try
        {
            var sandbox = new FileSandbox(allowedRoot);

            // Trying to assert or access the sibling directory must fail closed
            Assert.Throws<UnauthorizedAccessException>(() =>
            {
                sandbox.AssertPathSafe(siblingBypassPath);
            });

            Assert.Throws<UnauthorizedAccessException>(() =>
            {
                sandbox.AssertPathSafe(Path.Combine(siblingBypassPath, "secret.txt"));
            });
        }
        finally
        {
            if (Directory.Exists(baseDir))
            {
                Directory.Delete(baseDir, true);
            }
        }
    }

    [Fact]
    public void FileSandbox_Adversarial_RejectsEmptyAndMalformedJobIds()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "pb_jobid_test_" + Guid.NewGuid());
        var sandbox = new FileSandbox(tempRoot);

        try
        {
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir(""));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("   "));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("."));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir(".."));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("../../root"));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("job/123"));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("job\\123"));
            Assert.Throws<ArgumentException>(() => sandbox.CreateJobWorkingDir("job:123"));
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, true);
            }
        }
    }

    [Fact]
    public void FileSandbox_Adversarial_PreventsSandboxRootDeletion()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "pb_rootdel_test_" + Guid.NewGuid());
        var sandbox = new FileSandbox(tempRoot);

        try
        {
            // Direct attempt to cleanup the sandbox root itself
            Assert.Throws<UnauthorizedAccessException>(() => sandbox.SecureCleanup(tempRoot));
            Assert.Throws<UnauthorizedAccessException>(() => sandbox.SecureCleanup(tempRoot + Path.DirectorySeparatorChar));

            // Attempt to clean up parent or sibling
            Assert.Throws<UnauthorizedAccessException>(() => sandbox.SecureCleanup(Path.GetDirectoryName(tempRoot)!));
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, true);
            }
        }
    }

    [Fact]
    public void FileSandbox_SecureCleanup_RemovesJobDirectory()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "pb_cleanup_test_" + Guid.NewGuid());
        var sandbox = new FileSandbox(tempRoot);

        try
        {
            var jobDir = sandbox.CreateJobWorkingDir("job-456");
            var testFile = Path.Combine(jobDir, "temp_render.bin");
            File.WriteAllText(testFile, "temporary print data");
            Assert.True(File.Exists(testFile));

            sandbox.SecureCleanup(jobDir);
            Assert.False(Directory.Exists(jobDir));
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, true);
            }
        }
    }

    [Fact]
    public void MockSpooler_SubmitsAndRecordsSpoolJobs()
    {
        var mockSpooler = new MockSpooler();
        var settings = new PrintSettings(1, "portrait", "a4", "all", null, "simplex", "grayscale", "fit", true, null, null);
        var payload = Encoding.UTF8.GetBytes("Test RAW print payload");

        var result = mockSpooler.SubmitSpoolJob(@"\\OFFICE-HOST\HP_LaserJet_M1136", "test_job_1", payload, settings);

        Assert.True(result.Success);
        Assert.Single(mockSpooler.SpooledJobs);
        Assert.Equal(@"\\OFFICE-HOST\HP_LaserJet_M1136", mockSpooler.SpooledJobs[0].Printer);
        Assert.Equal(payload.Length, mockSpooler.SpooledJobs[0].BytesLength);
    }

    [Fact]
    public async Task AgentWorker_ProcessesJobInDryRun_CleanlyWipesWorkingDir()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "pb_worker_test_" + Guid.NewGuid());
        var mockSpooler = new MockSpooler();

        var mockHandler = new MockHttpMessageHandler();
        var httpClient = new HttpClient(mockHandler) { BaseAddress = new Uri("http://mock-api.local") };

        var config = new AgentConfig(
            ApiBaseUrl: "http://mock-api.local",
            AgentKey: "test-key-configured",
            AgentId: "test-agent",
            TargetPrinterUncPath: @"\\OFFICE-HOST\HP_LaserJet_M1136",
            TempDirectory: tempRoot,
            PollIntervalSeconds: 1,
            DryRun: true,
            MockPrinter: true
        );

        var worker = new AgentWorker(config, mockSpooler, httpClient);

        bool processed = await worker.ProcessNextJobAsync();
        Assert.True(processed);

        // Verify temp directory cleaned up
        var remainingDirs = Directory.GetDirectories(tempRoot);
        Assert.Empty(remainingDirs);

        if (Directory.Exists(tempRoot))
        {
            Directory.Delete(tempRoot, true);
        }
    }
}

public class MockHttpMessageHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.AbsolutePath == "/api/agent/claim")
        {
            var json = """
            {
              "job": {
                "id": "job_test_001",
                "tenantId": "dtc-office",
                "userId": "usr_1",
                "userEmail": "office@dtc.local",
                "printerId": "hp-laserjet-m1136",
                "printerName": "HP LaserJet Professional M1136 MFP",
                "originalFileName": "sample.pdf",
                "fileSizeBytes": 5,
                "fileFormat": "pdf",
                "mimeType": "application/pdf",
                "r2StorageKey": "uploads/sample.pdf",
                "status": "pending",
                "createdAt": 1715000000,
                "updatedAt": 1715000000
              },
              "leaseToken": "lease_token_123",
              "downloadUrl": ""
            }
            """;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }

        if (request.RequestUri?.AbsolutePath == "/api/agent/status")
        {
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"success\":true}", Encoding.UTF8, "application/json")
            });
        }

        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NotFound));
    }
}
