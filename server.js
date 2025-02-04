const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const cluster = require('cluster');
const WebSocket = require('ws');
const numCPUs = require('os').cpus().length;

// Cluster yapılandırmasını kaldır ve doğrudan Express uygulamasını başlat
const app = express();
const port = process.env.PORT || 3000;

// Trust proxy configuration - Add this before other middleware
app.set('trust proxy', 1);

// Handle broken pipe errors
process.on('SIGPIPE', () => {
    console.log('Caught SIGPIPE - ignoring');
});

// Handle stream errors
process.stdout.on('error', function(err) {
    if (err.code === 'EPIPE') {
        process.exit(0);
    }
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ 
    noServer: true,
    // Bağlantı limitleri ve timeout ayarları
    clientTracking: true,
    maxPayload: 50 * 1024, // 50KB max payload
});

let connectedClients = new Map(); // Set yerine Map kullanarak daha iyi yönetim

// WebSocket bağlantı yönetimi
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    const clientInfo = {
        ws,
        connectedAt: Date.now(),
        lastPing: Date.now(),
        isAlive: true
    };
    
    connectedClients.set(clientId, clientInfo);
    console.log(`New client ${clientId} connected, total:`, connectedClients.size);

    // Ping-pong mekanizması
    ws.on('pong', () => {
        const client = connectedClients.get(clientId);
        if (client) {
            client.isAlive = true;
            client.lastPing = Date.now();
        }
    });

    // Hata yönetimi
    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
        cleanupClient(clientId);
    });

    // Bağlantı kapandığında
    ws.on('close', () => {
        console.log(`Client ${clientId} disconnected`);
        cleanupClient(clientId);
    });
});

// Client cleanup fonksiyonu
function cleanupClient(clientId) {
    const client = connectedClients.get(clientId);
    if (client) {
        try {
            client.ws.terminate();
        } catch (err) {
            console.error(`Error terminating client ${clientId}:`, err);
        }
        connectedClients.delete(clientId);
    }
}

// Düzenli olarak bağlantıları kontrol et
const pingInterval = setInterval(() => {
    connectedClients.forEach((client, clientId) => {
        if (!client.isAlive) {
            console.log(`Client ${clientId} timed out`);
            return cleanupClient(clientId);
        }
        
        client.isAlive = false;
        try {
            client.ws.ping();
        } catch (err) {
            console.error(`Error pinging client ${clientId}:`, err);
            cleanupClient(clientId);
        }
    });
}, 30000); // Her 30 saniyede bir kontrol

// Broadcast fonksiyonunu güncelle
function broadcastData(data) {
    if (connectedClients.size === 0) return;

    const message = JSON.stringify(data);
    const failedClients = new Set();

    connectedClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(message);
            } catch (error) {
                console.error(`Broadcast error for client ${clientId}:`, error);
                failedClients.add(clientId);
            }
        } else {
            failedClients.add(clientId);
        }
    });

    // Başarısız clientları temizle
    failedClients.forEach(clientId => cleanupClient(clientId));
}

// Maksimum veri noktası sayısı
const MAX_DATA_POINTS = 1000; // Artırıldı
const SEND_DATA_LIMIT = 100;  // Artırıldı

// Memory kullanımını kontrol et
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`Memory usage: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
    if (used.heapUsed > 500 * 1024 * 1024) { // 500MB üzerinde
        console.log('High memory usage, clearing some data...');
        dataPoints.clear(); // Veri tamponunu temizle
    }
}, 30000);

// Veri saklama - Sadece en son veriyi tut
class DataBuffer {
    constructor() {
        this.latestData = null;
    }

    push(data) {
        this.latestData = {
            ...data,
            storedAt: Date.now()
        };
    }

    getLatest() {
        return this.latestData ? [this.latestData] : [];
    }

    clear() {
        this.latestData = null;
    }
}

const dataPoints = new DataBuffer();

// Güvenlik ayarları
app.use(helmet({
    contentSecurityPolicy: false,
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: { maxAge: 31536000, includeSubDomains: true },
    ieNoOpen: true,
    noSniff: true,
    xssFilter: true
}));

// CORS ve rate limiting ayarları
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 1000, // 1 saniye
    max: 200, // maksimum istek sayısı
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        console.log('Rate limit exceeded:', req.ip);
        res.status(429).json({
            error: 'Too many requests, please try again later.',
            retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
    }
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Body parser ayarları
app.use(express.json({ 
    limit: '500kb',
    strict: true,
    type: 'application/json'
}));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// API endpoints
app.post('/api/data', apiLimiter, (req, res) => {
    try {
        const data = req.body;
        
        // Veri validasyonu
        if (!data || !data.timestamp || !Array.isArray(data.harmonic)) {
            console.log('Invalid data received:', data);
            return res.status(400).json({ error: 'Invalid data format' });
        }

        // Veriyi sakla
        const storedData = {
            timestamp: data.timestamp,
            volt: Array.isArray(data.volt) ? data.volt : [],
            current: Array.isArray(data.current) ? data.current : [],
            power: Array.isArray(data.power) ? data.power : [],
            harmonic: data.harmonic,
            events: Array.isArray(data.events) ? data.events : [],
            receivedAt: Date.now()
        };
        
        dataPoints.push(storedData);

        // Veriyi broadcast et
        setImmediate(() => {
            try {
                broadcastData(storedData);
            } catch (error) {
                console.error('Broadcast error:', error);
            }
        });

        res.json({ 
            status: 'success',
            timestamp: data.timestamp,
            clientCount: connectedClients.size
        });
    } catch (error) {
        console.error('Error processing data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



function getNavbarHTML(currentPage) {
    const pages = [
        { name: 'Power Quality', path: '/' },
        { name: 'Events', path: '/events' },
        { name: 'Harmonics', path: '/harmonics' },
        { name: 'Graphs', path: '/graphs' }
    ];

    return `
    <nav class="navbar">
        <div class="navbar-brand">DCAC</div>
        <div class="navbar-links">
            ${pages.map(page => `
                <a href="${page.path}" class="nav-link ${currentPage === page.path ? 'active' : ''}">
                    ${page.name}
                </a>
            `).join('')}
        </div>
        <button id="reconnectBtn" class="reconnect-btn">
            <i class="fas fa-sync-alt"></i> Yenile
        </button>
    </nav>
    `;
}


// Debug middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    console.log('Headers:', req.headers);
    if (req.body) console.log('Body:', req.body);
    next();
});

// node_modules dizinini kontrol et
app.use((req, res, next) => {
    console.log('node_modules path:', path.join(__dirname, 'node_modules'));
    console.log('express path:', require.resolve('express'));
    next();
});

// Basit health check endpoint'i
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/api/data', (req, res) => {
    try {
        const data = dataPoints.getLatest();
        
        // Veri kontrolü
        if (!data || data.length === 0) {
            console.log('No data available');
            return res.json([]);
        }

        // Veri bütünlüğü kontrolü
        const validData = data.filter(item => 
            item && 
            item.timestamp && 
            Array.isArray(item.harmonic) && 
            item.harmonic.length > 0
        );

        if (validData.length === 0) {
            console.log('No valid data found');
            return res.json([]);
        }

        // Sadece en son veriyi gönder
        res.json(validData);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error',
            error: error.message 
        });
    }
});

// Yeni endpoint'ler ekleyelim
app.get('/api/power-quality', (req, res) => {
    try {
        const data = dataPoints.getLatest();
        
        if (!data || data.length === 0) {
            return res.json([]);
        }

        // Sadece güç kalitesi için gerekli verileri gönder
        const powerQualityData = data.map(item => ({
            timestamp: item.timestamp,
            volt: item.volt,
            current: item.current,
            power: item.power
        }));

        res.json(powerQualityData);
    } catch (error) {
        console.error('Error fetching power quality data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/harmonics', (req, res) => {
    try {
        const data = dataPoints.getLatest();
        
        if (!data || data.length === 0) {
            return res.json([]);
        }

        // Sadece harmonik verileri gönder
        const harmonicsData = data.map(item => ({
            timestamp: item.timestamp,
            harmonic: item.harmonic
        }));

        res.json(harmonicsData);
    } catch (error) {
        console.error('Error fetching harmonics data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/events', (req, res) => {
    try {
        const data = dataPoints.getLatest();
        
        if (!data || data.length === 0) {
            return res.json([]);
        }

        // Sadece olay verilerini gönder
        const eventsData = data.map(item => ({
            timestamp: item.timestamp,
            events: item.events
        }));

        res.json(eventsData);
    } catch (error) {
        console.error('Error fetching events data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Web arayüzü kısmını güncelle
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>DCAC Power Quality Analyzer | Real-time Power Monitoring</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta name="description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics. Advanced analytics for electrical systems.">
            <meta name="keywords" content="power quality analyzer, harmonics analysis, voltage monitoring, current monitoring, power monitoring, electrical analysis, power quality metrics">
            <meta name="author" content="DCAC Systems">
            <meta property="og:title" content="DCAC Power Quality Analyzer">
            <meta property="og:description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics.">
            <meta property="og:type" content="website">
            <meta property="og:url" content="https://oriontecno.com/">
            <meta name="twitter:card" content="summary_large_image">
            <meta name="twitter:title" content="DCAC Power Quality Analyzer">
            <meta name="twitter:description" content="Professional power quality analyzer for real-time monitoring of electrical systems">
            <link rel="canonical" href="https://oriontecno.com/">
            <link rel="icon" type="image/x-icon" href="./favicon.ico">
            <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" integrity="sha512-Evv84Mr4kqVGRNSgIGL/F/aIDqQb7xQ2vcrdIwxfjThSH8CSR7PBEakCr51Ck+w+/U6swU2Im1vVX0SVk9ABhg==" crossorigin="anonymous" referrerpolicy="no-referrer" />
            <style>
                :root {
                    --bg-color: #1a1a1a;
                    --text-color: #ffffff;
                    --card-bg: #2d2d2d;
                    --border-color: #404040;
                    --accent-color: #4299e1;
                    --hover-color: #3d3d3d;
                    --button-active: #3182ce;
                    --shadow: 0 8px 16px rgba(0,0,0,0.2);
                }
                
                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }
                
                body { 
                    font-family: 'Inter', system-ui, -apple-system, sans-serif;
                    margin: 0;
                    padding: 20px;
                    background-color: var(--bg-color);
                    color: var(--text-color);
                    min-height: 100vh;
                    line-height: 1.5;
                }
                
                .container {
                    max-width: 1400px; 
                    margin: 0 auto;
                    display: grid;
                    grid-template-columns: 1fr 220px;
                    gap: 24px;
                    padding: 20px;
                }
                
                h1 {
                    color: var(--text-color);
                    text-align: center;
                    margin-bottom: 30px;
                    font-size: 2.25em;
                    font-weight: 600;
                    grid-column: 1 / -1;
                    letter-spacing: -0.5px;
                    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
                }

                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                    grid-column: 1 / -1;
                }

                .metric-card {
                    background: linear-gradient(145deg, #1a1a1a, #2d2d2d);
                    border-radius: 15px;
                    padding: 1.5rem;
                    margin: 1rem;
                    box-shadow: 5px 5px 15px rgba(0,0,0,0.2);
                    transition: all 0.3s ease;
                }

                .metric-value {
                    font-family: 'Roboto Mono', monospace;
                    font-size: 2rem;
                    font-weight: 600;
                    color: #fff;
                    text-shadow: 0 0 10px rgba(255,255,255,0.3);
                    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .metric-unit {
                    font-size: 1rem;
                    color: #888;
                    margin-left: 0.5rem;
                }

                .metric-title {
                    font-size: 1.1rem;
                    color: #aaa;
                    margin-bottom: 0.5rem;
                }

                .value-number {
                    display: inline-block;
                    position: relative;
                    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .value-number.updating {
                    transform: scale(1.1);
                    color: #4CAF50;
                }

                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.02); }
                    100% { transform: scale(1); }
                }

                @keyframes glow {
                    0% { text-shadow: 0 0 10px rgba(255,255,255,0.3); }
                    50% { text-shadow: 0 0 20px rgba(255,255,255,0.5); }
                    100% { text-shadow: 0 0 10px rgba(255,255,255,0.3); }
                }

                .metric-card.updating {
                    animation: pulse 0.6s ease-in-out;
                }

                .value-number.updating {
                    animation: glow 0.6s ease-in-out;
                }

                /* Özel renk şemaları */
                .voltage-card { border-left: 4px solid #2ecc71; }
                .current-card { border-left: 4px solid #3498db; }
                .power-card { border-left: 4px solid #e74c3c; }

                /* Dark mode desteği */
                @media (prefers-color-scheme: dark) {
                    :root {
                        --bg-color: #1a202c;
                        --text-color: #e2e8f0;
                        --card-bg: #2d3748;
                        --border-color: #4a5568;
                        --hover-color: #2c5282;
                        --button-active: #3182ce;
                    }
                }

                /* Responsive tasarım ayarları aynı kalabilir */
                /* Tablet için responsive tasarım */
                @media (max-width: 1024px) {
                    .container {
                        grid-template-columns: 1fr 180px;
                        gap: 15px;
                    }

                    h1 {
                        font-size: 1.8em;
                    }
                }

                /* Mobil için responsive tasarım */
                @media (max-width: 768px) {
                    body {
                        padding: 5px;
                    }

                    .container {
                        grid-template-columns: 1fr;
                        gap: 10px;
                        display: flex;
                        flex-direction: column;
                    }

                    h1 {
                        font-size: 1.5em;
                        margin-bottom: 15px;
                    }
                }

                /* Küçük mobil cihazlar için ek düzenlemeler */
                @media (max-width: 480px) {
                    .container {
                        padding: 5px;
                    }

                    h1 {
                        font-size: 1.2em;
                    }

                }

                /* Loading animasyonu için yeni stiller */
                .loading-skeleton {
                    background: linear-gradient(
                        90deg,
                        var(--card-bg) 25%,
                        var(--hover-color) 50%,
                        var(--card-bg) 75%
                    );
                    background-size: 200% 100%;
                    animation: loading 1.5s infinite;
                    border-radius: 8px;
                    height: 24px;
                    width: 100%;
                }

                @keyframes loading {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }

                .loading-card {
                    opacity: 0.7;
                }

                .loading-value {
                    width: 80%;
                    height: 36px;
                    margin-top: 8px;
                }

                .loading-title {
                    width: 60%;
                    height: 20px;
                }

                .voltage-card {
                    background: linear-gradient(145deg, #ffffff, #f0f0f0);
                    border-radius: 15px;
                    padding: 1.5rem;
                    box-shadow: 5px 5px 15px rgba(0,0,0,0.1);
                    transition: transform 0.3s ease;
                }

                .voltage-card:hover {
                    transform: translateY(-5px);
                }

                .voltage-phase-a {
                    border-left: 4px solid #FF6B6B;
                }

                .voltage-phase-b {
                    border-left: 4px solid #4ECDC4;
                }

                .voltage-phase-c {
                    border-left: 4px solid #45B7D1;
                }

                .voltage-phase-n {
                    border-left: 4px solid #96CEB4;
                }

                .voltage-icon {
                    background: #f8f9fa;
                    padding: 0.8rem;
                    border-radius: 12px;
                    margin-right: 1rem;
                }

                .voltage-icon i {
                    font-size: 1.2rem;
                    color: #2d3436;
                }

                .metric-header {
                    display: flex;
                    align-items: center;
                    margin-bottom: 1rem;
                }

                .metric-title {
                    font-weight: 600;
                    color: #2d3436;
                    font-size: 1.1rem;
                }

                .metric-value {
                    display: flex;
                    align-items: baseline;
                    gap: 0.5rem;
                }

                .value-number {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: #2d3436;
                }

                .metric-unit {
                    font-size: 1rem;
                    color: #636e72;
                    font-weight: 500;
                }
                                .navbar {
                    background: var(--card-bg);
                    padding: 1rem 2rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    margin-bottom: 2rem;
                }

                .navbar-brand {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--accent-color);
                    letter-spacing: 0.5px;
                }

                .navbar-links {
                    display: flex;
                    gap: 1.5rem;
                    align-items: center;
                }

                .nav-link {
                    color: var(--text-color);
                    text-decoration: none;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    transition: all 0.3s ease;
                    font-weight: 500;
                    position: relative;
                }

                .nav-link:hover {
                    background: var(--hover-color);
                }

                .nav-link.active {
                    color: var(--accent-color);
                }

                .nav-link.active::after {
                    content: '';
                    position: absolute;
                    bottom: -2px;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: var(--accent-color);
                    border-radius: 2px;
                }

                /* Mobil responsive navbar */
                @media (max-width: 768px) {
                    .navbar {
                        flex-direction: column;
                        padding: 1rem;
                        gap: 1rem;
                    }

                    .navbar-links {
                        width: 100%;
                        overflow-x: auto;
                        padding-bottom: 0.5rem;
                        justify-content: flex-start;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                    }

                    .navbar-links::-webkit-scrollbar {
                        display: none;
                    }

                    .nav-link {
                        white-space: nowrap;
                        padding: 0.5rem 0.8rem;
                    }
                }

                /* Küçük ekranlar için ek düzenlemeler */
                @media (max-width: 480px) {
                    .navbar-brand {
                        font-size: 1.2rem;
                    }

                    .nav-link {
                        font-size: 0.9rem;
                        padding: 0.4rem 0.6rem;
                    }
                }
                </style>
                <script>
                    let currentRange = 0;
                    let lastFetchTime = 0;
                    let fetchInProgress = false;
                    let ws = null;
                    let reconnectAttempts = 0;
                    const MIN_FETCH_INTERVAL = 100;
                    const MAX_RECONNECT_ATTEMPTS = 5;
                    const RECONNECT_DELAY = 1000;
                    let updateInterval;


                    // Debounce fonksiyonu ekleyelim
                    function debounce(func, wait) {
                        let timeout;
                        return function executedFunction(...args) {
                            const later = () => {
                                clearTimeout(timeout);
                                func(...args);
                            };
                            clearTimeout(timeout);
                            timeout = setTimeout(later, wait);
                        };
                    }

                    // Hata yönetimi için retry mekanizması
                    async function fetchWithRetry(url, options, maxRetries = 3) {
                        let lastError;
                        
                        for (let i = 0; i < maxRetries; i++) {
                            try {
                                const response = await fetch(url, options);
                                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                                return await response.json();
                            } catch (error) {
                                lastError = error;
                                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                            }
                        }
                        throw lastError;
                    }

                    const debouncedUpdateMetrics = debounce(updateMetrics, 50);

                    function connectWebSocket() {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            console.log('WebSocket already connected');
                            return;
                        }

                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        const wsUrl = \`\${protocol}//\${window.location.host}\`;
                        
                        ws = new WebSocket(wsUrl);

                        ws.onopen = () => {
                            console.log('WebSocket connected');
                            reconnectAttempts = 0;
                            // Bağlantı başarılı olduğunda ilk veriyi al
                            fetchData();
                        };

                        ws.onmessage = (event) => {
                            try {
                                const data = JSON.parse(event.data);
                                if (data && data.harmonic) {
                                    requestAnimationFrame(() => {
                                        debouncedUpdateMetrics(data);
                                    });
                                }
                            } catch (error) {
                                console.error('WebSocket message error:', error);
                                // Hata durumunda loading durumunu göster
                                updateMetrics(null);
                            }
                        };

                        ws.onclose = () => {
                            console.log('WebSocket disconnected');
                            // Bağlantı koptuğunda loading durumunu göster
                            updateMetrics(null);
                            
                            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                setTimeout(() => {
                                    reconnectAttempts++;
                                    connectWebSocket();
                                }, RECONNECT_DELAY * Math.pow(2, reconnectAttempts));
                            }
                        };

                        ws.onerror = (error) => {
                            console.error('WebSocket error:', error);
                            // WebSocket hatası durumunda HTTP fetch'e geri dön
                            startPolling();
                        };
                    }

                    // HTTP polling için yeni fonksiyon
                    function startPolling() {
                        if (!updateInterval) {
                            updateInterval = setInterval(() => {
                                if (!document.hidden) {
                                    fetchData();
                                }
                            }, 500);
                        }
                    }

                    function stopPolling() {
                        if (updateInterval) {
                            clearInterval(updateInterval);
                            updateInterval = null;
                        }
                    }

                    async function fetchData() {
                        if (fetchInProgress || Date.now() - lastFetchTime < MIN_FETCH_INTERVAL) {
                            return;
                        }

                        fetchInProgress = true;
                        

                        try {
                            const data = await fetchWithRetry('/api/power-quality', {
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                cache: 'no-store'
                            });
                            
                            if (Array.isArray(data) && data.length > 0) {
                                const latestData = data[data.length - 1];
                                requestAnimationFrame(() => {
                                    debouncedUpdateMetrics(latestData);
                                });
                            }
                        } catch (error) {
                            console.error('Fetch error:', error);
                        } finally {
                            fetchInProgress = false;
                            lastFetchTime = Date.now();
                        }
                    }

                    // Sayfa yüklendiğinde
                    document.addEventListener('DOMContentLoaded', () => {
                        // WebSocket bağlantısını başlat
                        connectWebSocket();
                        
                        // Yedek olarak polling'i başlat
                        startPolling();
                    });

                    // Sayfa görünürlüğü değiştiğinde
                    document.addEventListener('visibilitychange', () => {
                        if (document.hidden) {
                            stopPolling();
                        } else {
                            // WebSocket bağlantısını kontrol et
                            if (!ws || ws.readyState !== WebSocket.OPEN) {
                                connectWebSocket();
                            }
                            startPolling();
                        }
                    });

                    // Sayfa kapatılırken temizlik
                    window.addEventListener('beforeunload', () => {
                        stopPolling();
                        if (ws) {
                            ws.close();
                        }
                    });
                    function updateMetrics(data) {
                        const metricsContainer = document.getElementById('metricsContainer');
                        if (!metricsContainer || !data) return;

                        // Voltage metrics
                        const voltHTML = data.volt.map((value, i) => \`
                            <div class="metric-card voltage-card voltage-phase-\${['a', 'b', 'c', 'n'][i]}">
                                <div class="metric-header">
                                    <div class="voltage-icon">
                                        <i class="fas fa-bolt"></i>
                                    </div>
                                    <div class="metric-title">Voltage \${['A', 'B', 'C', 'N'][i]}</div>
                                </div>
                                <div class="metric-value">
                                    <span class="value-number">\${value.toFixed(2)}</span>
                                    <span class="metric-unit">V</span>
                                </div>
                            </div>
                        \`).join('');

                        // Current metrics
                        const currentHTML = data.current.map((value, i) => \`
                            <div class="metric-card current-card">
                                <div class="metric-header">
                                    <div class="voltage-icon">
                                        <i class="fas fa-plug"></i>
                                    </div>
                                    <div class="metric-title">Current \${['A', 'B', 'C', 'N'][i]}</div>
                                </div>
                                <div class="metric-value">
                                    <span class="value-number">\${value.toFixed(2)}</span>
                                    <span class="metric-unit">A</span>
                                </div>
                            </div>
                        \`).join('');

                        // Power metrics
                        const powerHTML = \`
                            <div class="metric-card power-card">
                                <div class="metric-header">
                                    <div class="voltage-icon">
                                        <i class="fas fa-charging-station"></i>
                                    </div>
                                    <div class="metric-title">Active Power</div>
                                </div>
                                <div class="metric-value">
                                    <span class="value-number">\${data.power[0].toFixed(2)}</span>
                                    <span class="metric-unit">kW</span>
                                </div>
                            </div>
                            <div class="metric-card power-card">
                                <div class="metric-header">
                                    <div class="voltage-icon">
                                        <i class="fas fa-charging-station"></i>
                                    </div>
                                    <div class="metric-title">Reactive Power</div>
                                </div>
                                <div class="metric-value">
                                    <span class="value-number">\${data.power[1].toFixed(2)}</span>
                                    <span class="metric-unit">kVAR</span>
                                </div>
                            </div>
                            <div class="metric-card power-card">
                                <div class="metric-header">
                                    <div class="voltage-icon">
                                        <i class="fas fa-charging-station"></i>
                                    </div>
                                    <div class="metric-title">Apparent Power</div>
                                </div>
                                <div class="metric-value">
                                    <span class="value-number">\${data.power[2].toFixed(2)}</span>
                                    <span class="metric-unit">kVA</span>
                                </div>
                            </div>
                            \${data.power[3] ? data.power[3].map((value, i) => \`
                                <div class="metric-card power-card">
                                    <div class="metric-header">
                                        <div class="voltage-icon">
                                            <i class="fas fa-charging-station"></i>
                                        </div>
                                        <div class="metric-title">Power Factor \${['A', 'B', 'C'][i]}</div>
                                    </div>
                                    <div class="metric-value">
                                        <span class="value-number">\${value.toFixed(2)}</span>
                                    </div>
                                </div>
                            \`).join('') : ''}
                            \${data.power[4] ? data.power[4].map((value, i) => \`
                                <div class="metric-card power-card">
                                    <div class="metric-header">
                                        <div class="voltage-icon">
                                            <i class="fas fa-charging-station"></i>
                                        </div>
                                        <div class="metric-title">THD \${['A', 'B', 'C'][i]}</div>
                                    </div>
                                    <div class="metric-value">
                                        <span class="value-number">\${value.toFixed(2)}</span>
                                        <span class="metric-unit">%</span>
                                    </div>
                                </div>
                            \`).join('') : ''}
                        \`;

                        metricsContainer.innerHTML = voltHTML + currentHTML + powerHTML;
                    }


                </script>
            </head>
            <body>

                ${getNavbarHTML('/')}
                <div class="container">
                    <h1>DCAC Power Quality Analyzer</h1>
                    <div id="metricsContainer" class="metrics-grid"></div>
                </div>
            </body>
            </html>
        `);
    });




    app.get('/harmonics', (req, res) => {
        // Ranges tanımlaması
        const ranges = [
            { start: 0, end: 100, title: 'Voltage A', color: '#FF6B6B' },
            { start: 100, end: 200, title: 'Voltage B', color: '#4ECDC4' },
            { start: 200, end: 300, title: 'Voltage C', color: '#45B7D1' },
            { start: 300, end: 400, title: 'Voltage N', color: '#96CEB4' },
            { start: 400, end: 500, title: 'Current A', color: '#FFBE0B' },
            { start: 500, end: 600, title: 'Current B', color: '#FF006E' },
            { start: 600, end: 700, title: 'Current C', color: '#8338EC' },
            { start: 700, end: 800, title: 'Current N', color: '#3A86FF' }
        ];
    
        const buttonsHTML = ranges.map((range, i) => `
            <button 
                class="chart-button ${i === 0 ? 'active' : ''}" 
                onclick="selectRange(${i})"
                style="border-left: 4px solid ${range.color}"
            >
                ${range.title}
            </button>
        `).join('');
    
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Harmonics Analysis | DCAC Power Quality Analyzer</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
                <style>
                    /* Mevcut stil tanımlamaları */
                    .back-link {
                        display: inline-flex;
                        align-items: center;
                        color: var(--accent-color);
                        text-decoration: none;
                        font-size: 1.1em;
                        margin-bottom: 20px;
                        transition: transform 0.2s;
                    }
                    
                    .back-link:hover {
                        transform: translateX(-5px);
                    }
                    
                    .back-link i {
                        margin-right: 8px;
                    }

                                       :root {
                        --bg-color: #1a1a1a;
                        --text-color: #ffffff;
                        --card-bg: #2d2d2d;
                        --border-color: #404040;
                        --accent-color: #4299e1;
                        --hover-color: #3d3d3d;
                        --button-active: #3182ce;
                        --shadow: 0 8px 16px rgba(0,0,0,0.2);
                    }
                    
                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                    }
                    
                    body { 
                        font-family: 'Inter', system-ui, -apple-system, sans-serif;
                        margin: 0;
                        padding: 20px;
                        background-color: var(--bg-color);
                        color: var(--text-color);
                        min-height: 100vh;
                        line-height: 1.5;
                    }
                    
                    .container {
                        max-width: 1400px; 
                        margin: 0 auto;
                        display: grid;
                        grid-template-columns: 1fr 220px;
                        gap: 24px;
                        padding: 20px;
                    }
                    
                    h1 {
                        color: var(--text-color);
                        text-align: center;
                        margin-bottom: 30px;
                        font-size: 2.25em;
                        font-weight: 600;
                        grid-column: 1 / -1;
                        letter-spacing: -0.5px;
                        text-shadow: 0 2px 4px rgba(0,0,0,0.3);
                    }

                    .chart-container {
                        background: var(--card-bg);
                        padding: 24px;
                        border-radius: 20px;
                        box-shadow: var(--shadow);
                        height: 500px;
                        width: 100%;
                        border: 1px solid var(--border-color);
                        backdrop-filter: blur(10px);
                    }

                    .buttons-container {
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }

                    .chart-button {
                        background: var(--card-bg);
                        border: none;
                        color: var(--text-color);
                        padding: 16px;
                        border-radius: 12px;
                        cursor: pointer;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        text-align: left;
                        font-size: 0.95em;
                        width: 100%;
                        font-weight: 500;
                        box-shadow: var(--shadow);
                        position: relative;
                        overflow: hidden;
                    }

                    .chart-button:hover {
                        background: var(--hover-color);
                        transform: translateY(-2px) scale(1.02);
                        box-shadow: 0 12px 20px rgba(0,0,0,0.3);
                    }

                    .chart-button.active {
                        background: var(--button-active);
                        color: white;
                        transform: translateY(-1px);
                        box-shadow: 0 8px 16px rgba(0,0,0,0.4);
                    }

                    .chart-button::after {
                        content: '';
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: linear-gradient(45deg, transparent, rgba(255,255,255,0.1), transparent);
                        transition: 0.3s;
                    }

                    .chart-button:hover::after {
                        transform: translateX(100%);
                    }

                     /* Dark mode desteği */
                    @media (prefers-color-scheme: dark) {
                        :root {
                            --bg-color: #1a202c;
                            --text-color: #e2e8f0;
                            --card-bg: #2d3748;
                            --border-color: #4a5568;
                            --hover-color: #2c5282;
                            --button-active: #3182ce;
                        }
                    }

                    /* Responsive tasarım ayarları aynı kalabilir */
                    /* Tablet için responsive tasarım */
                    @media (max-width: 1024px) {
                        .container {
                            grid-template-columns: 1fr 180px;
                            gap: 15px;
                        }

                        .chart-container {
                            height: 400px;
                        }

                        h1 {
                            font-size: 1.8em;
                        }
                    }

                    /* Mobil için responsive tasarım */
                    @media (max-width: 768px) {
                        body {
                            padding: 5px;
                        }

                        .container {
                            grid-template-columns: 1fr;
                            gap: 10px;
                            display: flex;
                            flex-direction: column;
                        }

                        h1 {
                            font-size: 1.5em;
                            margin-bottom: 15px;
                        }

                        .chart-container {
                            height: 300px;
                            padding: 10px;
                            order: 1;
                        }

                        .buttons-container {
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                            gap: 5px;
                            order: 2;
                            position: relative;
                            z-index: 1;
                            background: var(--bg-color);
                            padding: 10px 0;
                        }

                        .chart-button {
                            padding: 8px;
                            font-size: 0.8em;
                            text-align: center;
                        }

                        .chart-button:hover {
                            transform: none;
                        }
                    }

                    /* Küçük mobil cihazlar için ek düzenlemeler */
                    @media (max-width: 480px) {
                        .container {
                            padding: 5px;
                        }

                        h1 {
                            font-size: 1.2em;
                        }

                        .chart-container {
                            height: 250px;
                        }

                        .buttons-container {
                            grid-template-columns: repeat(2, 1fr);
                        }
                    }



                                    .navbar {
                    background: var(--card-bg);
                    padding: 1rem 2rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    margin-bottom: 2rem;
                }

                .navbar-brand {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--accent-color);
                    letter-spacing: 0.5px;
                }

                .navbar-links {
                    display: flex;
                    gap: 1.5rem;
                    align-items: center;
                }

                .nav-link {
                    color: var(--text-color);
                    text-decoration: none;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    transition: all 0.3s ease;
                    font-weight: 500;
                    position: relative;
                }

                .nav-link:hover {
                    background: var(--hover-color);
                }

                .nav-link.active {
                    color: var(--accent-color);
                }

                .nav-link.active::after {
                    content: '';
                    position: absolute;
                    bottom: -2px;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: var(--accent-color);
                    border-radius: 2px;
                }

                /* Mobil responsive navbar */
                @media (max-width: 768px) {
                    .navbar {
                        flex-direction: column;
                        padding: 1rem;
                        gap: 1rem;
                    }

                    .navbar-links {
                        width: 100%;
                        overflow-x: auto;
                        padding-bottom: 0.5rem;
                        justify-content: flex-start;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                    }

                    .navbar-links::-webkit-scrollbar {
                        display: none;
                    }

                    .nav-link {
                        white-space: nowrap;
                        padding: 0.5rem 0.8rem;
                    }
                }

                /* Küçük ekranlar için ek düzenlemeler */
                @media (max-width: 480px) {
                    .navbar-brand {
                        font-size: 1.2rem;
                    }

                    .nav-link {
                        font-size: 0.9rem;
                        padding: 0.4rem 0.6rem;
                    }
                }


                </style>


                <script>
                    let currentChart = null;
                    let currentRange = 0;
                    let lastFetchTime = 0;
                    let fetchInProgress = false;
                    let ws = null;
                    let reconnectAttempts = 0;
                    const MIN_FETCH_INTERVAL = 100;
                    const MAX_RECONNECT_ATTEMPTS = 5;
                    const RECONNECT_DELAY = 1000;
                    let updateInterval;

                    // Ranges'i client-side'a aktar
                    const ranges = ${JSON.stringify(ranges)};

                    // Debounce fonksiyonu ekleyelim
                    function debounce(func, wait) {
                        let timeout;
                        return function executedFunction(...args) {
                            const later = () => {
                                clearTimeout(timeout);
                                func(...args);
                            };
                            clearTimeout(timeout);
                            timeout = setTimeout(later, wait);
                        };
                    }

                    // Hata yönetimi için retry mekanizması
                    async function fetchWithRetry(url, options, maxRetries = 3) {
                        let lastError;
                        
                        for (let i = 0; i < maxRetries; i++) {
                            try {
                                const response = await fetch(url, options);
                                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                                return await response.json();
                            } catch (error) {
                                lastError = error;
                                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                            }
                        }
                        throw lastError;
                    }

                    const debouncedUpdateChart = debounce(updateChart, 50);

                    function connectWebSocket() {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            console.log('WebSocket already connected');
                            return;
                        }

                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        const wsUrl = \`\${protocol}//\${window.location.host}\`;
                        
                        ws = new WebSocket(wsUrl);

                        ws.onopen = () => {
                            console.log('WebSocket connected');
                            reconnectAttempts = 0;
                            // Bağlantı başarılı olduğunda ilk veriyi al
                            fetchData();
                        };

                        ws.onmessage = (event) => {
                            try {
                                const data = JSON.parse(event.data);
                                if (data && data.harmonic) {
                                    requestAnimationFrame(() => {
                                        debouncedUpdateChart(data.harmonic, currentRange);
                                    });
                                }
                            } catch (error) {
                                console.error('WebSocket message error:', error);
                                // Hata durumunda loading durumunu göster
                            }
                        };

                        ws.onclose = () => {
                            console.log('WebSocket disconnected');
                            // Bağlantı koptuğunda loading durumunu göster
                            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                setTimeout(() => {
                                    reconnectAttempts++;
                                    connectWebSocket();
                                }, RECONNECT_DELAY * Math.pow(2, reconnectAttempts));
                            }
                        };

                        ws.onerror = (error) => {
                            console.error('WebSocket error:', error);
                            // WebSocket hatası durumunda HTTP fetch'e geri dön
                            startPolling();
                        };
                    }

                    // HTTP polling için yeni fonksiyon
                    function startPolling() {
                        if (!updateInterval) {
                            updateInterval = setInterval(() => {
                                if (!document.hidden) {
                                    fetchData();
                                }
                            }, 500);
                        }
                    }

                    function stopPolling() {
                        if (updateInterval) {
                            clearInterval(updateInterval);
                            updateInterval = null;
                        }
                    }

                    async function fetchData() {
                        if (fetchInProgress || Date.now() - lastFetchTime < MIN_FETCH_INTERVAL) {
                            return;
                        }

                        fetchInProgress = true;
                        

                        try {
                            const data = await fetchWithRetry('/api/harmonics', {
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                cache: 'no-store'
                            });
                            
                            if (Array.isArray(data) && data.length > 0) {
                                const latestData = data[data.length - 1];
                                requestAnimationFrame(() => {
                                    debouncedUpdateChart(latestData.harmonic, currentRange);
                                });
                            }
                        } catch (error) {
                            console.error('Fetch error:', error);
                        } finally {
                            fetchInProgress = false;
                            lastFetchTime = Date.now();
                        }
                    }

                    // Sayfa yüklendiğinde
                    document.addEventListener('DOMContentLoaded', () => {
                        // WebSocket bağlantısını başlat
                        connectWebSocket();
                        
                        // Yedek olarak polling'i başlat
                        startPolling();
                    });

                    // Sayfa görünürlüğü değiştiğinde
                    document.addEventListener('visibilitychange', () => {
                        if (document.hidden) {
                            stopPolling();
                        } else {
                            // WebSocket bağlantısını kontrol et
                            if (!ws || ws.readyState !== WebSocket.OPEN) {
                                connectWebSocket();
                            }
                            startPolling();
                        }
                    });

                    // Sayfa kapatılırken temizlik
                    window.addEventListener('beforeunload', () => {
                        stopPolling();
                        if (ws) {
                            ws.close();
                        }
                    });

                    function updateChart(harmonicData, rangeIndex) {
                        const range = ranges[rangeIndex];
                        const chartDiv = document.getElementById('harmonicChart');
                        

                        
                        const harmonicDataSlice = {
                            x: Array.from({length: range.end - range.start}, (_, i) => i + range.start + 1),
                            y: harmonicData.slice(range.start, range.end),
                            type: 'bar',
                            marker: {
                                color: harmonicData.slice(range.start, range.end).map(value => 
                                    \`rgba(74, 158, 255, \${0.3 + (value / Math.max(...harmonicData)) * 0.7})\`
                                )
                            }
                        };

                        const layout = {
                            paper_bgcolor: '#2d2d2d',
                            plot_bgcolor: '#2d2d2d',
                            font: { color: '#e0e0e0' },
                            title: {
                                text: range.title,
                                font: { size: 16 }
                            },
                            xaxis: {
                                title: 'Harmonic Index',
                                gridcolor: '#404040',
                                zerolinecolor: '#404040',
                                range: [range.start + 1, range.end]  // X ekseni aralığını ayarla
                            },
                            yaxis: {
                                title: 'Value',
                                gridcolor: '#404040',
                                zerolinecolor: '#404040'
                            },
                            margin: { t: 30, l: 60, r: 30, b: 60 }
                        };

                        if (!currentChart) {
                            Plotly.newPlot(chartDiv, [harmonicDataSlice], layout, {
                                responsive: true,
                                displayModeBar: false
                            });
                            currentChart = true;
                        } else {
                            Plotly.react(chartDiv, [harmonicDataSlice], layout, {
                                responsive: true,
                                displayModeBar: false
                            });
                        }

                        // Aktif butonu güncelle
                        document.querySelectorAll('.chart-button').forEach((btn, i) => {
                            btn.classList.toggle('active', i === rangeIndex);
                        });

                        document.getElementById('currentRange').textContent = range.title;
                    }

                    

                    function selectRange(index) {
                        if (index < 0 || index >= ranges.length) {
                            console.error('Invalid range index:', index);
                            return;
                        }
                        
                        console.log('Selecting range:', ranges[index].title);
                        currentRange = index;
                        fetchData();
                    }
                </script>

            </head>
            <body>
                ${getNavbarHTML('/harmonics')}
                <div class="container">
                    <a href="/" class="back-link">
                        <i class="fas fa-arrow-left"></i>
                        Back to Dashboard
                    </a>
                    <h1>Harmonics Analysis</h1>
                    <div class="chart-container">
                        <div id="harmonicChart"></div>
                    </div>
                    <div class="buttons-container">
                        ${buttonsHTML}
                    </div>
                </div>
                <script>
                    // Mevcut JavaScript kodları (WebSocket ve grafik güncelleme fonksiyonları)
                </script>
            </body>
            </html>
        `);
    });




    app.get('/events', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Events | DCAC Power Quality Analyzer</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta name="description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics. Advanced analytics for electrical systems.">
                <meta name="keywords" content="power quality analyzer, harmonics analysis, voltage monitoring, current monitoring, power monitoring, electrical analysis, power quality metrics">
                <meta name="author" content="DCAC Systems">
                <meta property="og:title" content="DCAC Power Quality Analyzer">
                <meta property="og:description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics.">
                <meta property="og:type" content="website">
                <meta property="og:url" content="https://oriontecno.com/">
                <meta name="twitter:card" content="summary_large_image">
                <meta name="twitter:title" content="DCAC Power Quality Analyzer">
                <meta name="twitter:description" content="Professional power quality analyzer for real-time monitoring of electrical systems">
                <link rel="canonical" href="https://oriontecno.com/">
                <link rel="icon" type="image/x-icon" href="./favicon.ico">
                <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" integrity="sha512-Evv84Mr4kqVGRNSgIGL/F/aIDqQb7xQ2vcrdIwxfjThSH8CSR7PBEakCr51Ck+w+/U6swU2Im1vVX0SVk9ABhg==" crossorigin="anonymous" referrerpolicy="no-referrer" />
                <style>
                    :root {
                        --bg-color: #1a1a1a;
                        --text-color: #ffffff;
                        --card-bg: #2d2d2d;
                        --border-color: #404040;
                        --accent-color: #4299e1;
                        --hover-color: #3d3d3d;
                        --button-active: #3182ce;
                        --shadow: 0 8px 16px rgba(0,0,0,0.2);
                    }
                    
                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                    }
                    
                    body { 
                        font-family: 'Inter', system-ui, -apple-system, sans-serif;
                        margin: 0;
                        padding: 20px;
                        background-color: var(--bg-color);
                        color: var(--text-color);
                        min-height: 100vh;
                        line-height: 1.5;
                    }
                    
                    .container {
                        max-width: 1400px; 
                        margin: 0 auto;
                        display: grid;
                        grid-template-columns: 1fr 220px;
                        gap: 24px;
                        padding: 20px;
                    }
                    
                    h1 {
                        color: var(--text-color);
                        text-align: center;
                        margin-bottom: 30px;
                        font-size: 2.25em;
                        font-weight: 600;
                        grid-column: 1 / -1;
                        letter-spacing: -0.5px;
                        text-shadow: 0 2px 4px rgba(0,0,0,0.3);
                    }

                    .metrics-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                        gap: 20px;
                        margin-bottom: 30px;
                        grid-column: 1 / -1;
                    }

                    .metric-card {
                        background: linear-gradient(145deg, #1a1a1a, #2d2d2d);
                        border-radius: 15px;
                        padding: 1.5rem;
                        margin: 1rem;
                        box-shadow: 5px 5px 15px rgba(0,0,0,0.2);
                        transition: all 0.3s ease;
                    }

                    .metric-value {
                        font-family: 'Roboto Mono', monospace;
                        font-size: 2rem;
                        font-weight: 600;
                        color: #fff;
                        text-shadow: 0 0 10px rgba(255,255,255,0.3);
                        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                    }

                    .metric-unit {
                        font-size: 1rem;
                        color: #888;
                        margin-left: 0.5rem;
                    }

                    .metric-title {
                        font-size: 1.1rem;
                        color: #aaa;
                        margin-bottom: 0.5rem;
                    }

                    .value-number {
                        display: inline-block;
                        position: relative;
                        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                    }

                    .value-number.updating {
                        transform: scale(1.1);
                        color: #4CAF50;
                    }

                    @keyframes pulse {
                        0% { transform: scale(1); }
                        50% { transform: scale(1.02); }
                        100% { transform: scale(1); }
                    }

                    @keyframes glow {
                        0% { text-shadow: 0 0 10px rgba(255,255,255,0.3); }
                        50% { text-shadow: 0 0 20px rgba(255,255,255,0.5); }
                        100% { text-shadow: 0 0 10px rgba(255,255,255,0.3); }
                    }

                    .metric-card.updating {
                        animation: pulse 0.6s ease-in-out;
                    }

                    .value-number.updating {
                        animation: glow 0.6s ease-in-out;
                    }

                    /* Özel renk şemaları */
                    .voltage-card { border-left: 4px solid #2ecc71; }
                    .current-card { border-left: 4px solid #3498db; }
                    .power-card { border-left: 4px solid #e74c3c; }

                    /* Dark mode desteği */
                    @media (prefers-color-scheme: dark) {
                        :root {
                            --bg-color: #1a202c;
                            --text-color: #e2e8f0;
                            --card-bg: #2d3748;
                            --border-color: #4a5568;
                            --hover-color: #2c5282;
                            --button-active: #3182ce;
                        }
                    }

                    /* Responsive tasarım ayarları aynı kalabilir */
                    /* Tablet için responsive tasarım */
                    @media (max-width: 1024px) {
                        .container {
                            grid-template-columns: 1fr 180px;
                            gap: 15px;
                        }

                        h1 {
                            font-size: 1.8em;
                        }
                    }

                    /* Mobil için responsive tasarım */
                    @media (max-width: 768px) {
                        body {
                            padding: 5px;
                        }

                        .container {
                            grid-template-columns: 1fr;
                            gap: 10px;
                            display: flex;
                            flex-direction: column;
                        }

                        h1 {
                            font-size: 1.5em;
                            margin-bottom: 15px;
                        }
                    }

                    /* Küçük mobil cihazlar için ek düzenlemeler */
                    @media (max-width: 480px) {
                        .container {
                            padding: 5px;
                        }

                        h1 {
                            font-size: 1.2em;
                        }

                    }

                    /* Loading animasyonu için yeni stiller */
                    .loading-skeleton {
                        background: linear-gradient(
                            90deg,
                            var(--card-bg) 25%,
                            var(--hover-color) 50%,
                            var(--card-bg) 75%
                        );
                        background-size: 200% 100%;
                        animation: loading 1.5s infinite;
                        border-radius: 8px;
                        height: 24px;
                        width: 100%;
                    }

                    @keyframes loading {
                        0% { background-position: 200% 0; }
                        100% { background-position: -200% 0; }
                    }

                    .loading-card {
                        opacity: 0.7;
                    }

                    .loading-value {
                        width: 80%;
                        height: 36px;
                        margin-top: 8px;
                    }

                    .loading-title {
                        width: 60%;
                        height: 20px;
                    }

                    .voltage-card {
                        background: linear-gradient(145deg, #ffffff, #f0f0f0);
                        border-radius: 15px;
                        padding: 1.5rem;
                        box-shadow: 5px 5px 15px rgba(0,0,0,0.1);
                        transition: transform 0.3s ease;
                    }

                    .voltage-card:hover {
                        transform: translateY(-5px);
                    }

                    .voltage-phase-a {
                        border-left: 4px solid #FF6B6B;
                    }

                    .voltage-phase-b {
                        border-left: 4px solid #4ECDC4;
                    }

                    .voltage-phase-c {
                        border-left: 4px solid #45B7D1;
                    }

                    .voltage-phase-n {
                        border-left: 4px solid #96CEB4;
                    }

                    .voltage-icon {
                        background: #f8f9fa;
                        padding: 0.8rem;
                        border-radius: 12px;
                        margin-right: 1rem;
                    }

                    .voltage-icon i {
                        font-size: 1.2rem;
                        color: #2d3436;
                    }

                    .metric-header {
                        display: flex;
                        align-items: center;
                        margin-bottom: 1rem;
                    }

                    .metric-title {
                        font-weight: 600;
                        color: #2d3436;
                        font-size: 1.1rem;
                    }

                    .metric-value {
                        display: flex;
                        align-items: baseline;
                        gap: 0.5rem;
                    }

                    .value-number {
                        font-size: 1.8rem;
                        font-weight: 700;
                        color: #2d3436;
                    }

                    .metric-unit {
                        font-size: 1rem;
                        color: #636e72;
                        font-weight: 500;
                    }
                                    .navbar {
                    background: var(--card-bg);
                    padding: 1rem 2rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    margin-bottom: 2rem;
                }

                .navbar-brand {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--accent-color);
                    letter-spacing: 0.5px;
                }

                .navbar-links {
                    display: flex;
                    gap: 1.5rem;
                    align-items: center;
                }

                .nav-link {
                    color: var(--text-color);
                    text-decoration: none;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    transition: all 0.3s ease;
                    font-weight: 500;
                    position: relative;
                }

                .nav-link:hover {
                    background: var(--hover-color);
                }

                .nav-link.active {
                    color: var(--accent-color);
                }

                .nav-link.active::after {
                    content: '';
                    position: absolute;
                    bottom: -2px;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: var(--accent-color);
                    border-radius: 2px;
                }

                /* Mobil responsive navbar */
                @media (max-width: 768px) {
                    .navbar {
                        flex-direction: column;
                        padding: 1rem;
                        gap: 1rem;
                    }

                    .navbar-links {
                        width: 100%;
                        overflow-x: auto;
                        padding-bottom: 0.5rem;
                        justify-content: flex-start;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                    }

                    .navbar-links::-webkit-scrollbar {
                        display: none;
                    }

                    .nav-link {
                        white-space: nowrap;
                        padding: 0.5rem 0.8rem;
                    }
                }

                /* Küçük ekranlar için ek düzenlemeler */
                @media (max-width: 480px) {
                    .navbar-brand {
                        font-size: 1.2rem;
                    }

                    .nav-link {
                        font-size: 0.9rem;
                        padding: 0.4rem 0.6rem;
                    }
                }
                </style>
                <script>
                    let currentRange = 0;
                    let lastFetchTime = 0;
                    let fetchInProgress = false;
                    let ws = null;
                    let reconnectAttempts = 0;
                    const MIN_FETCH_INTERVAL = 100;
                    const MAX_RECONNECT_ATTEMPTS = 5;
                    const RECONNECT_DELAY = 1000;
                    let updateInterval;


                    // Debounce fonksiyonu ekleyelim
                    function debounce(func, wait) {
                        let timeout;
                        return function executedFunction(...args) {
                            const later = () => {
                                clearTimeout(timeout);
                                func(...args);
                            };
                            clearTimeout(timeout);
                            timeout = setTimeout(later, wait);
                        };
                    }

                    // Hata yönetimi için retry mekanizması
                    async function fetchWithRetry(url, options, maxRetries = 3) {
                        let lastError;
                        
                        for (let i = 0; i < maxRetries; i++) {
                            try {
                                const response = await fetch(url, options);
                                if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
                                return await response.json();
                            } catch (error) {
                                lastError = error;
                                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                            }
                        }
                        throw lastError;
                    }

                    const debouncedUpdateMetrics = debounce(updateMetrics, 50);

                    function connectWebSocket() {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            console.log('WebSocket already connected');
                            return;
                        }

                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        const wsUrl = \`\${protocol}//\${window.location.host}\`;
                        
                        ws = new WebSocket(wsUrl);

                        ws.onopen = () => {
                            console.log('WebSocket connected');
                            reconnectAttempts = 0;
                            // Bağlantı başarılı olduğunda ilk veriyi al
                            fetchData();
                        };

                        ws.onmessage = (event) => {
                            try {
                                const data = JSON.parse(event.data);
                                if (data && data.harmonic) {
                                    requestAnimationFrame(() => {
                                        debouncedUpdateMetrics(data);
                                    });
                                }
                            } catch (error) {
                                console.error('WebSocket message error:', error);
                                // Hata durumunda loading durumunu göster
                                updateMetrics(null);
                            }
                        };

                        ws.onclose = () => {
                            console.log('WebSocket disconnected');
                            // Bağlantı koptuğunda loading durumunu göster
                            updateMetrics(null);
                            
                            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                setTimeout(() => {
                                    reconnectAttempts++;
                                    connectWebSocket();
                                }, RECONNECT_DELAY * Math.pow(2, reconnectAttempts));
                            }
                        };

                        ws.onerror = (error) => {
                            console.error('WebSocket error:', error);
                            // WebSocket hatası durumunda HTTP fetch'e geri dön
                            startPolling();
                        };
                    }

                    // HTTP polling için yeni fonksiyon
                    function startPolling() {
                        if (!updateInterval) {
                            updateInterval = setInterval(() => {
                                if (!document.hidden) {
                                    fetchData();
                                }
                            }, 500);
                        }
                    }

                    function stopPolling() {
                        if (updateInterval) {
                            clearInterval(updateInterval);
                            updateInterval = null;
                        }
                    }

                    async function fetchData() {
                        if (fetchInProgress || Date.now() - lastFetchTime < MIN_FETCH_INTERVAL) {
                            return;
                        }

                        fetchInProgress = true;
                        

                        try {
                            const data = await fetchWithRetry('/api/events', {
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                cache: 'no-store'
                            });
                            
                            if (Array.isArray(data) && data.length > 0) {
                                const latestData = data[data.length - 1];
                                requestAnimationFrame(() => {
                                    debouncedUpdateMetrics(latestData);
                                });
                            }
                        } catch (error) {
                            console.error('Fetch error:', error);
                        } finally {
                            fetchInProgress = false;
                            lastFetchTime = Date.now();
                        }
                    }

                    // Sayfa yüklendiğinde
                    document.addEventListener('DOMContentLoaded', () => {
                        // WebSocket bağlantısını başlat
                        connectWebSocket();
                        
                        // Yedek olarak polling'i başlat
                        startPolling();
                    });

                    // Sayfa görünürlüğü değiştiğinde
                    document.addEventListener('visibilitychange', () => {
                        if (document.hidden) {
                            stopPolling();
                        } else {
                            // WebSocket bağlantısını kontrol et
                            if (!ws || ws.readyState !== WebSocket.OPEN) {
                                connectWebSocket();
                            }
                            startPolling();
                        }
                    });

                    // Sayfa kapatılırken temizlik
                    window.addEventListener('beforeunload', () => {
                        stopPolling();
                        if (ws) {
                            ws.close();
                        }
                    });
                    function updateMetrics(data) {
                        // Events metrics
                        const eventsHTML = \`
                            <div style="display: block; width: 100%; max-width: 200%;">
                                <div class="metric-card events-card" style="background: linear-gradient(135deg, #c0392b, #e74c3c); border-radius: 12px; box-shadow: 0 8px 16px rgba(0,0,0,0.15); padding: 1.2rem; cursor: pointer; width: 100%;">
                                    <div class="metric-header" style="display: block; align-items: center; margin-bottom: 0.8rem;">
                                        <i class="fas fa-exclamation-triangle" style="color: #ffcdd2; font-size: clamp(1rem, 4vw, 1.4rem); margin-right: 0.8rem;"></i>
                                        <div class="metric-title" style="color: #ffebee; font-size: clamp(0.9rem, 3.5vw, 1.1rem); font-weight: 500;">Power Quality Events</div>
                                    </div>
                                    <div class="metric-value" style="color: #ffffff; font-size: clamp(1.4rem, 5vw, 1.8rem); font-weight: 600;">\${data.events.length}<span class="metric-unit" style="color: #ffcdd2; font-size: clamp(0.8rem, 3vw, 1rem); margin-left: 0.3rem;">events</span></div>
                                </div>
                                <div id="eventsList" style="display: block; background: rgba(231, 76, 60, 0.1); padding: 1rem; border-radius: 12px; width: 100%; overflow-x: auto;">
                                    <ul style="list-style: none; padding: 0; margin: 0; width: 100%;">
                                        \${data.events.map((event, index) =>  \`
                                            <li style="padding: 0.5rem; margin-bottom: 0.5rem; background: rgba(231, 76, 60, 0.2); border-radius: 8px; color: #c0392b; font-size: clamp(0.8rem, 3vw, 1rem); word-break: break-word;">
                                                Event # \${index + 1}:  \${event.toFixed(2)}
                                            </li>
                                         \`).join('')}
                                    </ul>
                                </div>
                            </div>
                        \`;

                        eventsContainer.innerHTML = eventsHTML;


                    }


                </script>
            </head>
            <body>

                ${getNavbarHTML('/events')}
                <div class="container">
                    <h1>DCAC Power Quality Events</h1>               
                    <div id="eventsContainer"></div>         
                </div>
            </body>
            </html>
        `);
    });
    
    // Yeni Graphs sayfası
    app.get('/graphs', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Graphs | DCAC Power Quality Analyzer</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta name="description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics. Advanced analytics for electrical systems.">
                <meta name="keywords" content="power quality analyzer, harmonics analysis, voltage monitoring, current monitoring, power monitoring, electrical analysis, power quality metrics">
                <meta name="author" content="DCAC Systems">
                <meta property="og:title" content="DCAC Power Quality Analyzer">
                <meta property="og:description" content="Professional power quality analyzer for real-time monitoring of voltage, current, harmonics and power quality metrics.">
                <meta property="og:type" content="website">
                <meta property="og:url" content="https://oriontecno.com/">
                <meta name="twitter:card" content="summary_large_image">
                <meta name="twitter:title" content="DCAC Power Quality Analyzer">
                <meta name="twitter:description" content="Professional power quality analyzer for real-time monitoring of electrical systems">
                <link rel="canonical" href="https://oriontecno.com/">
                <link rel="icon" type="image/x-icon" href="./favicon.ico">
                <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" integrity="sha512-Evv84Mr4kqVGRNSgIGL/F/aIDqQb7xQ2vcrdIwxfjThSH8CSR7PBEakCr51Ck+w+/U6swU2Im1vVX0SVk9ABhg==" crossorigin="anonymous" referrerpolicy="no-referrer" />
                <style>

                :root {
                        --bg-color: #1a1a1a;
                        --text-color: #ffffff;
                        --card-bg: #2d2d2d;
                        --border-color: #404040;
                        --accent-color: #4299e1;
                        --hover-color: #3d3d3d;
                        --button-active: #3182ce;
                        --shadow: 0 8px 16px rgba(0,0,0,0.2);
                    }
                    
                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                    }
                    
                    body { 
                        font-family: 'Inter', system-ui, -apple-system, sans-serif;
                        margin: 0;
                        padding: 20px;
                        background-color: var(--bg-color);
                        color: var(--text-color);
                        min-height: 100vh;
                        line-height: 1.5;
                    }
                    
                    .container {
                        max-width: 1400px; 
                        margin: 0 auto;
                        display: grid;
                        grid-template-columns: 1fr 220px;
                        gap: 24px;
                        padding: 20px;
                    }
                    
                    h1 {
                        color: var(--text-color);
                        text-align: center;
                        margin-bottom: 30px;
                        font-size: 2.25em;
                        font-weight: 600;
                        grid-column: 1 / -1;
                        letter-spacing: -0.5px;
                        text-shadow: 0 2px 4px rgba(0,0,0,0.3);
                    }

                                    .navbar {
                    background: var(--card-bg);
                    padding: 1rem 2rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    margin-bottom: 2rem;
                }

                .navbar-brand {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--accent-color);
                    letter-spacing: 0.5px;
                }

                .navbar-links {
                    display: flex;
                    gap: 1.5rem;
                    align-items: center;
                }

                .nav-link {
                    color: var(--text-color);
                    text-decoration: none;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    transition: all 0.3s ease;
                    font-weight: 500;
                    position: relative;
                }

                .nav-link:hover {
                    background: var(--hover-color);
                }

                .nav-link.active {
                    color: var(--accent-color);
                }

                .nav-link.active::after {
                    content: '';
                    position: absolute;
                    bottom: -2px;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: var(--accent-color);
                    border-radius: 2px;
                }

                /* Mobil responsive navbar */
                @media (max-width: 768px) {
                    .navbar {
                        flex-direction: column;
                        padding: 1rem;
                        gap: 1rem;
                    }

                    .navbar-links {
                        width: 100%;
                        overflow-x: auto;
                        padding-bottom: 0.5rem;
                        justify-content: flex-start;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                    }

                    .navbar-links::-webkit-scrollbar {
                        display: none;
                    }

                    .nav-link {
                        white-space: nowrap;
                        padding: 0.5rem 0.8rem;
                    }
                }

                /* Küçük ekranlar için ek düzenlemeler */
                @media (max-width: 480px) {
                    .navbar-brand {
                        font-size: 1.2rem;
                    }

                    .nav-link {
                        font-size: 0.9rem;
                        padding: 0.4rem 0.6rem;
                    }
                }
                </style>
            </head>
            <body>
                ${getNavbarHTML('/graphs')}
                <div class="container">
                    <h1>Power Quality Graphs</h1>
                    <div id="graphsContainer"></div>
                </div>
            </body>
            </html>
        `);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('SIGTERM signal received: closing HTTP server');
        clearInterval(pingInterval);
        
        // Tüm WebSocket bağlantılarını kapat
        connectedClients.forEach((client, clientId) => {
            cleanupClient(clientId);
        });

        server.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
    });

    const server = app.listen(port, () => {
        console.log(`Server started on port ${port}`);
    });

    // Keep-alive timeout ayarı
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    // WebSocket'i HTTP sunucusuna bağla
    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    // Export the Express API
    module.exports = app;
