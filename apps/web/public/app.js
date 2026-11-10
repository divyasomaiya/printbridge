"use strict";
// Print Bridge Web Client logic
document.addEventListener('DOMContentLoaded', () => {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const removeFileBtn = document.getElementById('removeFileBtn');
    const printerSelect = document.getElementById('printerSelect');
    const printerNotice = document.getElementById('printerNotice');
    const copiesInput = document.getElementById('copiesInput');
    const orientationSelect = document.getElementById('orientationSelect');
    const pageRangeSelect = document.getElementById('pageRangeSelect');
    const customRangeGroup = document.getElementById('customRangeGroup');
    const customRangeInput = document.getElementById('customRangeInput');
    const paperSizeSelect = document.getElementById('paperSizeSelect');
    const duplexSelect = document.getElementById('duplexSelect');
    const colorModeSelect = document.getElementById('colorModeSelect');
    const scalingSelect = document.getElementById('scalingSelect');
    const submitJobBtn = document.getElementById('submitJobBtn');
    const statusSection = document.getElementById('statusSection');
    const statusText = document.getElementById('statusText');
    const statusDetails = document.getElementById('statusDetails');
    const authStatusText = document.getElementById('authStatusText');
    const authBtn = document.getElementById('authBtn');
    const authDialog = document.getElementById('authDialog');
    const employeePasskeyInput = document.getElementById('employeePasskeyInput');
    const saveAuthBtn = document.getElementById('saveAuthBtn');
    const cancelAuthBtn = document.getElementById('cancelAuthBtn');
    let selectedFile = null;
    // Manage employee session token in localStorage. Raw PINs/secrets are NEVER stored.
    function getStoredSessionToken() {
        return localStorage.getItem('pb_session_token');
    }
    function updateAuthUI() {
        const token = getStoredSessionToken();
        if (token) {
            authStatusText.textContent = 'Device Authorized (Active Office Session)';
            authStatusText.style.color = '#15803d';
            authBtn.textContent = 'Change PIN';
        }
        else {
            authStatusText.textContent = 'Authorization required before printing';
            authStatusText.style.color = '#b45309';
            authBtn.textContent = 'Enter Office PIN';
        }
    }
    authBtn.addEventListener('click', () => {
        authDialog.style.display = 'block';
        employeePasskeyInput.focus();
    });
    cancelAuthBtn.addEventListener('click', () => {
        authDialog.style.display = 'none';
    });
    saveAuthBtn.addEventListener('click', async () => {
        const passkey = employeePasskeyInput.value.trim();
        if (!passkey)
            return;
        try {
            // Exchange PIN with backend to receive signed short-lived session token
            const res = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passkey })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                localStorage.setItem('pb_session_token', data.token);
                authDialog.style.display = 'none';
                employeePasskeyInput.value = '';
                updateAuthUI();
            }
            else {
                alert(data.error || 'Authorization failed: Invalid office PIN.');
            }
        }
        catch {
            // SECURITY FIX: Never accept unverified PINs as fallback on network error
            alert('Network error: Unable to contact authentication server to verify credentials.');
        }
    });
    updateAuthUI();
    // Dropzone drag-and-drop
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileSelected(e.dataTransfer.files[0]);
        }
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
            handleFileSelected(fileInput.files[0]);
        }
    });
    removeFileBtn.addEventListener('click', () => {
        selectedFile = null;
        fileInput.value = '';
        dropzone.style.display = 'block';
        fileInfo.style.display = 'none';
        submitJobBtn.disabled = true;
    });
    function handleFileSelected(file) {
        selectedFile = file;
        fileNameDisplay.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        dropzone.style.display = 'none';
        fileInfo.style.display = 'flex';
        submitJobBtn.disabled = false;
    }
    // Page range toggle
    pageRangeSelect.addEventListener('change', () => {
        if (pageRangeSelect.value === 'custom') {
            customRangeGroup.style.display = 'block';
        }
        else {
            customRangeGroup.style.display = 'none';
        }
    });
    // Printer capability adaptation
    printerSelect.addEventListener('change', () => {
        const isMock = printerSelect.value === 'mock-printer-test';
        const colorOpt = colorModeSelect.querySelector('option[value="color"]');
        if (isMock) {
            printerNotice.style.display = 'none';
            if (colorOpt)
                colorOpt.disabled = false;
        }
        else {
            printerNotice.style.display = 'block';
            colorModeSelect.value = 'grayscale';
            if (colorOpt)
                colorOpt.disabled = true;
        }
    });
    // Submit print job
    submitJobBtn.addEventListener('click', async () => {
        if (!selectedFile)
            return;
        const sessionToken = getStoredSessionToken();
        const headers = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) {
            headers['Authorization'] = `Bearer ${sessionToken}`;
        }
        submitJobBtn.disabled = true;
        statusSection.style.display = 'block';
        statusText.textContent = 'Uploading document...';
        statusDetails.textContent = 'Transferring securely to cloud gateway';
        const reader = new FileReader();
        reader.onload = async () => {
            const base64Data = reader.result.split(',')[1];
            const payload = {
                printerId: printerSelect.value,
                filename: selectedFile.name,
                fileBase64: base64Data,
                settings: {
                    copies: parseInt(copiesInput.value, 10),
                    orientation: orientationSelect.value,
                    paperSize: paperSizeSelect.value,
                    pageRangeType: pageRangeSelect.value,
                    customPageRanges: customRangeInput.value,
                    duplex: duplexSelect.value,
                    colorMode: colorModeSelect.value,
                    scaling: scalingSelect.value,
                    collate: true
                }
            };
            try {
                const response = await fetch('/api/jobs', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });
                const resData = await response.json();
                if (response.ok && resData.success) {
                    statusText.textContent = 'Print Job Enqueued';
                    statusDetails.textContent = `Job ID: ${resData.job.id} — Waiting for Windows gateway...`;
                    // Track job status periodically
                    const pollInterval = setInterval(async () => {
                        try {
                            const stRes = await fetch(`/api/jobs/${resData.job.id}`, { headers });
                            if (stRes.ok) {
                                const jobStatus = await stRes.json();
                                statusText.textContent = `Status: ${jobStatus.status.toUpperCase()}`;
                                statusDetails.textContent = jobStatus.statusMessage || `Job is ${jobStatus.status}`;
                                if (['completed', 'failed', 'cancelled'].includes(jobStatus.status)) {
                                    clearInterval(pollInterval);
                                }
                            }
                        }
                        catch {
                            // ignore transient poll failure
                        }
                    }, 3000);
                }
                else {
                    if (response.status === 401) {
                        localStorage.removeItem('pb_session_token');
                        updateAuthUI();
                        authDialog.style.display = 'block';
                    }
                    statusText.textContent = 'Submission Rejected';
                    statusDetails.textContent = resData.error || 'Unknown error occurred.';
                }
            }
            catch (err) {
                statusText.textContent = 'Network Error';
                statusDetails.textContent = err.message || 'Failed to reach API gateway.';
            }
            finally {
                submitJobBtn.disabled = false;
            }
        };
        reader.readAsDataURL(selectedFile);
    });
});
