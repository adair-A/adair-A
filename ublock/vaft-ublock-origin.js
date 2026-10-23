twitch-videoad.js text/javascript
/*
Modified from pixeltris/TwitchAdSolutions, commit f8f86706daf90daa534b26bce5b2f01238667d5f.
Reliability and request-handling fixes; live playback has not been verified.
 *
MIT License
 *
Copyright (c) 2020-present TwitchAdSolutions Contributors
 *
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 *
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
 *
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(function() {
    if ( /(^|\.)twitch\.tv$/.test(document.location.hostname) === false ) { return; }
    'use strict';
    const ourTwitchAdSolutionsVersion = 24;// Used to prevent conflicts with outdated versions of the scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("skipping vaft as there's another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    console.log('vaft custom build 2026-10-22.2 loaded');
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',//Source
            'popout',//Source
            'autoplay',//360p
            //'picture-by-picture-CACHED'//360p (-CACHED is an internal suffix and is removed)
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 2;//autoplay
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = new Set();
    const twitchWorkerResources = new WeakMap();
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            } else {
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = /(^|\.)twitch\.tv$/.test(new URL(new URL(twitchBlobUrl, document.baseURI).origin).hostname);
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${stripAdSegments.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${getBackupEncodings.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${resolvePlaylistUrls.toString()}
                    const workerString = getWasmWorkerJs(${JSON.stringify(String(twitchBlobUrl))});
                    declareOptions(self);
                    ClientID = ${JSON.stringify(ClientID)};
                    GQLDeviceID = ${JSON.stringify(GQLDeviceID)};
                    AuthorizationHeader = ${JSON.stringify(AuthorizationHeader)};
                    ClientIntegrityHeader = ${JSON.stringify(ClientIntegrityHeader)};
                    ClientVersion = ${JSON.stringify(ClientVersion)};
                    ClientSession = ${JSON.stringify(ClientSession)};
                    self.addEventListener('message', function(e) {
                        if (!e.data || typeof e.data !== 'object') return;
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (!responseData || typeof responseData.id !== 'string') return;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeout } = pendingFetchRequests.get(responseData.id);
                                clearTimeout(timeout);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data
                                    try {
                                        const response = new Response([204, 205, 304].includes(responseData.status) ? null : responseData.body, {
                                            status: responseData.status,
                                            statusText: responseData.statusText,
                                            headers: responseData.headers
                                        });
                                        resolve(response);
                                    } catch (error) {
                                        reject(error);
                                    }
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    self.postMessage({ key: 'TwitchAdSolutionsReady' });
                    eval(workerString);
                `;
                const resourceUrl = URL.createObjectURL(new Blob([newBlobStr]));
                try {
                    super(resourceUrl, options);
                } catch (error) {
                    URL.revokeObjectURL(resourceUrl);
                    throw error;
                }
                twitchWorkerResources.set(this, { url: resourceUrl, controllers: new Map() });
                twitchWorkers.add(this);
                this.addEventListener('message', (e) => {
                    if (!e.data || typeof e.data !== 'object') return;
                    if (e.data.key == 'TwitchAdSolutionsReady') {
                        revokeTwitchWorkerUrl(this);
                    } else if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data?.key == 'CancelFetchRequest') {
                        twitchWorkerResources.get(this)?.controllers.get(event.data.value)?.abort();
                    } else if (event.data?.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        if (!fetchRequest || typeof fetchRequest.id !== 'string') return;
                        const resources = twitchWorkerResources.get(this);
                        if (!resources) return;
                        const controller = new AbortController();
                        resources.controllers.set(fetchRequest.id, controller);
                        try {
                            const responseData = await handleWorkerFetchRequest(fetchRequest, controller.signal);
                            if (twitchWorkers.has(this)) this.postMessage({ key: 'FetchResponse', value: responseData });
                        } finally {
                            resources.controllers.delete(fetchRequest.id);
                        }
                    }
                });
                this.addEventListener('error', () => revokeTwitchWorkerUrl(this));
            }
            terminate() {
                releaseTwitchWorker(this);
                return super.terminate();
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function revokeTwitchWorkerUrl(worker) {
        const resources = twitchWorkerResources.get(worker);
        if (resources?.url) {
            URL.revokeObjectURL(resources.url);
            resources.url = null;
        }
    }
    function releaseTwitchWorker(worker) {
        const resources = twitchWorkerResources.get(worker);
        if (!resources) return;
        twitchWorkers.delete(worker);
        revokeTwitchWorkerUrl(worker);
        resources.controllers.forEach(controller => controller.abort());
        resources.controllers.clear();
        twitchWorkerResources.delete(worker);
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        console.log('hookWorkerFetch (vaft)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (url instanceof URL) {
                url = url.href;
            } else if (url instanceof Request) {
                if ((options?.method || url.method).toUpperCase() !== 'GET') return realFetch.apply(this, arguments);
                const request = new Request(url, options);
                options = {
                    ...options,
                    method: request.method, headers: request.headers, signal: request.signal,
                    cache: request.cache, credentials: request.credentials, integrity: request.integrity,
                    mode: request.mode, redirect: request.redirect, referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy, keepalive: request.keepalive
                };
                url = request.url;
            }
            if (typeof url === 'string') {
                url = url.trimEnd();
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const send = function() {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                                resolve(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (/\.m3u8(?:[?#]|$)/i.test(url) && !url.includes('/channel/hls/')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                const text = resolvePlaylistUrls(await response.text(), response.url || url);
                                resolve(new Response(await processM3U8(url, text, realFetch), { status: response.status, statusText: response.statusText, headers: response.headers }));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                return processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = resolvePlaylistUrls(await response.text(), response.url || url);
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                                    let isAlive = false;
                                    const probeController = new AbortController();
                                    const probeTimeout = setTimeout(() => probeController.abort(), 3000);
                                    try {
                                        const probe = await realFetch(streamInfo.ResolutionList[0]?.Url || url, { signal: probeController.signal });
                                        isAlive = probe.status === 200;
                                        if (probe.body) await probe.body.cancel();
                                    } catch {} finally { clearTimeout(probeTimeout); }
                                    if (!isAlive) {
                                        for (const cachedUrl of Object.keys(streamInfo.Urls)) {
                                            if (StreamInfosByUrl[cachedUrl] === streamInfo) delete StreamInfosByUrl[cachedUrl];
                                        }
                                        streamInfo = null;
                                    }
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: Object.create(null),// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: Object.create(null),
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings['RESOLUTION'] && /^(hev|hvc)/.test(resSettings[codecsKey] || '')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = nonHevcResolutionList.sort((a, b) => {
                                                            // TODO: Take into account 'Frame-Rate' when sorting (i.e. 1080p60 vs 1080p30)
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        console.log('ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// The stream doesn't load unless each url line is unique
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime), { status: response.status, statusText: response.statusText, headers: response.headers }));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                return processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function resolvePlaylistUrls(text, baseUrl) {
        if (!text.trimStart().startsWith('#EXTM3U')) return text;
        const resolve = uri => {
            try { return new URL(uri, baseUrl).href; } catch { return uri; }
        };
        return text.replaceAll('\r', '').split('\n').map(line => {
            if (line && !line.startsWith('#')) return resolve(line.trim());
            if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) return '#EXT-X-TWITCH-PREFETCH:' + resolve(line.slice(line.indexOf(':') + 1));
            return line.replace(/([,:])URI="([^"]*)"/g, (match, prefix, uri) => prefix + 'URI="' + resolve(uri) + '"');
        }).join('\n');
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Remove tracking urls which appear in the overlay UI
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            lines[i] = line;
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl;
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return matchedResolutionUrl || closestResolutionUrl;
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        const haveAdTags = textStr.includes(AdSignifier) || SimulatedAdsDepth > 0;
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // Only request one .ts file per .m3u8 request to avoid making too many requests
                            //console.log('Fetch ad .ts file');
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then(response => response.blob()).catch(() => {});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
                const playerType = BackupPlayerTypes[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            encodingsM3u8 = await getBackupEncodings(streamInfo, playerType, realPlayerType, realFetch);
                        } catch (err) {}
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = resolvePlaylistUrls(await streamM3u8Response.text(), streamM3u8Response.url || streamM3u8Url);
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    if (streamInfo.BackupEncodingsM3U8Cache[playerType] === encodingsM3u8) streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            // TODO: Improve hevc stripping. It should always strip when there is a codec mismatch (both ways)
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('Finished blocking ads');
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            streamInfo.RequestedAds.clear();
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments
        });
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.replace(/^#EXT[^:]*:/, '').split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    async function getBackupEncodings(streamInfo, playerType, realPlayerType, realFetch) {
        if (streamInfo.BackupEncodingsM3U8Cache[playerType]) return streamInfo.BackupEncodingsM3U8Cache[playerType];
        const pending = streamInfo.BackupEncodingsM3U8Promises ||= Object.create(null);
        if (pending[playerType]) return pending[playerType];
        const task = (async () => {
            const response = await getAccessToken(streamInfo.ChannelName, realPlayerType);
            if (response.status !== 200) {
                if (response.body) await response.body.cancel();
                return null;
            }
            const token = (await response.json()).data?.streamPlaybackAccessToken;
            if (!token?.signature || !token?.value) return null;
            const url = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
            url.searchParams.set('sig', token.signature);
            url.searchParams.set('token', token.value);
            const master = await realFetch(url.href);
            if (master.status !== 200) {
                if (master.body) await master.body.cancel();
                return null;
            }
            return streamInfo.BackupEncodingsM3U8Cache[playerType] = resolvePlaylistUrls(await master.text(), master.url || url.href);
        })();
        pending[playerType] = task;
        try { return await task; } finally { if (pending[playerType] === task) delete pending[playerType]; }
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            ...(AuthorizationHeader && {'Authorization': AuthorizationHeader}),
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeout = setTimeout(() => {
                pendingFetchRequests.delete(requestId);
                try { postMessage({ key: 'CancelFetchRequest', value: requestId }); } catch {}
                reject(new Error('Twitch GraphQL request timed out'));
            }, 15000);
            pendingFetchRequests.set(requestId, { resolve, reject, timeout });
            try {
                postMessage({ key: 'FetchRequest', value: fetchRequest });
            } catch (error) {
                clearTimeout(timeout);
                pendingFetchRequests.delete(requestId);
                reject(error);
            }
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };
    function monitorPlayerBuffering() {
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                      const fileName = new URL(m3u8Url).pathname.split('/').pop();
                      if (fileName?.endsWith('.m3u8')) {
                          const channelName = fileName.slice(0, -5);
                          if (playerBufferState.channelName != channelName) {
                              playerBufferState.channelName = channelName;
                              playerBufferState.hasStreamStarted = false;
                              playerBufferState.numSame = 0;
                              //console.log('Channel changed to ' + channelName);
                          }
                      }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        //console.log('position:' + position + ' bufferDuration:' + bufferDuration + ' bufferPosition:' + bufferedPosition + ' state: ' + player.core?.state?.state + ' started: ' + playerBufferState.hasStreamStarted);
                        // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone)  &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '');// + (data.numStrippedAdSegments > 0 ? ` (${data.numStrippedAdSegments})` : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return  {
            player: player,
            state: playerState
        };
    }
    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            console.log('Reloading Twitch player');
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest, signal) {
        try {
            const response = await window.realFetch(fetchRequest.url, { ...fetchRequest.options, signal });
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(input, init, ...args) {
            let url;
            try {
                url = new URL(input instanceof Request ? input.url : input, document.baseURI);
            } catch {
                return realFetch.call(this, input, init, ...args);
            }
            if (url.hostname !== 'gql.twitch.tv' || url.pathname !== '/gql') {
                return realFetch.call(this, input, init, ...args);
            }
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            const clientId = headers.get('Client-ID');
            if (clientId && clientId !== ClientID) {
                postTwitchWorkerMessage('UpdateClientId', ClientID = clientId);
            }
            const deviceId = headers.get('X-Device-Id') || headers.get('Device-ID');
            if (deviceId && deviceId !== GQLDeviceID) {
                postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID = deviceId);
            }
            for (const [header, message, current] of [
                ['Client-Version', 'UpdateClientVersion', ClientVersion],
                ['Client-Session-Id', 'UpdateClientSession', ClientSession],
                ['Client-Integrity', 'UpdateClientIntegrityHeader', ClientIntegrityHeader],
                ['Authorization', 'UpdateAuthorizationHeader', AuthorizationHeader]
            ]) {
                const value = headers.get(header);
                if (value !== null && value !== current) {
                    if (header === 'Client-Version') ClientVersion = value;
                    else if (header === 'Client-Session-Id') ClientSession = value;
                    else if (header === 'Client-Integrity') ClientIntegrityHeader = value;
                    else AuthorizationHeader = value;
                    postTwitchWorkerMessage(message, value);
                }
            }
            if (typeof init?.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                if (ForceAccessTokenPlayerType) {
                    try {
                        const body = JSON.parse(init.body);
                        let changed = false;
                        for (const operation of Array.isArray(body) ? body : [body]) {
                            if (operation?.operationName === 'PlaybackAccessToken' &&
                                operation.variables?.playerType &&
                                operation.variables.playerType !== ForceAccessTokenPlayerType) {
                                operation.variables.playerType = ForceAccessTokenPlayerType;
                                changed = true;
                            }
                        }
                        if (changed) init = { ...init, body: JSON.stringify(body) };
                    } catch {
                        // Preserve malformed bodies for native fetch/server handling.
                    }
                }
            }
            return realFetch.call(this, input, init, ...args);
        };
    }
    function onContentLoaded() {
        // This stops Twitch from pausing the player when in another tab and an ad shows.
        // Taken from https://github.com/saucettv/VideoAdBlockForTwitch/blob/cefce9d2b565769c77e3666ac8234c3acfe20d83/chrome/content.js#L30
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        }catch{}
        let hidden = document.__lookupGetter__('hidden');
        let webkitHidden = document.__lookupGetter__('webkitHidden');
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        }catch{}
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const videos = document.getElementsByTagName('video');
            if (videos.length > 0) {
                if (hidden.apply(document) === true || (webkitHidden && webkitHidden.apply(document) === true)) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        //console.log('Tab focused. Stream should be active');
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        }catch{}
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
