// Print Bridge Web Client logic
document.addEventListener('DOMContentLoaded', () => {
  const dropzone = document.getElementById('dropzone') as HTMLDivElement;
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const fileInfo = document.getElementById('fileInfo') as HTMLDivElement;
  const fileNameDisplay = document.getElementById('fileNameDisplay') as HTMLSpanElement;
  const removeFileBtn = document.getElementById('removeFileBtn') as HTMLButtonElement;
  const printerSelect = document.getElementById('printerSelect') as HTMLSelectElement;
  const printerNotice = document.getElementById('printerNotice') as HTMLDivElement;
  const copiesInput = document.getElementById('copiesInput') as HTMLInputElement;
  const orientationSelect = document.getElementById('orientationSelect') as HTMLSelectElement;
  const pageRangeSelect = document.getElementById('pageRangeSelect') as HTMLSelectElement;
  const customRangeGroup = document.getElementById('customRangeGroup') as HTMLDivElement;
  const customRangeInput = document.getElementById('customRangeInput') as HTMLInputElement;
  const paperSizeSelect = document.getElementById('paperSizeSelect') as HTMLSelectElement;
  const duplexSelect = document.getElementById('duplexSelect') as HTMLSelectElement;
  const colorModeSelect = document.getElementById('colorModeSelect') as HTMLSelectElement;
  const scalingSelect = document.getElementById('scalingSelect') as HTMLSelectElement;
  const submitJobBtn = document.getElementById('submitJobBtn') as HTMLButtonElement;
  const statusSection = document.getElementById('statusSection') as HTMLDivElement;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;
  const statusDetails = document.getElementById('statusDetails') as HTMLParagraphElement;

  const authStatusText = document.getElementById('authStatusText') as HTMLSpanElement;
  const authBtn = document.getElementById('authBtn') as HTMLButtonElement;
  const authDialog = document.getElementById('authDialog') as HTMLDivElement;
  const employeePasskeyInput = document.getElementById('employeePasskeyInput') as HTMLInputElement;
  const saveAuthBtn = document.getElementById('saveAuthBtn') as HTMLButtonElement;
  const cancelAuthBtn = document.getElementById('cancelAuthBtn') as HTMLButtonElement;

  let selectedFile: File | null = null;

  // Manage employee session token in localStorage. Raw PINs/secrets are NEVER stored.
  function getStoredSessionToken(): string | null {
    return localStorage.getItem('pb_session_token');
  }

  function updateAuthUI() {
    const token = getStoredSessionToken();
    if (token) {
      authStatusText.textContent = 'Device Authorized (Active Office Session)';
      authStatusText.style.color = '#15803d';
      authBtn.textContent = 'Change PIN';
    } else {
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
    if (!passkey) return;

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
      } else {
        alert(data.error || 'Authorization failed: Invalid office PIN.');
      }
    } catch {
      // SECURITY FIX: Never accept unverified PINs as fallback on network error
      alert('Network error: Unable to contact authentication server to verify credentials.');
    }
  });

  updateAuthUI();

  // Dropzone drag-and-drop
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e: DragEvent) => {
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

  function handleFileSelected(file: File) {
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
    } else {
      customRangeGroup.style.display = 'none';
    }
  });

  // Printer capability adaptation
  printerSelect.addEventListener('change', () => {
    const isMock = printerSelect.value === 'mock-printer-test';
    const colorOpt = colorModeSelect.querySelector('option[value="color"]') as HTMLOptionElement;
    if (isMock) {
      printerNotice.style.display = 'none';
      if (colorOpt) colorOpt.disabled = false;
    } else {
      printerNotice.style.display = 'block';
      colorModeSelect.value = 'grayscale';
      if (colorOpt) colorOpt.disabled = true;
    }
  });

  // Submit print job
  submitJobBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    const sessionToken = getStoredSessionToken();
    const headers: Record<string, string> = {
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
      const base64Data = (reader.result as string).split(',')[1];
      const payload = {
        printerId: printerSelect.value,
        filename: selectedFile!.name,
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
            } catch {
              // ignore transient poll failure
            }
          }, 3000);
        } else {
          if (response.status === 401) {
            localStorage.removeItem('pb_session_token');
            updateAuthUI();
            authDialog.style.display = 'block';
          }
          statusText.textContent = 'Submission Rejected';
          statusDetails.textContent = resData.error || 'Unknown error occurred.';
        }
      } catch (err: any) {
        statusText.textContent = 'Network Error';
        statusDetails.textContent = err.message || 'Failed to reach API gateway.';
      } finally {
        submitJobBtn.disabled = false;
      }
    };

    reader.readAsDataURL(selectedFile);
  });
});
