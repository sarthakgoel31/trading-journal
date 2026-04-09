// ---- State ----
let state = {
    activeSession: null,
    timerInterval: null,
    sessionRating: 0,
    selectedMood: null,
    selectedExercise: 0,
    hrChart: null,
};

// ---- API helper ----
async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Request failed');
    }
    return res.json();
}

// ---- Navigation ----
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('view-' + tab.dataset.view).classList.add('active');

        if (tab.dataset.view === 'history') loadHistory();
        if (tab.dataset.view === 'analysis') loadAnalysis();
        if (tab.dataset.view === 'setup') loadServerInfo();
    });
});

// ---- Chip selectors ----
function setupChips(containerId, callback) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            container.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
            if (callback) callback(chip.dataset.value);
        });
    });
}

function getChipValue(containerId) {
    const el = document.querySelector(`#${containerId} .chip.selected`);
    return el ? el.dataset.value : null;
}

setupChips('mood-chips', v => { state.selectedMood = v; });
setupChips('exercise-chips', v => { state.selectedExercise = parseInt(v); });
setupChips('direction-chips');
setupChips('outcome-chips');
setupChips('emotion-before-chips');
setupChips('emotion-during-chips');

// Plan chips — show/hide rules broken field
setupChips('plan-chips', v => {
    const rulesGroup = document.getElementById('rules-broken-group');
    rulesGroup.style.display = v === '0' ? 'flex' : 'none';
});

// Confidence dots
document.querySelectorAll('#confidence-dots .confidence-dot').forEach(dot => {
    dot.addEventListener('click', () => {
        document.querySelectorAll('#confidence-dots .confidence-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
    });
});

// Star rating
document.querySelectorAll('#session-stars .star').forEach(star => {
    star.addEventListener('click', () => {
        state.sessionRating = parseInt(star.dataset.value);
        document.querySelectorAll('#session-stars .star').forEach(s => {
            s.classList.toggle('filled', parseInt(s.dataset.value) <= state.sessionRating);
        });
    });
});

// ---- Session toggle ----
async function toggleSession() {
    if (state.activeSession && state.activeSession.status === 'active') {
        await stopSession();
    } else if (!state.activeSession) {
        await startSession();
    }
}

async function startSession() {
    const sleepHours = parseFloat(document.getElementById('sleep-hours').value) || null;
    const caffeine = parseInt(document.getElementById('caffeine').value) || 0;

    try {
        const session = await api('/api/session/start', 'POST', {
            mood_before: state.selectedMood,
            sleep_hours: sleepHours,
            caffeine_cups: caffeine,
            exercise_today: state.selectedExercise,
        });
        state.activeSession = session;
        updateSessionUI();
    } catch (e) {
        alert(e.message);
    }
}

async function stopSession() {
    try {
        const result = await api('/api/session/stop', 'POST');
        state.activeSession = { ...state.activeSession, ...result };
        updateSessionUI();
    } catch (e) {
        alert(e.message);
    }
}

function updateSessionUI() {
    const btn = document.getElementById('toggle-btn');
    const label = document.getElementById('toggle-label');
    const timer = document.getElementById('session-timer');
    const meta = document.getElementById('session-meta');
    const preSession = document.getElementById('pre-session');
    const postSession = document.getElementById('post-session');
    const healthCard = document.getElementById('health-card');
    const readinessDisplay = document.getElementById('readiness-display');

    if (!state.activeSession || !state.activeSession.id) {
        // No session
        btn.classList.remove('active');
        btn.querySelector('.icon').innerHTML = '&#9654;';
        label.textContent = 'START';
        timer.classList.add('hidden');
        meta.classList.add('hidden');
        preSession.classList.remove('hidden');
        postSession.classList.add('hidden');
        healthCard.classList.add('hidden');
        readinessDisplay.classList.add('hidden');
        clearInterval(state.timerInterval);
        return;
    }

    preSession.classList.add('hidden');
    const healthRecording = document.getElementById('health-recording');

    if (state.activeSession.status === 'active') {
        btn.classList.add('active');
        btn.querySelector('.icon').innerHTML = '&#9632;';
        label.textContent = 'STOP';
        timer.classList.remove('hidden');
        meta.classList.remove('hidden');
        healthRecording.classList.remove('hidden');
        healthCard.classList.add('hidden');
        postSession.classList.add('hidden');

        // Show readiness
        if (state.activeSession.readiness_score != null) {
            const score = state.activeSession.readiness_score;
            const cls = score >= 70 ? 'high' : (score >= 40 ? 'medium' : 'low');
            const label2 = score >= 70 ? 'READY' : (score >= 40 ? 'CAUTION' : 'HIGH RISK');
            readinessDisplay.innerHTML = `<div class="readiness-badge ${cls}">${label2}: ${score}/100</div>`;
            readinessDisplay.classList.remove('hidden');
        }

        startTimer();
        meta.textContent = `Started ${formatTime(state.activeSession.start_time)}`;
    } else if (state.activeSession.status === 'stopped') {
        btn.classList.remove('active');
        btn.querySelector('.icon').innerHTML = '&#10003;';
        label.textContent = 'DONE';
        btn.style.pointerEvents = 'none';
        timer.classList.remove('hidden');
        meta.classList.remove('hidden');
        healthRecording.classList.add('hidden');
        healthCard.classList.remove('hidden');
        postSession.classList.remove('hidden');

        clearInterval(state.timerInterval);
        meta.textContent = `${formatTime(state.activeSession.start_time)} - ${formatTime(state.activeSession.end_time)}`;

        // Reset journal form
        document.getElementById('trade-question').classList.remove('hidden');
        document.getElementById('trade-form-area').classList.add('hidden');
        document.getElementById('session-wrapup').classList.add('hidden');
    }

    // Update health display if available
    if (state.activeSession.health) {
        updateHealthDisplay(state.activeSession.health);
    }
}

function startTimer() {
    clearInterval(state.timerInterval);
    const start = new Date(state.activeSession.start_time).getTime();
    const update = () => {
        const elapsed = Date.now() - start;
        const h = Math.floor(elapsed / 3600000);
        const m = Math.floor((elapsed % 3600000) / 60000);
        const s = Math.floor((elapsed % 60000) / 1000);
        document.getElementById('session-timer').textContent =
            `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    update();
    state.timerInterval = setInterval(update, 1000);
}

function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---- Pre-sync from Apple Watch ----
async function preSyncFromWatch() {
    const statusEl = document.getElementById('sync-status');
    statusEl.textContent = 'Waiting for watch data...';
    statusEl.style.color = 'var(--yellow)';

    // Check if data already exists
    try {
        const existing = await api('/api/pre-sync/latest');
        if (existing.synced) {
            applyPreSync(existing);
            return;
        }
    } catch (e) {}

    // Show instructions
    const info = await api('/api/server-info');
    alert(
        `Run "Trading Pre-Sync" shortcut on your iPhone.\n\n` +
        `It reads your sleep, resting HR, and HRV from Apple Health, ` +
        `then sends it to:\nhttp://${info.local_ip}:${info.port}/api/pre-sync/push\n\n` +
        `After running it, click "Sync from Watch" again.`
    );

    // Poll for data (user might run shortcut while alert is showing)
    let attempts = 0;
    const poll = setInterval(async () => {
        attempts++;
        try {
            const data = await api('/api/pre-sync/latest');
            if (data.synced) {
                clearInterval(poll);
                applyPreSync(data);
            }
        } catch (e) {}
        if (attempts > 30) clearInterval(poll); // stop after 30s
    }, 1000);
}

function applyPreSync(data) {
    const statusEl = document.getElementById('sync-status');
    const banner = document.getElementById('watch-data-banner');

    // Auto-fill sleep hours
    if (data.sleep_hours) {
        document.getElementById('sleep-hours').value = data.sleep_hours;
        document.getElementById('sleep-source').textContent = '(from watch)';
    }

    // Show banner with watch data
    banner.classList.remove('hidden');
    banner.style.display = 'flex';
    document.getElementById('watch-sleep-badge').textContent =
        data.sleep_hours ? `Sleep: ${data.sleep_hours}h` : '';
    document.getElementById('watch-hr-badge').textContent =
        data.resting_hr ? `Resting HR: ${data.resting_hr} bpm` : '';
    document.getElementById('watch-hrv-badge').textContent =
        data.hrv ? `HRV: ${data.hrv} ms` : '';

    statusEl.textContent = 'Synced!';
    statusEl.style.color = 'var(--green)';
}

// ---- Health display ----
function updateHealthDisplay(health) {
    if (!health) return;
    if (health.hr) {
        document.getElementById('hr-avg').textContent = health.hr.avg;
        document.getElementById('hr-max').textContent = health.hr.max;
    }
    if (health.hrv) {
        document.getElementById('hrv-avg').textContent = health.hrv.avg;
    }
    if (health.stress_level) {
        const el = document.getElementById('stress-level');
        el.textContent = health.stress_level.charAt(0).toUpperCase() + health.stress_level.slice(1);
        el.className = 'stat-value';
        if (health.stress_level === 'high' || health.stress_level === 'elevated') el.classList.add('negative');
        if (health.stress_level === 'low') el.classList.add('positive');
    }
}

async function syncHealth() {
    const info = await api('/api/server-info');
    const url = `http://${info.local_ip}:${info.port}/api/health-sync`;
    const syncBtn = document.getElementById('sync-post-btn');

    // First check if data was already synced
    try {
        const session = await api('/api/session/active');
        if (session.active && session.health) {
            state.activeSession = session;
            showHealthData(session.health);
            return;
        }
    } catch (e) {}

    // Show instructions
    syncBtn.textContent = 'Waiting...';
    alert(
        `Run "Trading Post-Sync" shortcut on your iPhone.\n\n` +
        `It pulls all HR data from your session and sends it to:\n${url}\n\n` +
        `After running it, click "Sync Watch Data" again.`
    );
    syncBtn.textContent = 'Sync Watch Data';
}

function showHealthData(health) {
    if (!health) return;
    document.getElementById('health-not-synced').classList.add('hidden');
    document.getElementById('health-stats').classList.remove('hidden');
    document.getElementById('sync-post-btn').textContent = 'Synced';
    document.getElementById('sync-post-btn').disabled = true;
    updateHealthDisplay(health);
}

// ---- Trade form ----
function showTradeForm() {
    document.getElementById('trade-question').classList.add('hidden');
    document.getElementById('trade-form-area').classList.remove('hidden');
}

function skipTrades() {
    document.getElementById('trade-question').classList.add('hidden');
    document.getElementById('session-wrapup').classList.remove('hidden');
}

async function saveTrade() {
    const direction = getChipValue('direction-chips');
    const outcome = getChipValue('outcome-chips');
    const emotionBefore = getChipValue('emotion-before-chips');
    const emotionDuring = getChipValue('emotion-during-chips');
    const perPlan = getChipValue('plan-chips');
    const confDot = document.querySelector('#confidence-dots .confidence-dot.selected');

    if (!direction || !outcome) {
        alert('Please select direction and outcome.');
        return;
    }

    // Build time strings with today's date
    const entryTimeInput = document.getElementById('trade-entry-time').value;
    const exitTimeInput = document.getElementById('trade-exit-time').value;
    const today = new Date().toISOString().split('T')[0];

    const trade = {
        entry_time: entryTimeInput ? `${today}T${entryTimeInput}:00` : null,
        exit_time: exitTimeInput ? `${today}T${exitTimeInput}:00` : null,
        direction,
        entry_price: parseFloat(document.getElementById('trade-entry-price').value) || null,
        exit_price: parseFloat(document.getElementById('trade-exit-price').value) || null,
        pnl_pips: parseFloat(document.getElementById('trade-pnl').value) || null,
        outcome,
        per_plan: parseInt(perPlan) || 0,
        rules_broken: document.getElementById('trade-rules-broken').value || null,
        confidence_before: confDot ? parseInt(confDot.dataset.value) : 3,
        emotion_before: emotionBefore,
        emotion_during: emotionDuring,
        notes: document.getElementById('trade-notes').value || null,
    };

    try {
        const result = await api(`/api/session/${state.activeSession.id}/trade`, 'POST', trade);
        addTradeToList(trade, result.id);
        resetTradeForm();
    } catch (e) {
        alert('Error saving trade: ' + e.message);
    }
}

function addTradeToList(trade, tradeId) {
    const list = document.getElementById('trades-list');
    const pipsClass = trade.outcome === 'win' ? 'win' : (trade.outcome === 'loss' ? 'loss' : '');
    const pipsStr = trade.pnl_pips != null ? `${trade.pnl_pips > 0 ? '+' : ''}${trade.pnl_pips}` : '--';

    const div = document.createElement('div');
    div.className = 'trade-card';
    div.id = `trade-${tradeId}`;
    div.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px">
            <span class="trade-direction ${trade.direction}">${trade.direction.toUpperCase()}</span>
            <span style="font-size:13px; color:var(--text-dim)">${trade.entry_time ? formatTime(trade.entry_time) : ''}</span>
            ${!trade.per_plan ? '<span style="font-size:11px; color:var(--red)">RULE BREAK</span>' : ''}
        </div>
        <div style="display:flex; align-items:center; gap:12px">
            <span class="trade-pips ${pipsClass}">${pipsStr} pips</span>
            <button class="trade-delete" onclick="deleteTrade(${tradeId})">&times;</button>
        </div>
    `;
    list.appendChild(div);
}

async function deleteTrade(tradeId) {
    try {
        await api(`/api/trade/${tradeId}`, 'DELETE');
        document.getElementById(`trade-${tradeId}`)?.remove();
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

function resetTradeForm() {
    document.getElementById('trade-entry-time').value = '';
    document.getElementById('trade-exit-time').value = '';
    document.getElementById('trade-entry-price').value = '';
    document.getElementById('trade-exit-price').value = '';
    document.getElementById('trade-pnl').value = '';
    document.getElementById('trade-rules-broken').value = '';
    document.getElementById('trade-notes').value = '';

    // Reset chips
    ['direction-chips', 'outcome-chips', 'emotion-before-chips', 'emotion-during-chips'].forEach(id => {
        document.querySelectorAll(`#${id} .chip`).forEach(c => c.classList.remove('selected'));
    });
    // Reset plan to "yes"
    const planChips = document.querySelectorAll('#plan-chips .chip');
    planChips.forEach(c => c.classList.remove('selected'));
    planChips[0].classList.add('selected');
    document.getElementById('rules-broken-group').style.display = 'none';

    // Reset confidence to 3
    document.querySelectorAll('#confidence-dots .confidence-dot').forEach(d => {
        d.classList.toggle('selected', d.dataset.value === '3');
    });
}

function doneAddingTrades() {
    document.getElementById('trade-form').classList.add('hidden');
    document.getElementById('session-wrapup').classList.remove('hidden');
}

// ---- Complete session ----
async function completeSession() {
    const lesson = document.getElementById('session-lesson').value;
    const notes = document.getElementById('session-notes').value;

    try {
        await api(`/api/session/${state.activeSession.id}/complete`, 'POST', {
            session_rating: state.sessionRating || null,
            lesson: lesson || null,
            notes: notes || null,
        });

        // Reset everything
        state.activeSession = null;
        state.sessionRating = 0;
        clearInterval(state.timerInterval);

        // Reset UI
        const btn = document.getElementById('toggle-btn');
        btn.style.pointerEvents = '';
        document.getElementById('session-lesson').value = '';
        document.getElementById('session-notes').value = '';
        document.getElementById('trades-list').innerHTML = '';
        document.querySelectorAll('#session-stars .star').forEach(s => s.classList.remove('filled'));

        updateSessionUI();
        alert('Session completed! Check the Analysis tab for insights.');
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// ---- History ----
async function loadHistory() {
    try {
        const sessions = await api('/api/sessions');
        const list = document.getElementById('history-list');
        const empty = document.getElementById('history-empty');

        if (!sessions.length) {
            list.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        list.innerHTML = sessions.map(s => {
            const trades = s.trades || [];
            const wins = trades.filter(t => t.outcome === 'win').length;
            const total = trades.length;
            const pips = trades.reduce((sum, t) => sum + (t.pnl_pips || 0), 0);
            const pipsClass = pips > 0 ? 'positive' : (pips < 0 ? 'negative' : '');
            const stars = s.session_rating ? '&#9733;'.repeat(s.session_rating) : '';

            return `
                <div class="session-row" onclick="showSessionDetail(${s.id})">
                    <div>
                        <div class="session-date">${formatDate(s.start_time)}</div>
                        <div style="font-size:12px; color:var(--text-dim); margin-top:2px">
                            ${total} trade${total !== 1 ? 's' : ''} | ${wins}W | ${s.mood_before || ''} | Sleep: ${s.sleep_hours || '?'}h
                        </div>
                        ${s.lesson ? `<div style="font-size:12px; color:var(--accent); margin-top:4px; font-style:italic">"${s.lesson}"</div>` : ''}
                    </div>
                    <div style="text-align:right">
                        <div class="trade-pips ${pipsClass}" style="font-size:18px">${pips > 0 ? '+' : ''}${pips.toFixed(1)}</div>
                        <div style="font-size:11px; color:var(--text-dim)">pips</div>
                        <div style="font-size:14px; color:var(--yellow); margin-top:2px">${stars}</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load history:', e);
    }
}

async function showSessionDetail(sessionId) {
    try {
        const sessions = await api('/api/sessions');
        const session = sessions.find(s => s.id === sessionId);
        if (!session) return;

        const detail = document.getElementById('history-detail');
        detail.classList.remove('hidden');

        const trades = session.trades || [];
        const health = session.health;

        detail.innerHTML = `
            <div class="flex-between mb-12">
                <div class="card-title" style="margin:0">${formatDate(session.start_time)} Session</div>
                <button class="btn btn-ghost btn-sm" onclick="document.getElementById('history-detail').classList.add('hidden')">Close</button>
            </div>

            <div class="stats-grid mb-12">
                <div class="stat-item">
                    <div class="stat-value">${session.mood_before || '--'}</div>
                    <div class="stat-label">Mood</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${session.sleep_hours || '--'}</div>
                    <div class="stat-label">Sleep (h)</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${session.readiness_score || '--'}</div>
                    <div class="stat-label">Readiness</div>
                </div>
                ${health && health.hr ? `
                <div class="stat-item">
                    <div class="stat-value">${health.hr.avg}</div>
                    <div class="stat-label">Avg HR</div>
                </div>` : ''}
                ${health && health.stress_level ? `
                <div class="stat-item">
                    <div class="stat-value">${health.stress_level}</div>
                    <div class="stat-label">Stress</div>
                </div>` : ''}
            </div>

            ${trades.length ? `
            <div class="card-title">Trades</div>
            ${trades.map(t => `
                <div class="trade-card">
                    <div style="display:flex; align-items:center; gap:12px">
                        <span class="trade-direction ${t.direction}">${(t.direction || '').toUpperCase()}</span>
                        <span style="font-size:13px; color:var(--text-dim)">${t.entry_time ? formatTime(t.entry_time) : ''}</span>
                        <span style="font-size:12px; color:var(--text-dim)">${t.emotion_before || ''}</span>
                        ${!t.per_plan ? '<span style="font-size:11px; color:var(--red)">RULE BREAK</span>' : ''}
                    </div>
                    <span class="trade-pips ${t.outcome === 'win' ? 'win' : (t.outcome === 'loss' ? 'loss' : '')}">${t.pnl_pips != null ? (t.pnl_pips > 0 ? '+' : '') + t.pnl_pips : '--'} pips</span>
                </div>
            `).join('')}` : '<p style="color:var(--text-dim); font-size:13px">No trades taken this session.</p>'}

            ${session.lesson ? `<div class="divider"></div><p style="font-style:italic; color:var(--accent); font-size:14px">"${session.lesson}"</p>` : ''}
            ${session.notes ? `<p style="color:var(--text-dim); font-size:13px; margin-top:8px">${session.notes}</p>` : ''}
        `;

        detail.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error(e);
    }
}

// ---- Analysis ----
async function loadAnalysis() {
    try {
        const [overview, correlations, insights] = await Promise.all([
            api('/api/analysis/overview'),
            api('/api/analysis/correlations'),
            api('/api/analysis/insights'),
        ]);

        renderOverview(overview);
        renderInsights(insights);
        renderCorrelationCharts(correlations);
    } catch (e) {
        console.error('Analysis error:', e);
    }
}

function renderOverview(data) {
    const el = document.getElementById('overview-stats');
    if (!data.total_sessions) {
        el.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px">No data yet. Complete your first session!</p>';
        return;
    }

    const pipsClass = data.total_pips > 0 ? 'positive' : (data.total_pips < 0 ? 'negative' : '');
    el.innerHTML = `
        <div class="stat-item">
            <div class="stat-value">${data.total_sessions}</div>
            <div class="stat-label">Sessions</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${data.total_trades}</div>
            <div class="stat-label">Trades</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${data.win_rate}%</div>
            <div class="stat-label">Win Rate</div>
        </div>
        <div class="stat-item">
            <div class="stat-value ${pipsClass}">${data.total_pips > 0 ? '+' : ''}${data.total_pips}</div>
            <div class="stat-label">Total Pips</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${data.risk_reward}R</div>
            <div class="stat-label">Risk:Reward</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${data.plan_adherence}%</div>
            <div class="stat-label">Discipline</div>
        </div>
    `;
}

function renderInsights(insights) {
    const el = document.getElementById('insights-list');
    if (!insights.length) {
        el.innerHTML = '<p style="color:var(--text-dim); padding:12px">Complete more sessions to unlock insights.</p>';
        return;
    }
    el.innerHTML = insights.map(i => `
        <div class="insight ${i.type}">
            <div class="insight-title">${i.title}</div>
            <div class="insight-text">${i.text}</div>
        </div>
    `).join('');
}

function renderCorrelationCharts(data) {
    if (data.message) return;

    const chartColors = {
        bg: 'rgba(59, 130, 246, 0.6)',
        border: '#3b82f6',
        green: 'rgba(34, 197, 94, 0.6)',
        red: 'rgba(239, 68, 68, 0.6)',
        yellow: 'rgba(234, 179, 8, 0.6)',
    };

    const defaultOpts = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
            y: {
                beginAtZero: true, max: 100,
                ticks: { color: '#64748b', callback: v => v + '%' },
                grid: { color: '#1e293b' },
            },
            x: { ticks: { color: '#64748b' }, grid: { display: false } }
        }
    };

    // Emotion chart
    if (data.by_emotion) {
        const ctx = document.getElementById('emotion-chart');
        if (window._emotionChart) window._emotionChart.destroy();
        const labels = Object.keys(data.by_emotion);
        const values = labels.map(k => data.by_emotion[k].win_rate);
        window._emotionChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: values.map(v => v >= 50 ? chartColors.green : chartColors.red),
                    borderRadius: 6,
                }]
            },
            options: defaultOpts,
        });
    }

    // Sleep chart
    if (data.by_sleep) {
        const ctx = document.getElementById('sleep-chart');
        if (window._sleepChart) window._sleepChart.destroy();
        const labels = Object.keys(data.by_sleep);
        const values = labels.map(k => data.by_sleep[k].win_rate);
        window._sleepChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: chartColors.bg,
                    borderRadius: 6,
                }]
            },
            options: defaultOpts,
        });
    }

    // Plan vs break chart
    if (data.plan_vs_break) {
        const ctx = document.getElementById('plan-chart');
        if (window._planChart) window._planChart.destroy();
        window._planChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Per Plan', 'Rule Break'],
                datasets: [{
                    label: 'Win Rate %',
                    data: [data.plan_vs_break.per_plan.win_rate, data.plan_vs_break.rule_break.win_rate],
                    backgroundColor: [chartColors.green, chartColors.red],
                    borderRadius: 6,
                }]
            },
            options: defaultOpts,
        });
    }

    // HR correlation chart (if available)
    if (data.by_heart_rate) {
        document.getElementById('hr-correlation-chart-container').classList.remove('hidden');
        const ctx = document.getElementById('hr-correlation-chart');
        if (window._hrCorChart) window._hrCorChart.destroy();
        const labels = Object.keys(data.by_heart_rate);
        const values = labels.map(k => data.by_heart_rate[k].win_rate);
        window._hrCorChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: values.map(v => v >= 50 ? chartColors.green : chartColors.red),
                    borderRadius: 6,
                }]
            },
            options: defaultOpts,
        });
    }
}

// ---- Setup / Health Import ----
async function uploadHealthExport(file) {
    if (!file) return;
    const statusEl = document.getElementById('import-status');
    const resultEl = document.getElementById('import-result');
    statusEl.textContent = `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`;
    statusEl.style.color = 'var(--yellow)';
    resultEl.classList.add('hidden');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/health-import?days_back=30', { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
            throw new Error(err.detail);
        }
        const data = await res.json();
        statusEl.textContent = 'Import complete!';
        statusEl.style.color = 'var(--green)';
        resultEl.classList.remove('hidden');
        resultEl.innerHTML = `
            <div class="stats-grid" style="max-width:500px">
                <div class="stat-item">
                    <div class="stat-value">${data.hr || 0}</div>
                    <div class="stat-label">HR Samples</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${data.hrv || 0}</div>
                    <div class="stat-label">HRV Samples</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${data.sleep_sessions || 0}</div>
                    <div class="stat-label">Sleep Records</div>
                </div>
            </div>
            <p style="font-size:12px; color:var(--text-dim); margin-top:12px">
                Data matched to your trading sessions by timestamp. Check History and Analysis tabs.
            </p>
        `;
    } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = 'var(--red)';
    }
}

// Drag and drop
const dropZone = document.getElementById('drop-zone');
if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; });
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--border)';
        if (e.dataTransfer.files.length) uploadHealthExport(e.dataTransfer.files[0]);
    });
}

// ---- Init ----
async function init() {
    try {
        const session = await api('/api/session/active');
        if (session.active) {
            state.activeSession = session;
            updateSessionUI();
        }
    } catch (e) {}
}

init();
