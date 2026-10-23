# vaft for Firefox and uBlock Origin
Custom build: `2026-10-22.3`. Based on pixeltris/TwitchAdSolutions commit `f8f86706daf90daa534b26bce5b2f01238667d5f`. The script includes the upstream MIT license.

Fresh pinned resource: https://raw.githubusercontent.com/adair-A/adair-A/c1660226b970fa40fec69df2a2aee95bf3023da2/ublock/vaft-ublock-origin.js

## Install
Use full uBlock Origin in Firefox. In **My filters**, keep:
```text
twitch.tv##+js(twitch-videoad)
```
In advanced settings, set `userResourcesLocation` to:
```text
https://raw.githubusercontent.com/adair-A/adair-A/ublock-resources/ublock/vaft-ublock-origin.js
```
Replace the previous vaft URL rather than keeping two copies of the same resource. Restart Firefox or disable/re-enable uBlock to reload resources. A new commit-pinned URL is supplied with each published release to avoid reusing an old cached resource. The branch URL receives future updates.

In the Twitch browser console, `vaft custom build 2026-10-22.3 loaded` confirms the page script loaded; `hookWorkerFetch (vaft)` confirms interception was installed in a player worker. Do not paste authorization headers or tokens into bug reports.

## Quality selection update
The script now checks source-capable embed/popout backups immediately after reloads, instead of deliberately jumping to the 360p autoplay backup. It searches past a low-resolution clean candidate for a closer match to the viewer's selected resolution and frame rate, retaining the best clean candidate found. A matching clean candidate ends the search early. The 360p backup remains a last resort when no better clean stream is available. Checking additional candidates can make the transition take longer; the script cannot create high-resolution ad-free streams that Twitch does not provide.

## This research pass
Three subagents handled upstream research (GPT-6.1 Sol), runtime review (GPT-6 Astra), and integration tests (GPT-6.1 Sol). Their work was reviewed and combined by the parent agent.

Concrete fixes:
- Intercept GET playlist/segment requests made with strings, URL objects, or Request objects while preserving inherited headers, credentials, cache options, and abort signals.
- Revoke generated worker blob URLs when ready and on termination; unregister terminated workers and abort their pending page requests. Recoverable worker errors preserve active messaging.
- Abort page-side GraphQL fetches when worker RPC requests time out or the worker terminates. Clear timers and pending entries when message delivery fails.
- Preserve unrelated GraphQL batch operations, including batches containing picture-by-picture token requests. Rewrite only explicit PlaybackAccessToken player-type fields and propagate the current Client-ID to workers.
- Recover from failed cached-playlist probes using the already fetched replacement master. Limit the optional probe to three seconds, cancel its unused body, and remove stale video-variant mappings.
- Resolve relative master/media URI lines, KEY/MAP URI attributes, and Twitch prefetch URIs against the final playlist response URL, including replacement backup playlists.
- Share in-flight backup token/master acquisition per stream and player type. Media playlist requests remain fresh.
- Add a build log and broader integration coverage.

Earlier fixes for timestamps, discarded tracking edits, resolution selection, safe worker serialization, promise rejection, and uBlock resource formatting remain.

## Validation
Run with Node.js 18+ from this directory:
```sh
node --test vaft-regression-tests.cjs vaft-integration-tests.cjs
```
All 35 tests pass (13 regression tests and 22 integration tests). The integration suite loads the complete uBlock resource, executes generated worker code and the original-worker bootstrap fixture, and passes messages between simulated page and worker contexts. It covers token success/error/timeout, cancellation, late responses, request overloads, HLS backup and stripping flows, relative URLs, cache recovery, batched operations, and concurrent acquisition. The resource was also checked using upstream uBlock's actual `resourcesFromString` method. No whitespace-only lines may appear inside the published resource body.

These checks use Node VM contexts and browser API mocks. They do not establish current live Twitch ad-blocking effectiveness or validate actual Firefox extension execution.

## Scope and remaining limits
The established backup player order, Twitch persisted query, buffering preferences, and compatibility version 24 remain. No speculative token/player experiments were imported. Playback may stall intentionally when no clean stream exists and the fallback strips ad segments.

HLS byte-range media, intervening segment tags, alternate audio-only variants, mobile, and VOD support have not been expanded. Byte-range support requires matching URL plus Range headers; URL-only replacement risks blocking clean content from the same resource. Concurrent ad/clean playlist state transitions remain a separate state-machine concern. Request bodies stored inside Request objects are forwarded unchanged; explicit string `init.body` token operations receive the existing rewrite.

## Research sources
- [Upstream code](https://github.com/pixeltris/TwitchAdSolutions/blob/f8f86706daf90daa534b26bce5b2f01238667d5f/vaft/vaft-ublock-origin.js) and [diagnostics](https://github.com/pixeltris/TwitchAdSolutions/blob/master/issues.md).
- [Player nesting bug #499](https://github.com/pixeltris/TwitchAdSolutions/issues/499): its upstream fix is already present; avoid applying it twice.
- [Buffering/desync reports #492](https://github.com/pixeltris/TwitchAdSolutions/issues/492): reports do not establish a universally effective timeout or reload change.
- [Experimental player PR #472](https://github.com/pixeltris/TwitchAdSolutions/pull/472): closed and unmerged; its player/token strategy was not adopted.
- [uBlock userResourcesLocation](https://github.com/gorhill/uBlock/wiki/Advanced-settings#userresourceslocation) and [resource parser](https://github.com/gorhill/uBlock/blob/master/src/js/redirect-engine.js).
- [HLS relative URI rules, RFC 8216 §4.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.1) and [byte ranges, §4.3.2.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.2).
