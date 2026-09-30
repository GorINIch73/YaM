'use strict';

var util = require('util');
var http = require('http');
var https = require('https');
var url = require('url');
var querystring = require('querystring');
var crypto = require('crypto');
var libQ = require('kew');

// MPD requires 'Content-Type: audio/flac' for FLAC streams. See flac_mime_types[] at
// https://github.com/volumio/volumio-mpd/blob/master/src/decoder/plugins/FlacDecoderPlugin.cxx
// So we create proxy to change response headers from 'Content-Type: audio/mpeg'
// to 'Content-Type: audio/flac'

function getKey(key) {
    return new Uint8Array(key.match(/.{1,2}/g).map(pair => parseInt(pair, 16)));
}

function getIV(block) {
    const counter = new Uint8Array(16);
    var value = block;
    for (var i = 0; i < 16; ++i) {
        counter[15 - i] = value & 0xFF;
        value >>= 8;
    }
    return counter;
}

function pipeline(src, dst, key) {
    var decipher;

    if (key) {
        decipher = crypto.createDecipheriv('aes-128-ctr', getKey(key), getIV(0));
    }

    src.on('data', (chunk) => {
        var data = chunk;
        if (key) {
            data = decipher.update(data);
        }
        if (!dst.write(data)) {
            //src.pause();
        }
    });
    src.on('end', () => {
        dst.end();
    });
    src.on('error', (err) => {
        dst.end();
    });
    dst.on('drain', () => {
        src.resume();
    });
    dst.on('close', () => {
        src.destroy();
    });
    dst.on('error', (err) => {
        src.destroy();
    });
}

function Proxy(logger) {
    var self = this;

    self.logger = logger;
    self.server = false;
    self.port = false;
    self.startPromise = false;
};

Proxy.prototype.start = function() {
    var self = this;

    if (self.server) {
        return self.startPromise || libQ.resolve(self.port);
    }
    self.server = http.createServer(function (req, res) {
        try {
            var query = url.parse(req.url, true);
            var req_codec = query.query['codec'];
            var req_transport = query.query['transport'];
            var req_key = query.query['key'];
            var req_url = query.query['url'];
            var req_url_info = url.parse(req_url);
            var req_headers = req.headers;
            delete req_headers['host'];
            const options = {
                host: req_url_info.hostname,
                port: req_url_info.port,
                path: req_url_info.path,
                headers: req_headers,
            };
            const key = (req_transport == 'encraw') ? req_key : false;
            const proxy = https.request(options, function (r) {
                if (req_codec == 'flac') {
                    r.headers['content-type'] = 'audio/flac';
                } else if (req_codec == 'flac-mp4') {
                    r.headers['content-type'] = 'audio/mp4';
                } else if (req_codec == 'aac') {
                    r.headers['content-type'] = 'audio/x-aac';
                }
                res.writeHead(r.statusCode, r.headers);
                //r.pipe(res);
                pipeline(r, res, key);
            });
            req.pipe(proxy);
        } catch (e) {
            res.end();
        }
    });
    var server = self.server;
    var defer = libQ.defer();
    var listening = false;

    server.on('error', function (err) {
        if (!listening) {
            self.server = false;
            self.port = false;
            self.startPromise = false;
            defer.reject(err);
        } else if (self.logger && self.logger.error) {
            self.logger.error('YaM proxy server error', err);
        }
    });

    server.listen(0, '127.0.0.1', function () {
        listening = true;
        self.port = server.address().port;
        defer.resolve(self.port);
    });
    self.startPromise = defer.promise;
    return self.startPromise;
};

Proxy.prototype.stop = function() {
    var self = this;

    if (self.server) {
        self.server.close();
        self.server = false;
    }
    self.port = false;
    self.startPromise = false;
};

module.exports = Proxy;
