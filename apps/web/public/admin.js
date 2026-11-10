"use strict";
// Admin Dashboard Client Logic
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
                if (res.status === 401)
                    setToken(null);
                return;
            }
            const jobs = await res.json();
            if (!Array.isArray(jobs) || jobs.length === 0) {
                queueTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No print jobs in queue.</td></tr>';
                return;
            }
            queueTableBody.innerHTML = jobs.map((job) => {
                const timeStr = new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const name = job.employeeName || 'Anonymous Guest';
                const badgeClass = `badge-${job.status}`;
                const canCancel = ['pending', 'claimed'].includes(job.status);
                const cancelBtn = canCancel
                    ? `<button class="btn btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>`
                    : '-';
                return `
          <tr>
            <td>${timeStr}</td>
            <td><strong>${name}</strong></td>
            <td>${job.originalFileName}</td>
            <td>${(job.fileFormat || '').toUpperCase()}</td>
            <td><span class="badge ${badgeClass}">${job.status}</span></td>
            <td style="font-size: 0.75rem; color: var(--text-muted);">${job.statusMessage || ''}</td>
            <td>${cancelBtn}</td>
          </tr>
        `;
            }).join('');
        }
        catch (e) {
            queueTableBody.innerHTML = `<tr><td colspan="7" style="color: red;">Failed to load queue: ${e.message}</td></tr>`;
        }
    }
    // Global cancelJob function
    window.cancelJob = async (id) => {
        const token = getToken();
        if (!token || !confirm('Are you sure you want to cancel this print job?'))
            return;
        try {
            const res = await fetch(`/api/admin/queue/${id}/cancel`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok)
                loadQueue();
            else
                alert('Failed to cancel job.');
        }
        catch { }
    };
    updateView();
});
