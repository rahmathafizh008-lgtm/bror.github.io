// ========== AUTHENTICATION & DASHBOARD LOGIC ==========
// Kredensial
const VALID_USER = 'admin';
const VALID_PASS = 'admin123';

// State global
let state = {
    gasValue: 0,
    objectTemp: 0,
    roomTemp: 0,
    humidity: 0,
    status: 'AMAN',
    ledGreen: false,
    ledYellow: false,
    ledRed: false,
    relay: false,
    buzzer: false,
    thresholds: {
        gas: 2000,
        fireDanger: 70,
        fireWarn: 50,
        roomHot: 40,
        humDry: 50,
    },
    logs: [],
    history: {
        gas: Array(20).fill(0),
        objTemp: Array(20).fill(0),
        roomTemp: Array(20).fill(0),
        hum: Array(20).fill(0),
    },
    mqttConnected: false
};

let mqttClient = null;
let charts = {};
let currentLogFilter = 'all';

// Konfigurasi MQTT (gunakan WebSocket broker publik)
const BROKER = 'ws://broker.emqx.io:8083/mqtt';
const TOPIC = 'fire_detector/data';

// ========== UTILITIES ==========
function showToast(msg, duration = 2500) {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
    }
}

// ========== LOGIKA STATUS DARURAT ==========
function determineStatusFallback() {
    const th = state.thresholds;
    if (state.objectTemp >= th.fireDanger && state.gasValue >= th.gas && state.roomTemp >= 35) return 'BAHAYA';
    if (state.gasValue >= th.gas && state.objectTemp >= th.fireWarn) return 'WASPADA';
    if (state.gasValue >= th.gas) return 'GAS_TERDETEKSI';
    if (state.objectTemp >= th.fireWarn) return 'API_TERDETEKSI';
    if (state.roomTemp > th.roomHot) return 'RUANGAN_PANAS';
    if (state.humidity < th.humDry) return 'RUANGAN_KERING';
    return 'AMAN';
}

function applyOutputsByStatus(status) {
    state.ledGreen = state.ledYellow = state.ledRed = state.relay = state.buzzer = false;
    if (status === 'BAHAYA') {
        state.ledRed = state.relay = state.buzzer = true;
    } else if (['WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI', 'RUANGAN_PANAS'].includes(status)) {
        state.ledYellow = state.buzzer = true;
    } else if (status === 'RUANGAN_KERING') {
        // nothing
    } else {
        state.ledGreen = true;
    }
}

// ========== LOG & HISTORY ==========
function pushHistory() {
    state.history.gas.push(state.gasValue);
    state.history.objTemp.push(state.objectTemp);
    state.history.roomTemp.push(state.roomTemp);
    state.history.hum.push(state.humidity);
    ['gas', 'objTemp', 'roomTemp', 'hum'].forEach(k => {
        if (state.history[k].length > 20) state.history[k] = state.history[k].slice(-20);
    });
    updateSparklines();
}

function addLog(eventType, detail) {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    state.logs.unshift({
        time, eventType, detail,
        status: state.status,
        gas: state.gasValue,
        objTemp: state.objectTemp.toFixed(1),
        roomTemp: state.roomTemp.toFixed(1),
        hum: state.humidity.toFixed(1)
    });
    if (state.logs.length > 100) state.logs.pop();
    renderLogs();
}

function renderLogs() {
    const tbody = document.getElementById('logBody');
    if (!tbody) return;
    let data = state.logs;
    if (currentLogFilter === 'status') data = data.filter(l => l.eventType === 'status_change');
    if (currentLogFilter === 'sensor') data = data.filter(l => l.eventType === 'sensor_update' || l.eventType === 'threshold_change');
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="log-empty">📡 Menunggu data dari sensor...</td></tr>';
        return;
    }
    tbody.innerHTML = data.map(l => {
        let badgeClass = l.status === 'BAHAYA' ? 'badge-danger' :
                        (['WASPADA','GAS_TERDETEKSI','API_TERDETEKSI','RUANGAN_PANAS','RUANGAN_KERING'].includes(l.status) ? 'badge-warning' : 'badge-aman');
        return `<tr>
            <td>${l.time}</td>
            <td><small>${l.detail}</small></td>
            <td><span class="status-badge ${badgeClass}" style="padding:4px 12px;font-size:0.7rem;">${l.status}</span></td>
            <td>${l.gas}</td>
            <td>${l.objTemp}</td>
            <td>${l.roomTemp}</td>
            <td>${l.hum}</td>
        </tr>`;
    }).join('');
}

// ========== UI UPDATE ==========
function updateUI() {
    const valGas = document.getElementById('val-gas');
    const valObj = document.getElementById('val-objTemp');
    const valRoom = document.getElementById('val-roomTemp');
    const valHum = document.getElementById('val-hum');
    if (valGas) valGas.textContent = state.gasValue;
    if (valObj) valObj.textContent = state.objectTemp.toFixed(1);
    if (valRoom) valRoom.textContent = state.roomTemp.toFixed(1);
    if (valHum) valHum.textContent = state.humidity.toFixed(1);

    // Critical class
    [valGas, valObj, valRoom, valHum].forEach(el => el?.classList.remove('crit'));
    if (state.gasValue >= state.thresholds.gas) valGas?.classList.add('crit');
    if (state.objectTemp >= state.thresholds.fireWarn) valObj?.classList.add('crit');
    if (state.roomTemp > state.thresholds.roomHot) valRoom?.classList.add('crit');
    if (state.humidity < state.thresholds.humDry) valHum?.classList.add('crit');

    // Progress bars
    const maxVals = { gas: 4095, objTemp: 100, roomTemp: 60, hum: 100 };
    ['gas', 'objTemp', 'roomTemp', 'hum'].forEach(k => {
        let val = state[k === 'gas' ? 'gasValue' : k === 'objTemp' ? 'objectTemp' : k === 'roomTemp' ? 'roomTemp' : 'humidity'];
        let fill = document.getElementById(`fill-${k}`);
        if (fill) fill.style.width = `${Math.min((val / maxVals[k]) * 100, 100)}%`;
    });

    // LEDs
    const ledGreen = document.getElementById('ledGreen');
    const ledYellow = document.getElementById('ledYellow');
    const ledRed = document.getElementById('ledRed');
    if (ledGreen) ledGreen.className = `led-dot ${state.ledGreen ? 'on-green' : ''}`;
    if (ledYellow) ledYellow.className = `led-dot ${state.ledYellow ? 'on-yellow' : ''}`;
    if (ledRed) ledRed.className = `led-dot ${state.ledRed ? 'on-red' : ''}`;
    const ledLabel = document.getElementById('ledLabel');
    if (ledLabel) ledLabel.textContent = state.ledGreen ? 'Hijau (Aman)' : state.ledYellow ? 'Kuning (Waspada)' : state.ledRed ? 'Merah (Bahaya!)' : 'Semua Mati';

    // Relay & Buzzer
    const relayIcon = document.getElementById('relayIcon');
    const relayLabel = document.getElementById('relayLabel');
    if (relayIcon) relayIcon.textContent = state.relay ? '⚡' : '🔌';
    if (relayLabel) relayLabel.textContent = state.relay ? 'AKTIF' : 'OFF';
    const buzzerIcon = document.getElementById('buzzerIcon');
    const buzzerLabel = document.getElementById('buzzerLabel');
    if (buzzerIcon) buzzerIcon.textContent = state.buzzer ? '🔊' : '🔇';
    if (buzzerLabel) buzzerLabel.textContent = state.buzzer ? 'Berbunyi!' : 'Diam';

    // Status Badge & App Icon
    const badge = document.getElementById('statusBadge');
    const icon = document.getElementById('appIcon');
    const fireOverlay = document.getElementById('fireOverlay');
    if (badge) badge.classList.remove('badge-aman', 'badge-warning', 'badge-danger');
    if (icon) icon.classList.remove('icon-aman', 'icon-warning', 'icon-danger');
    if (fireOverlay) fireOverlay.classList.remove('active');

    let displayText = '';
    if (state.status === 'BAHAYA') {
        if (badge) badge.classList.add('badge-danger');
        if (icon) icon.classList.add('icon-danger');
        if (icon && icon.querySelector('i')) icon.querySelector('i').className = 'fas fa-skull';
        displayText = '🚨 BAHAYA! KEBAKARAN!';
        if (fireOverlay) fireOverlay.classList.add('active');
    } else if (['WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI', 'RUANGAN_PANAS'].includes(state.status)) {
        if (badge) badge.classList.add('badge-warning');
        if (icon) icon.classList.add('icon-warning');
        if (icon && icon.querySelector('i')) icon.querySelector('i').className = 'fas fa-exclamation-triangle';
        displayText = `⚠️ ${state.status.replace(/_/g, ' ')}`;
    } else if (state.status === 'RUANGAN_KERING') {
        if (badge) badge.classList.add('badge-warning');
        if (icon) icon.classList.add('icon-warning');
        if (icon && icon.querySelector('i')) icon.querySelector('i').className = 'fas fa-droplet-slash';
        displayText = '💧 RUANGAN KERING';
    } else {
        if (badge) badge.classList.add('badge-aman');
        if (icon) icon.classList.add('icon-aman');
        if (icon && icon.querySelector('i')) icon.querySelector('i').className = 'fas fa-shield-halved';
        displayText = '✅ SISTEM AMAN';
    }
    if (badge) badge.innerHTML = `<span>${displayText}</span>`;

    // Risk Score
    let score = state.status === 'BAHAYA' ? 100 :
                ['WASPADA','GAS_TERDETEKSI','API_TERDETEKSI'].includes(state.status) ? 70 :
                state.status === 'RUANGAN_PANAS' ? 40 :
                state.status === 'RUANGAN_KERING' ? 20 : 5;
    const scoreCircle = document.getElementById('scoreCircle');
    if (scoreCircle) {
        scoreCircle.textContent = score + '%';
        scoreCircle.classList.remove('score-low', 'score-mid', 'score-high');
        if (score >= 70) scoreCircle.classList.add('score-high');
        else if (score >= 30) scoreCircle.classList.add('score-mid');
        else scoreCircle.classList.add('score-low');
    }
    const scoreDesc = document.getElementById('scoreDesc');
    if (scoreDesc) scoreDesc.textContent = state.status === 'AMAN' ? 'Semua sensor dalam batas normal' : 'Ada indikasi risiko kebakaran';

    let triggers = (state.gasValue >= state.thresholds.gas ? 1 : 0) +
                   (state.objectTemp >= state.thresholds.fireWarn ? 1 : 0) +
                   (state.roomTemp > state.thresholds.roomHot ? 1 : 0) +
                   (state.humidity < state.thresholds.humDry ? 1 : 0);
    const triggerText = document.getElementById('triggerText');
    if (triggerText) triggerText.textContent = `${triggers}/4 sensor terpicu`;
}

// ========== SPARKLINES (Chart.js) ==========
function initSparklines() {
    const configs = [
        { id: 'gas', color: '#8b5cf6' },
        { id: 'objTemp', color: '#ef4444' },
        { id: 'roomTemp', color: '#3b82f6' },
        { id: 'hum', color: '#10b981' }
    ];
    configs.forEach(c => {
        const ctx = document.getElementById(`spark-${c.id}`);
        if (ctx) {
            charts[c.id] = new Chart(ctx, {
                type: 'line',
                data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderColor: c.color, backgroundColor: c.color + '20', borderWidth: 2, fill: true, pointRadius: 0, tension: 0.3 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } }
            });
        }
    });
}

function updateSparklines() {
    ['gas', 'objTemp', 'roomTemp', 'hum'].forEach(k => {
        if (charts[k]) {
            charts[k].data.datasets[0].data = [...state.history[k]];
            charts[k].update();
        }
    });
}

// ========== BUILD UI DINAMIS ==========
function buildUI() {
    const sensorGrid = document.getElementById('sensorGrid');
    if (sensorGrid) {
        const sensors = [
            { id: 'gas', label: 'MQ2 - Sensor Gas', unit: 'analog', icon: 'fa-wind', color: '#8b5cf6' },
            { id: 'objTemp', label: 'MLX90614 - Suhu Api', unit: '°C', icon: 'fa-fire', color: '#ef4444' },
            { id: 'roomTemp', label: 'DHT22 - Suhu Ruangan', unit: '°C', icon: 'fa-temperature-high', color: '#3b82f6' },
            { id: 'hum', label: 'DHT22 - Kelembaban', unit: '%', icon: 'fa-droplet', color: '#10b981' }
        ];
        sensorGrid.innerHTML = sensors.map(s => `
            <div class="sensor-card">
                <div class="sensor-header">
                    <div class="sensor-icon" style="background:${s.color}20; color:${s.color}"><i class="fas ${s.icon}"></i></div>
                    <span style="font-size:0.7rem;color:var(--text-secondary);">${s.label}</span>
                </div>
                <div class="sensor-value" id="val-${s.id}">0</div>
                <span style="font-size:0.75rem;color:var(--text-secondary);">${s.unit}</span>
                <div class="sparkline-wrap"><canvas id="spark-${s.id}"></canvas></div>
                <div class="threshold-bar"><div class="threshold-fill" id="fill-${s.id}" style="width:0%;background:${s.color};"></div></div>
            </div>
        `).join('');
    }

    const outputGrid = document.getElementById('outputGrid');
    if (outputGrid) {
        outputGrid.innerHTML = `
            <div class="output-card">
                <p style="font-size:0.7rem;font-weight:600;color:var(--text-secondary);">LED Indikator</p>
                <div class="led-triple"><span class="led-dot" id="ledGreen"></span><span class="led-dot" id="ledYellow"></span><span class="led-dot" id="ledRed"></span></div>
                <small id="ledLabel" style="color:var(--text-secondary);">Hijau (Aman)</small>
            </div>
            <div class="output-card">
                <p style="font-size:0.7rem;font-weight:600;color:var(--text-secondary);">Relay Alarm</p>
                <div style="font-size:2rem;" id="relayIcon">🔌</div>
                <small id="relayLabel" style="color:var(--text-secondary);">OFF</small>
            </div>
            <div class="output-card">
                <p style="font-size:0.7rem;font-weight:600;color:var(--text-secondary);">Buzzer</p>
                <div style="font-size:2rem;" id="buzzerIcon">🔇</div>
                <small id="buzzerLabel" style="color:var(--text-secondary);">Diam</small>
            </div>
            <div class="output-card">
                <p style="font-size:0.7rem;font-weight:600;color:var(--text-secondary);">MQTT Broker</p>
                <div style="font-size:2rem;" id="mqttIcon">🟠</div>
                <small id="mqttLabel">Menunggu data</small>
            </div>
        `;
    }
}

// ========== MQTT CONNECTION ==========
function connectMQTT() {
    if (mqttClient) {
        try { mqttClient.end(true); } catch(e) {}
    }
    mqttClient = mqtt.connect(BROKER);
    window.mqttClient = mqttClient;

    mqttClient.on('connect', () => {
        state.mqttConnected = true;
        const connDot = document.getElementById('connDot');
        const connLabel = document.getElementById('connLabel');
        const mqttIcon = document.getElementById('mqttIcon');
        const mqttLabel = document.getElementById('mqttLabel');
        if (connDot) connDot.classList.add('connected');
        if (connLabel) connLabel.innerHTML = 'MQTT: Terhubung';
        if (mqttIcon) mqttIcon.innerHTML = '🟢';
        if (mqttLabel) mqttLabel.innerText = 'Subscribe OK';
        mqttClient.subscribe(TOPIC, (err) => { if (!err) showToast('✅ Terhubung ke broker MQTT real-time', 2000); });
    });

    mqttClient.on('message', (topic, message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.gas !== undefined) state.gasValue = Number(data.gas);
            if (data.objectTemp !== undefined) state.objectTemp = Number(data.objectTemp);
            if (data.roomTemp !== undefined) state.roomTemp = Number(data.roomTemp);
            if (data.humidity !== undefined) state.humidity = Number(data.humidity);

            let newStatus = data.status ? data.status.toUpperCase() : determineStatusFallback();
            const validStatuses = ['BAHAYA', 'WASPADA', 'GAS_TERDETEKSI', 'API_TERDETEKSI', 'RUANGAN_PANAS', 'RUANGAN_KERING', 'AMAN'];
            if (!validStatuses.includes(newStatus)) newStatus = 'AMAN';
            const oldStatus = state.status;
            state.status = newStatus;
            applyOutputsByStatus(state.status);
            pushHistory();
            updateUI();
            if (oldStatus !== state.status) addLog('status_change', `Status berubah: ${oldStatus} → ${state.status}`);
            else addLog('sensor_update', 'Update data real-time dari MQTT');
        } catch(e) { console.warn('MQTT parse error:', e); }
    });

    mqttClient.on('error', (err) => {
        state.mqttConnected = false;
        const connDot = document.getElementById('connDot');
        const connLabel = document.getElementById('connLabel');
        const mqttIcon = document.getElementById('mqttIcon');
        const mqttLabel = document.getElementById('mqttLabel');
        if (connDot) connDot.classList.remove('connected');
        if (connLabel) connLabel.innerHTML = 'MQTT: Error';
        if (mqttIcon) mqttIcon.innerHTML = '🔴';
        if (mqttLabel) mqttLabel.innerText = 'Koneksi gagal';
        showToast('❌ Koneksi MQTT terputus', 3000);
    });
}

// ========== EVENT LISTENERS ==========
function initEventListeners() {
    // Threshold modal
    const btnThreshold = document.getElementById('btnThreshold');
    if (btnThreshold) {
        btnThreshold.addEventListener('click', () => {
            document.getElementById('thGas').value = state.thresholds.gas;
            document.getElementById('thFireDanger').value = state.thresholds.fireDanger;
            document.getElementById('thFireWarn').value = state.thresholds.fireWarn;
            document.getElementById('thRoomHot').value = state.thresholds.roomHot;
            document.getElementById('thHumDry').value = state.thresholds.humDry;
            document.getElementById('thresholdModal').classList.add('active');
        });
    }
    const saveThreshold = document.getElementById('saveThresholdBtn');
    if (saveThreshold) {
        saveThreshold.addEventListener('click', () => {
            state.thresholds.gas = parseInt(document.getElementById('thGas').value) || 2000;
            state.thresholds.fireDanger = parseFloat(document.getElementById('thFireDanger').value) || 70;
            state.thresholds.fireWarn = parseFloat(document.getElementById('thFireWarn').value) || 50;
            state.thresholds.roomHot = parseFloat(document.getElementById('thRoomHot').value) || 40;
            state.thresholds.humDry = parseFloat(document.getElementById('thHumDry').value) || 50;
            document.getElementById('thresholdModal').classList.remove('active');
            addLog('threshold_change', 'Threshold sensor diperbarui');
            showToast('✅ Threshold berhasil disimpan', 2000);
            updateUI();
        });
    }
    const closeModal = document.getElementById('closeModalBtn');
    const cancelModal = document.getElementById('cancelModalBtn');
    if (closeModal) closeModal.addEventListener('click', () => document.getElementById('thresholdModal').classList.remove('active'));
    if (cancelModal) cancelModal.addEventListener('click', () => document.getElementById('thresholdModal').classList.remove('active'));

    // Clear log
    const clearLog = document.getElementById('btnClearLog');
    if (clearLog) {
        clearLog.addEventListener('click', () => {
            state.logs = [];
            renderLogs();
            showToast('🗑️ Riwayat log dihapus', 1500);
        });
    }

    // Log filters
    document.querySelectorAll('.log-filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            currentLogFilter = this.dataset.filter;
            renderLogs();
        });
    });
}

// ========== DASHBOARD INIT ==========
function initDashboard() {
    buildUI();
    initSparklines();
    initEventListeners();
    connectMQTT();
    applyOutputsByStatus('AMAN');
    updateUI();
}

// ========== AUTHENTICATION SYSTEM ==========
document.addEventListener('DOMContentLoaded', function() {
    const loginOverlay = document.getElementById('loginOverlay');
    const dashboardWrapper = document.getElementById('dashboardWrapper');
    const loginBtn = document.getElementById('loginBtn');
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    const logoutBtn = document.getElementById('logoutBtn');
    const darkToggle = document.getElementById('darkToggle');

    // Dark mode
    if (localStorage.getItem('fireguard_dark') === 'true') document.body.classList.add('dark');
    if (darkToggle) {
        darkToggle.addEventListener('click', () => {
            document.body.classList.toggle('dark');
            localStorage.setItem('fireguard_dark', document.body.classList.contains('dark'));
        });
    }

    function checkAuth() {
        if (sessionStorage.getItem('fireguard_logged_in') === 'true') {
            if (loginOverlay) loginOverlay.style.display = 'none';
            if (dashboardWrapper) dashboardWrapper.style.display = 'block';
            initDashboard();
        } else {
            if (loginOverlay) loginOverlay.style.display = 'flex';
            if (dashboardWrapper) dashboardWrapper.style.display = 'none';
        }
    }

    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            if (loginUsername.value.trim() === VALID_USER && loginPassword.value === VALID_PASS) {
                sessionStorage.setItem('fireguard_logged_in', 'true');
                checkAuth();
                showToast('✅ Selamat datang, Admin!', 2000);
            } else {
                showToast('❌ Username atau password salah!', 2000);
                loginPassword.value = '';
            }
        });
    }
    if (loginPassword) {
        loginPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') loginBtn.click(); });
    }
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            sessionStorage.removeItem('fireguard_logged_in');
            if (mqttClient) mqttClient.end(true);
            checkAuth();
            showToast('🔓 Anda telah keluar', 1500);
        });
    }
    checkAuth();
});