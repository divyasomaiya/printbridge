"use strict";
// Admin Dashboard Client Logic - Secure rendering to prevent stored XSS
document.addEventListener('DOMContentLoaded', () => {
    const loginCard = document.getElementById('loginCard');
    const dashboardCard = document.getElementById('dashboardCard');
    const adminPass = document.getElementById('adminPass');
    const loginBtn = document.getElementById('loginBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const pauseToggleBtn = document.getElementById('pauseToggleBtn');
    const queueStatusBadge = document.getElementById('queueStatusBadge');
    const logoutBtn = document.getElementById('logoutBtn');
    const queueTableBody = document.getElementById('queueTableBody');
    function getToken() {
        return localStorage.getItem('pb_admin_token');
    }
    function setToken(token) {
        if (token)
            localStorage.setItem('pb_admin_token', token);
        else
            localStorage.removeItem('pb_admin_token');
        updateView();
    }
    loginBtn.addEventListener('click', async () => {
        const password = adminPass.value;
        if (!password)
            return;
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin123', password })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                adminPass.value = '';
                setToken(data.token);
            }
            else {
                alert(data.error || 'Authentication failed: Invalid credentials.');
            }
        }
        catch (e) {
            alert(`Login failed: ${e.message}`);
        }
    });
    logoutBtn.addEventListener('click', () => setToken(null));
    function updateView() {
        const token = getToken();
        if (token) {
            loginCard.style.display = 'none';
            dashboardCard.style.display = 'block';
            loadQueue();
            loadSettings();
        }
        else {
            loginCard.style.display = 'block';
            dashboardCard.style.display = 'none';
        }
    }
    async function loadSettings() {
        const token = getToken();
        if (!token)
            return;
        try {
            const res = await fetch('/api/admin/settings', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const settings = await res.json();
                if (settings.queuePaused) {
                    queueStatusBadge.textContent = 'Queue Paused';
                    queueStatusBadge.className = 'badge badge-failed';
                    pauseToggleBtn.textContent = 'Resume Queue';
                }
                else {
                    queueStatusBadge.textContent = 'Queue Active';
                    queueStatusBadge.className = 'badge badge-completed';
                    pauseToggleBtn.textContent = 'Pause Queue';
                }
            }
        }
        catch { }
    }
    pauseToggleBtn.addEventListener('click', async () => {
        const token = getToken();
        if (!token)
            return;
        const isPausedNow = queueStatusBadge.textContent?.includes('Paused');
        try {
            await fetch('/api/admin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ queuePaused: !isPausedNow })
            });
            loadSettings();
        }
        catch { }
    });
    refreshBtn.addEventListener('click', loadQueue);
    async function loadQueue() {
        const token = getToken();
        if (!token)
            return;
        try {
            const res = await fetch('/api/admin/queue', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403)
                    setToken(null);
                return;
            }
            const jobs = await res.json();
            queueTableBody.innerHTML = '';
            if (!Array.isArray(jobs) || jobs.length === 0) {
                const emptyTr = document.createElement('tr');
                const emptyTd = document.createElement('td');
                emptyTd.colSpan = 7;
                emptyTd.style.textAlign = 'center';
                emptyTd.style.color = '#64748b';
                emptyTd.textContent = 'No print jobs in queue.';
                emptyTr.appendChild(emptyTd);
                queueTableBody.appendChild(emptyTr);
                return;
            }
            // XSS DEFENSE: Safe DOM creation using textContent for all untrusted server fields
            for (const job of jobs) {
                const tr = document.createElement('tr');
                // 1. Time
                const tdTime = document.createElement('td');
                tdTime.textContent = new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                tr.appendChild(tdTime);
                // 2. Name
                const tdName = document.createElement('td');
                const strongName = document.createElement('strong');
                strongName.textContent = job.employeeName || 'Anonymous Guest';
                tdName.appendChild(strongName);
                tr.appendChild(tdName);
                // 3. Document
                const tdDoc = document.createElement('td');
                tdDoc.textContent = job.originalFileName || '';
                tr.appendChild(tdDoc);
                // 4. Format
                const tdFormat = document.createElement('td');
                tdFormat.textContent = (job.fileFormat || '').toUpperCase();
                tr.appendChild(tdFormat);
                // 5. Status Badge
                const tdStatus = document.createElement('td');
                const badge = document.createElement('span');
                badge.className = `badge badge-${job.status}`;
                badge.textContent = job.status || '';
                tdStatus.appendChild(badge);
                tr.appendChild(tdStatus);
                // 6. Details
                const tdDetails = document.createElement('td');
                tdDetails.style.fontSize = '0.75rem';
                tdDetails.style.color = '#64748b';
                tdDetails.textContent = job.statusMessage || '';
                tr.appendChild(tdDetails);
                // 7. Actions
                const tdAction = document.createElement('td');
                const canCancel = ['pending', 'claimed'].includes(job.status);
                if (canCancel) {
                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'btn btn-danger';
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.addEventListener('click', async () => {
                        if (!confirm(`Cancel print job for ${job.employeeName || 'this user'}?`))
                            return;
                        const cancelRes = await fetch(`/api/admin/queue/${job.id}/cancel`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (cancelRes.ok)
                            loadQueue();
                        else
                            alert('Failed to cancel job.');
                    });
                    tdAction.appendChild(cancelBtn);
                }
                else {
                    tdAction.textContent = '-';
                }
                tr.appendChild(tdAction);
                queueTableBody.appendChild(tr);
            }
        }
        catch (e) {
            queueTableBody.innerHTML = '';
            const errTr = document.createElement('tr');
            const errTd = document.createElement('td');
            errTd.colSpan = 7;
            errTd.style.color = 'red';
            errTd.textContent = `Failed to load queue: ${e.message}`;
            errTr.appendChild(errTd);
            queueTableBody.appendChild(errTr);
        }
    }
    updateView();
});
