// Run: node --test vaft-regression-tests.cjs (Node.js 18+).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.VAFT_SCRIPT || path.join(__dirname, 'vaft-ublock-origin.js'), 'utf8').split('\n').slice(1).join('\n');
function setup() {
    const calls = [];
    const context = vm.createContext({
        console: { log() {}, error() {} }, URL, Request, Response, Headers,
        setTimeout, clearTimeout, Map, Set,
        document: { baseURI: 'https://www.twitch.tv/test', location: { hostname: 'www.twitch.tv' } },
        fetch: async (...args) => { calls.push(args); return new Response('ok'); }
    });
    context.window = context;
    context.self = context;
    const entry = source.indexOf('    declareOptions(window);');
    assert.ok(entry > 0);
    vm.runInContext(source.slice(0, entry) + `
        Object.assign(window, { declareOptions, getServerTimeFromM3u8,
            stripAdSegments, getStreamUrlForResolution, hookWorkerFetch,
            hookFetch, hookWindowWorker, gqlRequest, hideTwitchDisplayAds });
    })();`, context);
    context.declareOptions(context);
    return { context, calls };
}
test('resource body parses', () => { new vm.Script(source); });
test('display-ad styles target known containers and install only once', () => {
    const { context: c } = setup();
    const nodes = [];
    c.document.getElementById = id => nodes.find(node => node.id === id);
    c.document.createElement = tag => ({ tagName: tag });
    c.document.head = { appendChild: node => nodes.push(node) };
    c.hideTwitchDisplayAds();
    c.hideTwitchDisplayAds();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].tagName, 'style');
    assert.equal(nodes[0].textContent, '.stream-display-ad__wrapper, [data-test-selector="sda-wrapper"] { display: none !important; }');
});
test('uBlock resource delimiters preserve the complete executable script', () => {
    const loaded = source.split(/\r?\n/).filter(line => !line.startsWith('// ')).join('\n').split(/\n\s*\n/)[0];
    new vm.Script(loaded);
    assert.ok(loaded.includes('    hookWindowWorker();'));
    assert.ok(loaded.includes('    hookFetch();'));
    assert.ok(loaded.trimEnd().endsWith('})();'));
});
test('a newer active version is never downgraded', () => {
    const window = { twitchAdSolutionsVersion: 99 };
    vm.runInNewContext(source, { window, document: { location: { hostname: 'www.twitch.tv' } }, console: { log() {} } });
    assert.equal(window.twitchAdSolutionsVersion, 99);
});
test('missing server time is accepted by both API formats', () => {
    const { context: c } = setup();
    for (const v2 of [false, true]) {
        c.V2API = v2;
        assert.equal(c.getServerTimeFromM3u8('#EXTM3U'), null);
        assert.equal(c.getServerTimeFromM3u8(v2 ? '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="123.5"' : '#EXT-X-TWITCH-INFO:SERVER-TIME="123.5"'), '123.5');
    }
});
test('tracking URL changes survive playlist serialization', () => {
    const { context: c } = setup();
    const info = { NumStrippedAdSegments: 0 };
    const result = c.stripAdSegments('#EXTM3U\n#EXT-X-DATERANGE:X-TV-TWITCH-AD-URL="https://tracking.example/a",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://tracking.example/b"', false, info);
    assert.ok(!result.includes('tracking.example'));
    assert.equal((result.match(/https:\/\/twitch.tv/g) || []).length, 2);
});
test('exact resolution wins even when frame rate differs', () => {
    const { context: c } = setup();
    const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=30\nfirst.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1080x1920,FRAME-RATE=60\nsecond.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1080x1920,FRAME-RATE=60\nthird.m3u8';
    assert.equal(c.getStreamUrlForResolution(playlist, { Resolution: '1080x1920', FrameRate: 30 }), 'second.m3u8');
});
test('playlist processing exceptions reject instead of hanging', async () => {
    const { context: c } = setup();
    c.StreamInfosByUrl['https://cdn.example/live.m3u8'] = {};
    c.fetch = async () => new Response('#EXTM3U');
    // A deliberately malformed stream state triggers an asynchronous parser error.
    c.StreamInfosByUrl['https://cdn.example/live.m3u8'].IsShowingAd = true;
    c.StreamInfosByUrl['https://cdn.example/live.m3u8'].RequestedAds = new Set();
    c.postMessage = () => { throw new Error('processing failed'); };
    c.hookWorkerFetch();
    await assert.rejects(Promise.race([
        c.fetch('https://cdn.example/live.m3u8'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung request')), 100))
    ]), /processing failed/);
});
test('query-string playlists are processed and response headers retained', async () => {
    const { context: c } = setup();
    const original = new Response('#EXTM3U', { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'x-test': 'retained' } });
    c.fetch = async () => original;
    c.hookWorkerFetch();
    const response = await c.fetch('https://cdn.example/live.m3u8?token=abc');
    assert.notEqual(response, original);
    assert.equal(response.headers.get('x-test'), 'retained');
    assert.equal(await response.text(), '#EXTM3U');
});
test('GraphQL hook accepts absent options and every HeadersInit format', async () => {
    const { context: c, calls } = setup();
    c.hookFetch();
    await c.fetch('https://gql.twitch.tv/gql');
    for (const headers of [new Headers({ 'X-Device-Id': 'one' }), [['x-device-id', 'two']], { 'x-device-id': 'three' }]) {
        await c.fetch('https://gql.twitch.tv/gql', { headers });
    }
    assert.equal(c.GQLDeviceID, 'three');
    await c.fetch(new Request('https://gql.twitch.tv/gql', { headers: { 'X-Device-Id': 'four' } }));
    assert.equal(c.GQLDeviceID, 'four');
    assert.equal(calls.length, 5);
});
test('GraphQL body edits are scoped, tolerate bad JSON, and preserve caller input', async () => {
    const { context: c, calls } = setup();
    c.hookFetch();
    const init = { method: 'POST', headers: {}, body: JSON.stringify([
        { operationName: 'PlaybackAccessToken', variables: { playerType: 'site' } },
        { operationName: 'Other', variables: { playerType: 'site' } }
    ]) };
    await c.fetch('https://gql.twitch.tv/gql', init);
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body[0].variables.playerType, 'popout');
    assert.equal(body[1].variables.playerType, 'site');
    assert.equal(JSON.parse(init.body)[0].variables.playerType, 'site');
    await c.fetch('https://gql.twitch.tv/gql', { body: 'PlaybackAccessToken invalid JSON' });
    await c.fetch('https://example.com/gql', init);
    assert.equal(calls[2][1], init);
});
test('generated worker source handles quoted and multiline header values', () => {
    const { context: c } = setup();
    let generated;
    c.Worker = class Worker { addEventListener() {} };
    c.Blob = class Blob { constructor(parts) { generated = parts.join(''); } };
    c.URL = class extends URL { static createObjectURL() { return 'blob:test'; } };
    c.AuthorizationHeader = "quote'\\\nline";
    c.hookWindowWorker();
    new c.Worker('blob:https://www.twitch.tv/worker');
    assert.ok(generated);
    new vm.Script(generated);
});
test('GraphQL bridge times out and removes abandoned pending requests', async () => {
    const { context: c } = setup();
    c.pendingFetchRequests = new Map();
    c.postMessage = () => {};
    let expire;
    c.setTimeout = (callback, delay) => { assert.equal(delay, 15000); expire = callback; return 1; };
    const request = c.gqlRequest({});
    assert.equal(c.pendingFetchRequests.size, 1);
    expire();
    await assert.rejects(request, /timed out/);
    assert.equal(c.pendingFetchRequests.size, 0);
});
test('failed bridge message delivery releases its timer and pending request', async () => {
    const { context: c } = setup();
    c.pendingFetchRequests = new Map();
    c.postMessage = () => { throw new Error('message delivery failed'); };
    let cleared = false;
    c.setTimeout = () => 123;
    c.clearTimeout = id => { assert.equal(id, 123); cleared = true; };
    await assert.rejects(c.gqlRequest({}), /message delivery failed/);
    assert.equal(c.pendingFetchRequests.size, 0);
    assert.equal(cleared, true);
});
