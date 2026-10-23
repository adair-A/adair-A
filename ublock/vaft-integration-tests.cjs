// Run from any directory: node --test outputs/vaft-integration-tests.cjs (Node.js 18+).
// VAFT_SCRIPT may point at another candidate resource. No network or browser is used.
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const resource = fs.readFileSync(process.env.VAFT_SCRIPT || path.join(__dirname, 'vaft-ublock-origin.js'), 'utf8');
// Match the resource boundary that matters in uBlock's userResourcesLocation loader.
const lines = resource.split(/\r?\n/);
assert.equal(lines.shift(), 'twitch-videoad.js text/javascript');
const boundary = lines.findIndex(line => /^\s*$/.test(line));
const source = (boundary < 0 ? lines : lines.slice(0, boundary)).join('\n');
const originalUrl = 'blob:https://www.twitch.tv/01234567-original';
const masterUrl = 'https://usher.ttvnw.net/api/channel/hls/example.m3u8?sig=original&token=original&parent_domains=example.com';
const mediaUrl = 'https://video-weaver.example.net/live/1080.m3u8?token=media';
const backupUrl = 'https://video-weaver.example.net/backup/1080.m3u8?token=backup';
const adSegment = 'https://video-edge.example.net/stitched-ad-100.ts';
const liveSegment = 'https://video-edge.example.net/live-101.ts';
const master = (url = mediaUrl) => [
    '#EXTM3U',
    '#EXT-X-TWITCH-INFO:SERVER-TIME="1720000000.25"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
    url,
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001F,mp4a.40.2",FRAME-RATE=60.000',
    'https://video-weaver.example.net/live/720.m3u8',
    ''
].join('\n');
const cleanMedia = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:101',
    '#EXTINF:2.000,live', liveSegment, '#EXT-X-TWITCH-PREFETCH:https://video-edge.example.net/live-102.ts', ''
].join('\n');
const adMedia = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2024-07-03T09:46:40.000Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-URL="https://tracking.example/ad",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://tracking.example/click"',
    '#EXTINF:2.000,Amazon', adSegment, '#EXT-X-DISCONTINUITY',
    '#EXTINF:2.000,live', liveSegment,
    '#EXT-X-TWITCH-PREFETCH:https://video-edge.example.net/stitched-ad-102.ts', ''
].join('\n');

const urlOf = input => input instanceof Request ? input.url : String(input);
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const scenario of [
    { name: 'keeps source quality immediately after reload', resolutions: ['1920x1080', '1920x1080', '640x360'], expected: 'embed', requests: 1 },
    { name: 'upgrades past a clean 360p candidate to a matching source backup', resolutions: ['640x360', '1920x1080', '640x360'], expected: 'popout', requests: 2 },
    { name: 'retains the best clean quality when no exact match exists', resolutions: ['1280x720', '854x480', '640x360'], expected: 'embed', requests: 3 },
    { name: 'keeps 360p as a last resort when source backups contain ads', resolutions: ['1920x1080', '1920x1080', '640x360'], dirty: ['embed', 'popout'], expected: 'autoplay', requests: 3 }
]) {
    test('quality selection ' + scenario.name, async () => {
        const types = ['embed', 'popout', 'autoplay'];
        const h = setup({
            windowFetch: async (input, init) => {
                const type = JSON.parse(init.body).variables.playerType;
                return Response.json({ data: { streamPlaybackAccessToken: { signature: type, value: 'quality-token' } } });
            },
            workerFetch: async input => {
                const url = new URL(urlOf(input));
                if (url.pathname.includes('/channel/hls/')) {
                    const type = url.searchParams.get('sig');
                    if (!types.includes(type)) return new Response(master());
                    const res = scenario.resolutions[types.indexOf(type)];
                    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=' + res + ',FRAME-RATE=60,CODECS="avc1.64002A"\nhttps://quality.example/' + type + '.m3u8');
                }
                if (url.href === mediaUrl) return new Response(adMedia);
                if (url.hostname === 'quality.example') {
                    const type = url.pathname.slice(1).replace('.m3u8', '');
                    return new Response(scenario.dirty?.includes(type) ? adMedia : cleanMedia.replace(liveSegment, 'https://quality.example/' + type + '.ts'));
                }
                throw new Error('Unexpected quality request: ' + url.href);
            }
        });
        await h.worker.context.fetch(masterUrl);
        // Intentionally keep the reload timestamp recent to exercise the former 360p shortcut.
        const response = await h.worker.context.fetch(mediaUrl);
        const body = await response.text();
        assert.ok(body.includes('https://quality.example/' + scenario.expected + '.ts'));
        assert.ok(!body.includes('stitched-ad'));
        assert.equal(h.mainCalls.length, scenario.requests);
        assert.deepEqual(h.errors, []);
    });
}

function setup({ windowFetch = async () => new Response('{}'), workerFetch = async () => new Response('ok') } = {}) {
    let now = 1720000000000;
    let nextTimer = 1;
    const blobs = new Map();
    const revoked = [];
    const timers = new Map();
    const mainCalls = [];
    const nativeCalls = [];
    const errors = [];
    class ClockDate extends Date { static now() { return now; } }
    class BrowserURL extends URL {
        static createObjectURL(blob) {
            const url = `blob:https://www.twitch.tv/generated-${blobs.size}`;
            blobs.set(url, blob.parts.join(''));
            return url;
        }
        static revokeObjectURL(url) { revoked.push(url); blobs.delete(url); }
    }
    class BrowserBlob { constructor(parts) { this.parts = parts; } }
    class NativeWorker {
        static toString() { return 'function Worker() { [native code] }'; }
        constructor(url, options) {
            this.url = url;
            this.options = options;
            this.listeners = [];
            this.errorListeners = [];
            this.messages = [];
            this.received = [];
            this.terminated = false;
            if (!blobs.has(String(url))) return;
            const owner = this;
            const workerListeners = [];
            this.context = vm.createContext({
                console: { log() {}, error() {} }, URL: BrowserURL, Request, Response, Headers, AbortController, Date: ClockDate,
                setTimeout(callback, delay) {
                    const id = nextTimer++;
                    timers.set(id, { owner, callback, at: now + delay });
                    return id;
                },
                clearTimeout(id) { timers.delete(id); },
                fetch: async (input, init) => {
                    nativeCalls.push({ input, init });
                    return workerFetch(input, init);
                },
                XMLHttpRequest: class {
                    open(method, url, async) {
                        assert.equal(method, 'GET');
                        assert.equal(url, originalUrl);
                        assert.equal(async, false);
                    }
                    overrideMimeType(type) { assert.equal(type, 'text/javascript'); }
                    send() {
                        this.responseText = 'self.originalBooted = true; self.fetchSeenByOriginal = fetch;';
                    }
                },
                addEventListener(type, callback) { if (type === 'message') workerListeners.push(callback); },
                postMessage(data) {
                    owner.messages.push(structuredClone(data));
                    queueMicrotask(() => {
                        if (owner.terminated) return;
                        for (const listener of owner.listeners) {
                            Promise.resolve(listener({ data: structuredClone(data) })).catch(error => errors.push(error));
                        }
                    });
                }
            });
            this.context.self = this.context;
            this.workerListeners = workerListeners;
            vm.runInContext(blobs.get(String(url)), this.context, { filename: 'generated-twitch-worker.js' });
        }
        addEventListener(type, callback) {
            if (type === 'message') this.listeners.push(callback);
            if (type === 'error') this.errorListeners.push(callback);
        }
        postMessage(data) {
            // Browsers ignore messages to terminated workers. Record attempts to detect retained instances.
            this.received.push(structuredClone(data));
            queueMicrotask(() => {
                if (!this.terminated) for (const listener of this.workerListeners || []) listener({ data: structuredClone(data) });
            });
        }
        terminate() {
            this.terminated = true;
            for (const [id, timer] of timers) if (timer.owner === this) timers.delete(id);
        }
    }
    const context = vm.createContext({
        console: { log() {}, error() {} }, URL: BrowserURL, Request, Response, Headers, AbortController, Blob: BrowserBlob, Worker: NativeWorker,
        document: {
            baseURI: 'https://www.twitch.tv/example', location: { hostname: 'www.twitch.tv' },
            readyState: 'loading', querySelector() { return null; }
        },
        addEventListener() {}, setTimeout() { return 0; }, clearTimeout() {},
        fetch: async (input, init) => {
            mainCalls.push({ input, init });
            return windowFetch(input, init);
        }
    });
    context.window = context;
    vm.runInContext(source, context, { filename: 'uBlock-loaded-resource.js' });
    const worker = new context.Worker(originalUrl, { name: 'player-worker' });
    assert.ok(worker.context, 'the complete resource must install and execute the generated worker');
    return {
        context, worker, mainCalls, nativeCalls, timers, revoked, errors,
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) {
                timers.delete(id);
                timer.callback();
            }
        },
        evaluate(code) { return vm.runInContext(code, worker.context); }
    };
}

test('complete uBlock resource executes original worker after installing fetch hook', async () => {
    const h = setup();
    assert.equal(h.worker.context.originalBooted, true);
    assert.equal(h.worker.context.fetchSeenByOriginal, h.worker.context.fetch);
    assert.equal(h.worker.options.name, 'player-worker');
    const plain = new h.context.Worker('https://example.org/worker.js');
    assert.equal(plain.context, undefined, 'unrelated workers use the original constructor');
    assert.equal(h.context.twitchAdSolutionsVersion >= 24, true);
    await h.worker.context.fetch('https://video-edge.example.net/live-1.ts');
    assert.equal(h.nativeCalls.length, 1);
});

test('generated-worker GraphQL bridge preserves response status, headers, body and propagates network errors', async () => {
    let mode = 'success';
    const h = setup({ windowFetch: async () => {
        if (mode === 'error') throw new Error('offline in main page');
        if (mode === 'empty') return new Response(null, { status: 204, headers: { 'x-empty': 'yes' } });
        return new Response('{"result":"ok"}', { status: 201, statusText: 'Created', headers: { 'x-bridge': 'retained' } });
    } });
    await h.context.fetch('https://gql.twitch.tv/gql', { headers: { 'X-Device-Id': 'device-123', Authorization: "Bearer quote'\\value" } });
    await flush();
    const response = await h.evaluate('gqlRequest({operationName:"Integration"}, "embed")');
    assert.equal(response.status, 201);
    assert.equal(response.statusText, 'Created');
    assert.equal(response.headers.get('x-bridge'), 'retained');
    assert.equal(await response.text(), '{"result":"ok"}');
    assert.equal(h.mainCalls.at(-1).init.headers['X-Device-Id'], 'device-123');
    assert.equal(h.mainCalls.at(-1).init.headers.Authorization, "Bearer quote'\\value");
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.equal(h.timers.size, 0);
    mode = 'empty';
    const empty = await h.evaluate('gqlRequest({})');
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');
    mode = 'error';
    await assert.rejects(h.evaluate('gqlRequest({})'), /offline in main page/);
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.errors, []);
});

test('bridge timeout cleans pending entry and ignores a late main-page response', async () => {
    let finish;
    const h = setup({ windowFetch: () => new Promise(resolve => { finish = resolve; }) });
    const request = h.evaluate('gqlRequest({})');
    const rejected = assert.rejects(request, /timed out/);
    await flush();
    assert.equal(h.evaluate('pendingFetchRequests.size'), 1);
    h.advance(15000);
    await rejected;
    await flush();
    assert.equal(h.mainCalls[0].init.signal.aborted, true, 'timeout must abort the corresponding page fetch');
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    finish(new Response('{}'));
    await flush();
    await flush();
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.errors, []);
});

for (const inputKind of ['string', 'URL', 'Request']) {
    test(`master to ad media to clean backup works with ${inputKind} fetch inputs`, async () => {
        const h = setup({
            windowFetch: async () => Response.json({ data: { streamPlaybackAccessToken: { signature: 'backup-sig', value: 'backup-token' } } }),
            workerFetch: async input => {
                const url = new URL(urlOf(input));
                if (url.pathname.includes('/channel/hls/')) return new Response(master(url.searchParams.get('sig') === 'backup-sig' ? backupUrl : mediaUrl));
                if (url.href === mediaUrl) return new Response(adMedia, { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'x-original': 'kept' } });
                if (url.href === backupUrl) return new Response(cleanMedia);
                throw new Error(`unexpected worker request: ${url}`);
            }
        });
        const input = url => inputKind === 'Request' ? new Request(url, { headers: { 'x-player': 'player' } }) : inputKind === 'URL' ? new h.worker.context.URL(url) : url;
        const masterResponse = await h.worker.context.fetch(input(masterUrl));
        assert.match(await masterResponse.text(), /1920x1080/);
        h.advance(2000); // Let the normal post-reload throttle expire.
        const response = await h.worker.context.fetch(input(mediaUrl));
        assert.equal(await response.text(), cleanMedia, 'a known media playlist with stitched ads must be replaced by the clean backup');
        assert.equal(response.headers.get('x-original'), 'kept');
        assert.equal(h.mainCalls.length, 1, 'backup token request must traverse the actual message bridge');
        const body = JSON.parse(h.mainCalls[0].init.body);
        assert.equal(body.variables.login, 'example');
        assert.equal(body.variables.playerType, 'embed');
        assert.equal(new URL(urlOf(h.nativeCalls[0].input)).searchParams.has('parent_domains'), false);
        if (inputKind === 'Request') assert.equal(new Headers(h.nativeCalls[0].init?.headers || h.nativeCalls[0].input.headers).get('x-player'), 'player');
        assert.ok(h.worker.messages.some(message => message.key === 'UpdateAdBlockBanner' && message.hasAds));
        assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
        assert.deepEqual(h.errors, []);
    });
}

test('unavailable backups strip ad segment fetches and prefetch/tracking, then announce ad completion', async () => {
    let showingAd = true;
    const h = setup({
        windowFetch: async () => new Response('unavailable', { status: 503 }),
        workerFetch: async input => {
            const url = urlOf(input);
            if (url.includes('/channel/hls/')) return new Response(master());
            if (url === mediaUrl) return new Response(showingAd ? adMedia : cleanMedia);
            if (url.startsWith('data:video/mp4;base64,')) return new Response('replacement video');
            if (url === liveSegment) return new Response('live video');
            throw new Error(`unblocked or unexpected request: ${url}`);
        }
    });
    await h.worker.context.fetch(masterUrl);
    h.advance(2000);
    const response = await h.worker.context.fetch(mediaUrl);
    const body = await response.text();
    assert.ok(!body.includes('https://tracking.example/'));
    assert.ok(!body.includes('#EXT-X-TWITCH-PREFETCH:'));
    assert.equal(await (await h.worker.context.fetch(adSegment)).text(), 'replacement video');
    assert.equal(await (await h.worker.context.fetch(liveSegment)).text(), 'live video');
    assert.equal(h.nativeCalls.some(call => urlOf(call.input) === adSegment), false);
    assert.ok(h.worker.messages.some(message => message.key === 'UpdateAdBlockBanner' && message.isStrippingAdSegments && message.numStrippedAdSegments === 1));
    showingAd = false;
    assert.equal(await (await h.worker.context.fetch(mediaUrl)).text(), cleanMedia);
    await flush();
    assert.ok(h.worker.messages.some(message => message.key === 'ReloadPlayer'));
    assert.equal(h.worker.messages.at(-1).hasAds, false);
    assert.deepEqual(h.errors, []);
});

test('terminated workers are removed from broadcasts and their generated Blob URL is released', async () => {
    const h = setup();
    h.worker.terminate();
    assert.equal(h.worker.terminated, true);
    const before = h.worker.received.length;
    h.context.simulateAds(1);
    await flush();
    assert.equal(h.worker.received.length, before, 'script must stop retaining/broadcasting to a terminated worker');
    assert.ok(h.revoked.includes(String(h.worker.url)), 'generated worker Blob URL must be revoked by termination');
});

test('a rejected cached-playlist probe rebuilds master state after a stream restart', async () => {
    const restartedUrl = 'https://video-weaver.example.net/restarted/1080.m3u8';
    let requests = 0;
    const h = setup({ workerFetch: async input => {
        const url = urlOf(input);
        if (url.includes('/channel/hls/')) return new Response(master(++requests === 1 ? mediaUrl : restartedUrl));
        if (url === mediaUrl) throw new TypeError('old CDN connection closed');
        throw new Error(`unexpected request: ${url}`);
    } });
    await h.worker.context.fetch(masterUrl);
    const refreshed = await h.worker.context.fetch(masterUrl);
    assert.match(await refreshed.text(), /restarted\/1080\.m3u8/);
    assert.equal(requests, 2);
    assert.equal(h.evaluate(`StreamInfos.example.ResolutionList[0].Url`), restartedUrl);
    assert.equal(h.evaluate(`StreamInfosByUrl[${JSON.stringify(restartedUrl)}] === StreamInfos.example`), true);
    assert.equal(h.evaluate(`StreamInfosByUrl[${JSON.stringify(mediaUrl)}]`), undefined);
});

test('relative playlist and key/map segment URLs resolve against final response URL', async () => {
    const finalMasterUrl = 'https://video-weaver.example.net/live/master.m3u8';
    const relativeMediaUrl = 'https://video-weaver.example.net/live/1080/index.m3u8';
    const relativeMedia = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:2',
        '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?key=one"',
        '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:2.000,live', '../segments/live-1.ts', ''
    ].join('\n');
    const h = setup({ workerFetch: async input => {
        const url = urlOf(input);
        if (url.includes('/channel/hls/')) {
            const response = new Response(master('1080/index.m3u8'));
            Object.defineProperty(response, 'url', { value: finalMasterUrl });
            return response;
        }
        if (url === relativeMediaUrl) return new Response(relativeMedia);
        throw new Error(`unexpected request: ${url}`);
    } });
    const masterResponse = await h.worker.context.fetch(masterUrl);
    assert.ok((await masterResponse.text()).includes(relativeMediaUrl));
    const mediaResponse = await h.worker.context.fetch(relativeMediaUrl);
    const body = await mediaResponse.text();
    assert.ok(body.includes('URI="https://video-weaver.example.net/live/keys/key.bin?key=one"'));
    assert.ok(body.includes('URI="https://video-weaver.example.net/live/1080/init.mp4"'));
    assert.ok(body.includes('https://video-weaver.example.net/live/segments/live-1.ts'));
    assert.equal(h.evaluate(`StreamInfosByUrl[${JSON.stringify(relativeMediaUrl)}].ChannelName`), 'example');
});

test('GraphQL batches rewrite only playback operations and preserve caller objects', async () => {
    const h = setup();
    const operations = [
        { operationName: 'PlaybackAccessToken', variables: { playerType: 'site', login: 'example' } },
        { operationName: 'Unrelated', variables: { playerType: 'site', login: 'example' } },
        { operationName: 'PlaybackAccessToken', variables: { playerType: 'picture-by-picture', login: 'example' } },
        null
    ];
    const init = { method: 'POST', headers: new Headers({ 'x-device-id': 'batch-device', 'client-id': 'custom-client' }), body: JSON.stringify(operations) };
    const original = init.body;
    await h.context.fetch('https://gql.twitch.tv/gql', init);
    const forwarded = JSON.parse(h.mainCalls[0].init.body);
    assert.equal(forwarded[0].variables.playerType, 'popout');
    assert.deepEqual(forwarded[1], operations[1]);
    assert.equal(forwarded[2].variables.playerType, 'popout');
    assert.equal(forwarded[3], null);
    assert.equal(init.body, original);
    assert.equal(init.headers.get('x-device-id'), 'batch-device');
    await flush();
    assert.equal(h.worker.context.ClientID, 'custom-client');
    assert.equal(h.worker.context.GQLDeviceID, 'batch-device');
});

test('terminating a worker aborts an outstanding bridge fetch and suppresses its late response', async () => {
    let finish;
    const h = setup({ windowFetch: () => new Promise(resolve => { finish = resolve; }) });
    h.evaluate('gqlRequest({})');
    await flush();
    assert.equal(h.mainCalls[0].init.signal.aborted, false);
    h.worker.terminate();
    assert.equal(h.mainCalls[0].init.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    const before = h.worker.received.length;
    finish(new Response('{}'));
    await flush();
    await flush();
    assert.equal(h.worker.received.length, before);
    assert.deepEqual(h.errors, []);
});

test('concurrent ad playlists share one token and backup master request per player type', async () => {
    let finishToken;
    let backupMasters = 0;
    const h = setup({
        windowFetch: () => new Promise(resolve => { finishToken = resolve; }),
        workerFetch: async input => {
            const url = new URL(urlOf(input));
            if (url.pathname.includes('/channel/hls/')) {
                const isBackup = url.searchParams.get('sig') === 'concurrent-backup';
                if (isBackup) backupMasters++;
                return new Response(master(isBackup ? backupUrl : mediaUrl));
            }
            if (url.href === mediaUrl) return new Response(adMedia);
            if (url.href === backupUrl) return new Response(cleanMedia);
            throw new Error(`unexpected request: ${url}`);
        }
    });
    await h.worker.context.fetch(masterUrl);
    h.advance(2000);
    const first = h.worker.context.fetch(mediaUrl);
    const second = h.worker.context.fetch(mediaUrl);
    await flush();
    assert.equal(h.mainCalls.length, 1, 'concurrent media requests must share the in-flight token request');
    finishToken(Response.json({ data: { streamPlaybackAccessToken: { signature: 'concurrent-backup', value: 'token' } } }));
    const responses = await Promise.all([first, second]);
    assert.deepEqual(await Promise.all(responses.map(response => response.text())), [cleanMedia, cleanMedia]);
    assert.equal(backupMasters, 1, 'concurrent media requests must share the in-flight backup master');
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.deepEqual(h.errors, []);
});

test('a recoverable worker error preserves later RPC and update broadcasts', async () => {
    const h = setup({ windowFetch: async () => new Response('still connected') });
    await flush();
    assert.equal(h.worker.errorListeners.length > 0, true);
    for (const callback of h.worker.errorListeners) callback({ message: 'recoverable application callback error' });
    h.context.simulateAds(2);
    await flush();
    assert.equal(h.worker.context.SimulatedAdsDepth, 2, 'a surviving worker must still receive updates');
    const response = await h.evaluate('gqlRequest({operationName:"AfterRecoverableError"})');
    assert.equal(await response.text(), 'still connected');
    assert.equal(h.mainCalls.length, 1);
    assert.equal(h.worker.terminated, false);
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.deepEqual(h.errors, []);
});

test('GET Request inherits headers and signal when init explicitly supplies undefined', async () => {
    const h = setup({ workerFetch: async () => new Response(master()) });
    const controller = new AbortController();
    const request = new Request(masterUrl, {
        headers: { 'x-inherited': 'retained' }, signal: controller.signal,
        credentials: 'include', cache: 'no-store', mode: 'cors'
    });
    await h.worker.context.fetch(request, { headers: undefined, signal: undefined });
    const forwarded = h.nativeCalls[0];
    assert.equal(new Headers(forwarded.init.headers).get('x-inherited'), 'retained');
    assert.equal(forwarded.init.credentials, 'include');
    assert.equal(forwarded.init.cache, 'no-store');
    assert.equal(forwarded.init.mode, 'cors');
    assert.equal(forwarded.init.signal.aborted, false);
    controller.abort();
    assert.equal(forwarded.init.signal.aborted, true, 'inherited signal must remain connected to caller cancellation');
    assert.equal(new URL(urlOf(forwarded.input)).searchParams.has('parent_domains'), false);
});

test('a synchronous bridge postMessage failure rejects and clears its pending entry and timer', async () => {
    const h = setup();
    await flush();
    h.worker.context.postMessage = () => { throw new Error('structured message delivery failed'); };
    await assert.rejects(h.evaluate('gqlRequest({})'), /structured message delivery failed/);
    assert.equal(h.evaluate('pendingFetchRequests.size'), 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.mainCalls.length, 0);
});

test('a stalled cached-playlist probe aborts after its bound and rebuilds master state', async () => {
    const restartedUrl = 'https://video-weaver.example.net/restarted/1080.m3u8';
    let masterRequests = 0;
    let probeSignal;
    const h = setup({ workerFetch: async (input, init) => {
        const url = urlOf(input);
        if (url.includes('/channel/hls/')) return new Response(master(++masterRequests === 1 ? mediaUrl : restartedUrl));
        if (url === mediaUrl) {
            probeSignal = init.signal;
            return new Promise((resolve, reject) => {
                probeSignal.addEventListener('abort', () => reject(new DOMException('Probe aborted', 'AbortError')), { once: true });
            });
        }
        throw new Error(`unexpected request: ${url}`);
    } });
    await h.worker.context.fetch(masterUrl);
    const refresh = h.worker.context.fetch(masterUrl);
    await flush();
    assert.equal(probeSignal.aborted, false);
    h.advance(3000);
    assert.equal(probeSignal.aborted, true);
    assert.match(await (await refresh).text(), /restarted\/1080\.m3u8/);
    assert.equal(h.evaluate(`StreamInfosByUrl[${JSON.stringify(mediaUrl)}]`), undefined);
    assert.equal(h.timers.size, 0);
});

test('substituted backup playlists resolve relative variant/key/map/segment URIs against their own final URLs', async () => {
    const backupMasterFinalUrl = 'https://backup.example.net/hls/master.m3u8';
    const backupVariantUrl = 'https://backup.example.net/hls/rendition/1080.m3u8';
    const backupMediaFinalUrl = 'https://alternate-backup.example.net/hls/actual/index.m3u8';
    const relativeBackup = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:2',
        '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin?key=backup"',
        '#EXT-X-MAP:URI="./init.mp4"', '#EXTINF:2.000,live', '../segments/live.ts',
        '#EXT-X-TWITCH-PREFETCH:../segments/next.ts', ''
    ].join('\n');
    const h = setup({
        windowFetch: async () => Response.json({ data: { streamPlaybackAccessToken: { signature: 'relative-backup', value: 'token' } } }),
        workerFetch: async input => {
            const url = new URL(urlOf(input));
            if (url.pathname.includes('/channel/hls/')) {
                if (url.searchParams.get('sig') === 'relative-backup') {
                    const response = new Response(master('rendition/1080.m3u8'));
                    Object.defineProperty(response, 'url', { value: backupMasterFinalUrl });
                    return response;
                }
                return new Response(master());
            }
            if (url.href === mediaUrl) return new Response(adMedia);
            if (url.href === backupVariantUrl) {
                const response = new Response(relativeBackup);
                Object.defineProperty(response, 'url', { value: backupMediaFinalUrl });
                return response;
            }
            throw new Error(`unexpected backup request: ${url}`);
        }
    });
    await h.worker.context.fetch(masterUrl);
    h.advance(2000);
    const body = await (await h.worker.context.fetch(mediaUrl)).text();
    assert.ok(!body.includes('stitched-ad'), 'clean relative backup must replace original ad playlist');
    assert.ok(body.includes('URI="https://alternate-backup.example.net/hls/key.bin?key=backup"'));
    assert.ok(body.includes('URI="https://alternate-backup.example.net/hls/actual/init.mp4"'));
    assert.ok(body.includes('\nhttps://alternate-backup.example.net/hls/segments/live.ts\n'));
    assert.ok(body.includes('#EXT-X-TWITCH-PREFETCH:https://alternate-backup.example.net/hls/segments/next.ts'));
    assert.equal(h.mainCalls.length, 1);
    assert.equal(h.nativeCalls.filter(call => urlOf(call.input) === backupVariantUrl).length, 1);
    assert.deepEqual(h.errors, []);
});
