// The service runs with the permissions of the TV application.
(function () {
    'use strict';
    var http = require('http');
    var child = null;
    var state = 'Ожидание';
    var diagnostic = '';
    var active = false;
    var retry = null;
    var attempts = 0;
    var serverAddress = '';

    function isLanAddress(value) {
        if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
        var parts = value.split('.').map(Number);
        return parts.every(function (n, i) { return n <= 255 && String(n) === value.split('.')[i]; }) &&
            (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
             (parts[0] === 192 && parts[1] === 168));
    }

    function report(message) {
        if (!serverAddress) return;
        try {
            var link = require('net').connect(26470, serverAddress, function () {
                link.end('@CU7100 ' + String(message).replace(/[\r\n]+/g, ' ').slice(-950) + '\n');
            });
            link.on('error', function () {});
            link.setTimeout(2500, function () { link.destroy(); });
        } catch (e) { console.log('Ambilight: ' + e.message); }
    }

    function start() {
        if (child || !active) return;
        state = 'Запуск GStreamer';
        diagnostic = '';
        attempts += 1;
        report('Starting capture');
        var args = [
            '-e', '-q', 'smsrcavsource', 'avtype=1', 'host=localhost', 'port=48819',
            '!', 'smsrcvideoenc', 'enc-type=0', 'src-w=1920', 'src-h=1080',
            'dst-w=1920', 'dst-h=1080', 'frame-rate=3000', 'bitrate=4000000',
            '!', 'h264parse', 'config-interval=-1', '!', 'mpegtsmux',
            '!', 'tcpclientsink', 'host=' + serverAddress, 'port=26470'
        ];
        try {
            child = require('child_process').spawn('gst-launch-1.0', args, {stdio: ['ignore', 'ignore', 'pipe']});
        } catch (error) {
            state = 'Запуск недоступен';
            diagnostic = error.message;
            report(diagnostic);
            child = null;
            return;
        }
        state = 'Процесс запущен. Приём кадров проверяется в Hyperion.';
        child.stderr.on('data', function (data) {
            diagnostic = (diagnostic + data.toString()).slice(-1800);
        });
        child.on('error', function (error) {
            state = 'Ошибка запуска';
            diagnostic = error.message;
        });
        var started = Date.now();
        child.on('close', function (code, signal) {
            child = null;
            if (Date.now() - started > 30000) attempts = 0;
            state = active ? 'Захват завершился (' + (signal || code) + ')' : 'Остановлено';
            report(state + ' ' + diagnostic);
            if (active && attempts < 3) retry = setTimeout(start, 4000);
        });
    }

    function stop() {
        active = false;
        clearTimeout(retry);
        if (child) child.kill('SIGTERM');
        state = 'Остановлено';
    }

    var api = http.createServer(function (req, res) {
        var origin = req.headers.origin;
        if (origin && origin !== 'http://127.0.0.1:8081' && origin !== 'http://localhost:8081') { res.writeHead(403); return res.end(); }
        if (origin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Headers', 'X-Ambilight, X-Receiver');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (req.method === 'POST' && req.headers['x-ambilight'] === '1') {
            if (req.url === '/stop') stop();
            else if (req.url === '/start') {
                var address = req.headers['x-receiver'] || '';
                if (!isLanAddress(address)) { res.writeHead(400); return res.end(); }
                if (child && address !== serverAddress) { res.writeHead(409); return res.end(); }
                serverAddress = address;
                clearTimeout(retry);
                active = true;
                attempts = 0;
                start();
            } else { res.writeHead(404); return res.end(); }
        } else if (req.method !== 'GET' || req.url !== '/status') {
            res.writeHead(404);
            return res.end();
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({state: state, detail: diagnostic}));
    });
    api.on('error', function (error) { console.log('Ambilight: ' + error.message); });
    api.listen(28663, '127.0.0.1', start);
}());
