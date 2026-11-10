"use strict";
// Print Bridge Public Guest Web Client
document.addEventListener('DOMContentLoaded', () => {
    const guestNameInput = document.getElementById('guestNameInput');
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
    let selectedFile = null;
    // Restore saved guest name if previously entered
    const savedName = localStorage.getItem('pb_guest_name');
    if (savedName)
        guestNameInput.value = savedName;
    guestNameInput.addEventListener('input', updateSubmitButtonState);
    function updateSubmitButtonState() {
        submitJobBtn.disabled = !selectedFile || !guestNameInput.value.trim();
    }
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
        updateSubmitButtonState();
    });
    function handleFileSelected(file) {
        selectedFile = file;
        fileNameDisplay.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        dropzone.style.display = 'none';
        fileInfo.style.display = 'flex';
        updateSubmitButtonState();
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
        const guestName = guestNameInput.value.trim();
        if (!selectedFile || !guestName)
            return;
        localStorage.setItem('pb_guest_name', guestName);
        submitJobBtn.disabled = true;
        statusSection.style.display = 'block';
        statusText.textContent = 'Uploading document...';
        statusDetails.textContent = 'Transferring securely to cloud gateway';
        const reader = new FileReader();
        reader.onload = async () => {
            const base64Data = reader.result.split(',')[1];
            const payload = {
                guestName,
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
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const resData = await response.json();
                if (response.ok && resData.success) {
                    const receiptToken = resData.receiptToken;
                    statusText.textContent = 'Print Job Enqueued';
                    statusDetails.textContent = `Job ID: ${resData.job.id} (Guest: ${guestName}) — Waiting for office gateway...`;
                    // Track job status periodically using the secure receipt token
                    const pollInterval = setInterval(async () => {
                        try {
                            const url = receiptToken
                                ? `/api/jobs/${resData.job.id}?receiptToken=${receiptToken}`
                                : `/api/jobs/${resData.job.id}`;
                            const stRes = await fetch(url);
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
