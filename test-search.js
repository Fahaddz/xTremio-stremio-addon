// test-search.js — end-to-end test for search matching in index.js
// Spins up a mock Xtream provider + the real addon, then drives the catalog
// routes over HTTP. Run: node test-search.js
'use strict';

const http = require('http');

const MOCK_PORT = 3999;
const APP_PORT = 3211;
const NODE_PORT = 3997; // second server standing in for the provider's stream "nodes"
process.env.PORT = String(APP_PORT);
process.env.HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Mock Xtream provider data
// ---------------------------------------------------------------------------
let idSeq = 1;
const mk = (kind) => (name) => {
    if (kind === 'movie') return { stream_id: idSeq++, name, stream_icon: '', category_id: '10', category_name: 'Movies', rating: '7', added: '1700000000' };
    if (kind === 'series') return { series_id: idSeq++, name, cover: '', category_id: '20', category_name: 'Series', rating: '8', last_modified: '1700000000' };
    return { stream_id: idSeq++, name, stream_icon: '', category_id: '1', category_name: 'Live' };
};
const mv = mk('movie'), sr = mk('series'), lv = mk('live');

const MOVIES = [
    'أخي',
    'فيلم الأخ الأكبر',
    'ياسمين والأخ',
    'الأخيرة',
    'فيلم الاخيره',
    'مصطفى',
    'مصطفي كامل',
    'قصة حب',
    'قصه من الزمن الجميل',
    'مُحَمَّد: خاتم الأنبياء',
    'الجزيرة ٢',
    'الجزيرة 2',
    'إخوة الدم',
    'أخوة التراب',
    'Spider-Man: No Way Home',
    'The Office (US)',
    'Amélie',
    'Pokémon: Detective Pikachu',
    'The Dark Knight',
    'قهوة وحب',
    'باب الحارة - الفيلم',
].map(mv);
for (let i = 0; i < 20000; i++) MOVIES.push(mv('Movie ' + i));
MOVIES.push({ stream_id: idSeq++, name: 'AR - فيلم عربي مخصص', stream_icon: '', category_id: '11', category_name: '|AR| أفلام عربية', rating: '7', added: '1700000000' });

const SERIES = [
    'أخي في الله',
    'مسلسل قصة حب',
    'الاخوة الأعداء',
    'مسلسل الحب والانتقام',
    'Spider-Man: The Animated Series',
].map(sr);
for (let i = 0; i < 500; i++) SERIES.push(sr('Series ' + i));
SERIES.push({ series_id: idSeq++, name: 'AR - مسلسل الأن عربي 1', cover: '', category_id: '21', category_name: '|AR| يعرض الأن عربي', rating: '8', last_modified: '1700000000' });
SERIES.push({ series_id: idSeq++, name: 'AR - مسلسل الأن تركي 1', cover: '', category_id: '22', category_name: '|AR| يعرض الأن تركي', rating: '8', last_modified: '1700000000' });

const LIVE = [
    'قناة الأخبار',
    'قناة الاخبار',
    'قناة الأخبار ٢ HD',
    'beIN Sports 1',
    'beIN Sports 2',
    'BEINSPORTS 3',
    'Otterbein College TV',
    'Music #1',
    '##### AL-MAJD GROUP #####',
    '### 24/7 DISNEY+ ###',
    '##### BEIN SPORTS FHD #####',
].map(lv);
for (let i = 0; i < 500; i++) LIVE.push(lv('Channel ' + i));

// ---------------------------------------------------------------------------
// Mock provider server
// ---------------------------------------------------------------------------
const STREAM_SIM = { mode: 'ok', seen: 0, badCount: 0, hits: 0 };

const mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const action = u.searchParams.get('action');
    const cat = u.searchParams.get('category_id');
    const filter = (arr) => (cat ? arr.filter(x => x.category_id === String(cat)) : arr);

    // --- streaming simulation: provider redirects to rotating "nodes" ---
    // mode ok:      every assignment is good
    // mode firstbad: the first N assignments are bad, then good
    // mode allbad:  every assignment is bad
    // Bad nodes point at a dead port so the probe fails fast (like a refused/timed-out node).
    const sm = /^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(.+)\.([A-Za-z0-9]+)$/.exec(u.pathname);
    if (sm) {
        STREAM_SIM.seen++;
        STREAM_SIM.hits++;
        if (STREAM_SIM.mode === 'direct') {
            // provider serves streams directly, no node redirect at all
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            return res.end(Buffer.alloc(4096, 7));
        }
        const file = sm[4] + '.' + sm[5];
        const bad = STREAM_SIM.mode === 'allbad' || (STREAM_SIM.mode === 'firstbad' && STREAM_SIM.seen <= STREAM_SIM.badCount);
        const location = bad
            ? `http://localhost:3998/edge/bad-${file}` // dead port = broken node
            : `http://127.0.0.1:${NODE_PORT}/edge/good-${file}`;
        res.writeHead(302, { Location: location });
        return res.end();
    }
    if (u.pathname === '/__mode') {
        STREAM_SIM.mode = u.searchParams.get('mode') || 'ok';
        STREAM_SIM.seen = 0;
        STREAM_SIM.badCount = parseInt(u.searchParams.get('bad') || '0', 10) || 0;
        return res.end(JSON.stringify(STREAM_SIM));
    }

    let data = [];
    if (!action) data = { user_info: { auth: 1, status: 'Active', username: 'u', exp_date: '9999999999' } };
    else if (action === 'get_vod_categories') data = [
        { category_id: '10', category_name: 'Movies' },
        { category_id: '11', category_name: '|AR| أفلام عربية' }
    ];
    else if (action === 'get_series_categories') data = [
        { category_id: '20', category_name: 'Series' },
        { category_id: '21', category_name: '|AR| يعرض الأن عربي' },
        { category_id: '22', category_name: '|AR| يعرض الأن تركي' }
    ];
    else if (action === 'get_live_categories') data = [{ category_id: '1', category_name: 'Live' }];
    else if (action === 'get_vod_streams') data = filter(MOVIES);
    else if (action === 'get_vod_info') data = { movie_data: { container_extension: 'mkv' }, info: { name: 'Mock Movie', movie_image: '' } };
    else if (action === 'get_series') data = filter(SERIES);
    else if (action === 'get_live_streams') data = filter(LIVE);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
});

// Stand-in for the provider's stream "nodes" — a distinct host from the
// mock's main host, mirroring the real IP:port node servers.
const nodes = http.createServer((req, res) => {
    const nm = /^\/edge\/good-(.+)$/.exec(new URL(req.url, 'http://n').pathname);
    if (nm) {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        return res.end(Buffer.alloc(4096, 7));
    }
    res.writeHead(404);
    res.end();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const CFG = Buffer.from(JSON.stringify({ serverUrl: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'p' })).toString('base64url');

async function catalog(kind, id, extra) {
    const seg = extra ? `/${encodeURIComponent(extra)}` : '';
    const url = `http://127.0.0.1:${APP_PORT}/${CFG}/catalog/${encodeURIComponent(kind)}/${id}${seg}.json`;
    const r = await fetch(url);
    return r.json();
}

async function search(kind, q) {
    const id = kind === 'movie' ? 'xtremio_search_movies' : kind === 'series' ? 'xtremio_search_series' : 'xtremio_search_live';
    const d = await catalog(kind, id, 'search=' + q);
    return (d.metas || []).map(m => m.name);
}

async function streamReq(type, id) {
    const url = `http://127.0.0.1:${APP_PORT}/${CFG}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetch(url);
    return r.json();
}

const failures = [];
let checks = 0;
function check(cond, label) {
    checks++;
    if (cond) console.log(`   ✅ ${label}`);
    else { failures.push(label); console.log(`   ❌ ${label}`); }
}

function oldSubstringMatches(corpus, q) {
    return corpus.filter(x => x.name.toLowerCase().includes(q.toLowerCase())).map(x => x.name);
}

async function waitUp() {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`); if (r.ok) return; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('addon did not start');
}

// ---------------------------------------------------------------------------
// Test run
// ---------------------------------------------------------------------------
async function main() {
    console.log('=== A. Reported bug: "اخي" vs "أخي" (+ variants) ===');
    let r = await search('movie', 'اخي');
    console.log(`   search='اخي' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('أخي'), `query 'اخي' finds 'أخي'`);
    check(!r.includes('The Dark Knight') && !r.includes('أخوة التراب'), `query 'اخي' does not pull in unrelated titles`);

    r = await search('movie', 'الاخير');
    console.log(`   search='الاخير' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('الأخيرة') && r.includes('فيلم الاخيره'), `'الاخير' finds 'الأخيرة' and 'فيلم الاخيره'`);

    r = await search('movie', 'مصطفي');
    console.log(`   search='مصطفي' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('مصطفى') && r.includes('مصطفي كامل'), `'مصطفي' finds 'مصطفى'`);

    r = await search('movie', 'قصة');
    console.log(`   search='قصة' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('قصه من الزمن الجميل') && r.includes('قصة حب'), `'قصة' also finds 'قصه ...' (ة/ه)`);

    r = await search('movie', 'أَخِي');
    console.log(`   search='أَخِي' (with diacritics) -> ${r.length} results`);
    check(r.includes('أخي'), `diacritics in the query are ignored`);

    r = await search('movie', 'محمد');
    console.log(`   search='محمد' -> ${r.length} results`);
    check(r.includes('مُحَمَّد: خاتم الأنبياء'), `diacritics in the title are ignored`);

    r = await search('movie', 'الجزيرة 2');
    console.log(`   search='الجزيرة 2' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('الجزيرة ٢') && r.includes('الجزيرة 2'), `Arabic-Indic digits (٢) match ASCII digits (2)`);

    r = await search('movie', 'اخوة');
    console.log(`   search='اخوة' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('إخوة الدم') && r.includes('أخوة التراب'), `'اخوة' finds 'إخوة' and 'أخوة'`);

    console.log('=== B. Latin: punctuation, hyphens, accents ===');
    r = await search('movie', 'spider man');
    console.log(`   search='spider man' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('Spider-Man: No Way Home'), `'spider man' finds 'Spider-Man: ...'`);

    r = await search('movie', 'office us');
    console.log(`   search='office us' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('The Office (US)'), `'office us' finds 'The Office (US)'`);

    r = await search('movie', 'amelie');
    check(r.includes('Amélie'), `'amelie' finds 'Amélie'`);

    r = await search('movie', 'pokemon');
    check(r.includes('Pokémon: Detective Pikachu'), `'pokemon' finds 'Pokémon ...'`);

    console.log('=== C. Series + Live search paths ===');
    r = await search('series', 'اخي');
    check(r.includes('أخي في الله'), `[series] 'اخي' finds 'أخي في الله'`);

    r = await search('live', 'الأخبار');
    console.log(`   [live] search='الأخبار' -> ${r.length} results: ${r.slice(0, 6).join(' | ')}`);
    check(r.includes('قناة الأخبار') && r.includes('قناة الاخبار') && r.includes('قناة الأخبار ٢ HD'),
        `[live] 'الأخبار' finds all three spelling variants`);

    console.log('=== D. Nothing that matched before is lost (subset check) ===');
    const subsetJobs = [
        ['movie', MOVIES, ['حب', 'قصة', 'الاخير', 'اخي', 'اخوة', 'spider', 'الحارة']],
        ['series', SERIES, ['حب', 'اخي', 'الحب']],
        ['live', LIVE, ['اخبار', 'قناة']],
    ];
    for (const [kind, corpus, queries] of subsetJobs) {
        for (const q of queries) {
            const oldSet = oldSubstringMatches(corpus, q);
            const newSet = await search(kind, q);
            const newSetS = new Set(newSet);
            const lost = oldSet.filter(n => !newSetS.has(n));
            const added = newSet.filter(n => !oldSet.includes(n));
            const addedNote = added.length ? ` (+${added.length} added: ${added.slice(0, 4).join(' | ')})` : '';
            check(lost.length === 0,
                `[${kind}] '${q}': old=${oldSet.length} new=${newSet.length}${addedNote}${lost.length ? ' LOST: ' + lost.join(',') : ''}`);
        }
    }

    console.log('=== E. Negatives (no garbage for nonsense queries) ===');
    r = await search('movie', 'قققق');
    check(r.length === 0, `nonsense query returns nothing (got ${r.length})`);
    r = await search('movie', 'zzqx');
    check(r.length === 0, `nonsense latin query returns nothing (got ${r.length})`);

    console.log('=== F. Regressions: normal browsing + response shape + manifest ===');
    const browse = await catalog('movie', 'xtremio_movies_popular', 'genre=Movies');
    check((browse.metas || []).length === 100, `browse catalog still returns a full page (${(browse.metas || []).length})`);
    check(browse.metas && browse.metas[0] && typeof browse.metas[0].name === 'string', `browse metas shape ok`);

    const srch = await catalog('movie', 'xtremio_search_movies', 'search=حب');
    check(srch.metas && !('search_name' in srch.metas[0]), `search response does not leak internal fields`);

    const browseSearch = await catalog('movie', 'xtremio_movies_popular', 'genre=Movies&search=اخي');
    const bsNames = (browseSearch.metas || []).map(m => m.name);
    check(bsNames.includes('أخي'), `category-browsing search path also normalizes ('اخي' inside genre catalog)`);

    const man = await (await fetch(`http://127.0.0.1:${APP_PORT}/${CFG}/manifest.json`)).json();
    console.log(`   manifest version: ${man.version}`);
    check(man.version !== '1.1.1', `manifest reports a new version (${man.version})`);

    console.log('=== H. Configure page: category picker + home catalogs ===');
    const baseForm = () => new URLSearchParams({
        serverUrl: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'p', addonName: 'Trex'
    });
    let confResp = await fetch(`http://127.0.0.1:${APP_PORT}/configure`, { method: 'POST', body: baseForm() });
    let confHtml = await confResp.text();
    check(confResp.status === 200, 'POST /configure returns the config page');
    check(confHtml.includes('Home screen catalogs'), 'config page renders the home-catalogs picker');
    check(confHtml.includes('name="picks"') && confHtml.includes('يعرض الأن عربي'), 'category checkboxes rendered with provider names');

    const freshPage = await (await fetch(`http://127.0.0.1:${APP_PORT}/configure`)).text();
    check(freshPage.includes('Save your credentials first') && !freshPage.includes('name="picks"'), 'fresh configure page asks to save credentials first');

    const cfgMatch1 = confHtml.match(/stremio:\/\/[^/]+\/([A-Za-z0-9_-]+)\/manifest\.json/);
    check(!!cfgMatch1, 'install link present on the page');
    const cfg1 = JSON.parse(Buffer.from(cfgMatch1[1], 'base64url').toString());
    check(Array.isArray(cfg1.settings.homeCatalogs) && cfg1.settings.homeCatalogs.length === 0, 'no picks by default');
    const man1 = await (await fetch(`http://127.0.0.1:${APP_PORT}/${cfgMatch1[1]}/manifest.json`)).json();
    check((man1.catalogs || []).length === 9, `no-pick manifest keeps the ${(man1.catalogs || []).length} standard catalogs`);

    const pickForm = baseForm();
    ['s:21', 's:22', 'm:11', 'l:1'].forEach(v => pickForm.append('picks', v));
    confResp = await fetch(`http://127.0.0.1:${APP_PORT}/configure`, { method: 'POST', body: pickForm });
    confHtml = await confResp.text();
    const cfgMatch2 = confHtml.match(/stremio:\/\/[^/]+\/([A-Za-z0-9_-]+)\/manifest\.json/);
    check(!!cfgMatch2, 'install link with picks present');
    const cfg2 = JSON.parse(Buffer.from(cfgMatch2[1], 'base64url').toString());
    check(JSON.stringify(cfg2.settings.homeCatalogs) === JSON.stringify(['s:21', 's:22', 'm:11', 'l:1']), 'picks stored (in order) in the install URL');
    check(confHtml.includes('value="s:21" checked'), 'picker comes back with saved picks checked');

    const ENC2 = cfgMatch2[1];
    const man2 = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/manifest.json`)).json();
    const byId = oid => (man2.catalogs || []).find(c => c.id === oid);
    check(byId('xtremio_pick_s_21') && byId('xtremio_pick_s_21').name === '|AR| يعرض الأن عربي', 'series pick catalog exposed with its provider name');
    check(byId('xtremio_pick_m_11') && byId('xtremio_pick_m_11').type === 'XT-Movies', 'movie pick catalog exposed under the movies type');
    check(byId('xtremio_pick_l_1') && byId('xtremio_pick_l_1').type === 'Live TV', 'live pick catalog exposed under the live type');
    check((man2.catalogs || []).length === 13, `manifest carries 9 standard + 4 pick catalogs (got ${(man2.catalogs || []).length})`);

    const pk = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/catalog/series/xtremio_pick_s_21.json`)).json();
    const pkNames = (pk.metas || []).map(m => m.name);
    check(pkNames.includes('AR - مسلسل الأن عربي 1'), 'pick catalog serves its own category items');
    check(!pkNames.includes('AR - مسلسل الأن تركي 1'), 'pick catalog excludes other categories');
    check((pk.metas || []).every(m => m.id.startsWith('xtremio_series_')), 'pick items keep standard ids (detail pages work)');

    const pkSearch = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/catalog/series/xtremio_pick_s_22/search=${encodeURIComponent('الان تركي')}.json`)).json();
    check((pkSearch.metas || []).some(m => m.name.includes('تركي')), 'search inside a pick catalog works (normalized)');

    const cfgBad = Buffer.from(JSON.stringify({ serverUrl: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'p', settings: { homeCatalogs: ['m:999', 's:21', 'x:1', 'm:bad id'] } })).toString('base64url');
    const man3 = await (await fetch(`http://127.0.0.1:${APP_PORT}/${cfgBad}/manifest.json`)).json();
    check(!(man3.catalogs || []).some(c => c.id.includes('m_999')), 'unknown/hostile picks are skipped');
    check((man3.catalogs || []).some(c => c.id === 'xtremio_pick_s_21'), 'valid picks still served alongside');

    const editPage = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/configure`)).text();
    check(editPage.includes('value="s:21" checked') && editPage.includes('value="m:11" checked'), 'edit page shows the saved selection checked');

    console.log('=== G. Perf: in-memory scan stays fast ===');
    const t0 = process.hrtime.bigint();
    r = await search('movie', 'الحب');
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`   search over ${MOVIES.length} movie titles took ${dt.toFixed(1)} ms (request + filter)`);

    console.log('=== I. Live: ##### section headers are never shown ===');
    const isHeader = n => /#{3,}/.test(n);
    const lb = await catalog('live', 'xtremio_live', 'genre=Live');
    const lbNames = (lb.metas || []).map(m => m.name);
    check(lbNames.length === 100, `live browse still returns a full page (${lbNames.length})`);
    check(!lbNames.some(isHeader), 'live browse page contains no hash-wrapped headers');
    check(!lbNames.includes('##### AL-MAJD GROUP #####'), 'header entry is excluded from its category');
    check(lbNames.includes('beIN Sports 1') && lbNames.includes('Music #1'), 'normal channels are kept (single-# name stays)');

    const lh = await search('live', 'BEIN');
    check(!lh.some(isHeader), "live search results contain no headers ('BEIN')");
    check(lh.includes('beIN Sports 1') && lh.includes('beIN Sports 2'), "'BEIN' finds both beIN channels");

    const lhMajd = await search('live', 'MAJD');
    check(lhMajd.length === 0, `'MAJD' returns 0: its only match was a header (got ${lhMajd.length})`);

    const lpk = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/catalog/live/xtremio_pick_l_1.json`)).json();
    const lpkNames = (lpk.metas || []).map(m => m.name);
    check(!lpkNames.some(isHeader) && lpkNames.includes('beIN Sports 1'), 'live pick catalog also hides headers');

    console.log('=== J. Live search: relevance order + compact matching ===');
    const ord = await search('live', 'bein');
    const pos = n => ord.indexOf(n);
    console.log(`   'bein' -> ${ord.length} results: ${ord.slice(0, 6).join(' | ')}`);
    check(pos('beIN Sports 1') !== -1 && pos('beIN Sports 2') !== -1 && pos('BEINSPORTS 3') !== -1,
        "'bein' returns every bein-branded channel");
    check(pos('Otterbein College TV') > pos('beIN Sports 1') && pos('Otterbein College TV') > pos('BEINSPORTS 3'),
        'word-start matches rank above mid-word matches (Otterbein last)');

    const comp = await search('live', 'beinsports');
    console.log(`   'beinsports' -> ${comp.length} results: ${comp.slice(0, 5).join(' | ')}`);
    check(comp.includes('beIN Sports 1') && comp.includes('beIN Sports 2') && comp.includes('BEINSPORTS 3'),
        "'beinsports' (no spaces) finds all three anyway");

    const one = await search('live', 'bein 1');
    check(one.includes('beIN Sports 1') && !one.includes('beIN Sports 2'), "'bein 1' narrows to 'beIN Sports 1'");

    const rev = await search('live', 'sports bein');
    check(rev.includes('beIN Sports 1'), "word order doesn't matter ('sports bein')");

    console.log('=== K. Stream responses: live options + playback hints ===');
    const firstLive = LIVE.find(x => x.name === 'beIN Sports 1');
    const firstMovie = MOVIES.find(x => x.name === 'أخي');
    let st = await streamReq('live', 'xtremio_live_' + firstLive.stream_id);
    let opts = st.streams || [];
    check(opts.length === 2, `live offers 2 options (${opts.length})`);
    check(opts[0] && opts[0].title === 'MPEG-TS' && /\.ts$/.test(opts[0].url), 'raw MPEG-TS is the first option');
    check(opts[1] && opts[1].title === 'HLS' && /\.m3u8$/.test(opts[1].url), 'HLS stays as the second option');
    check(opts.every(o => o.behaviorHints && o.behaviorHints.notWebReady === true), 'live options carry the notWebReady hint');

    st = await streamReq('movie', 'xtremio_movie_' + firstMovie.stream_id);
    opts = st.streams || [];
    check(opts.length === 1 && /\.mkv$/.test(opts[0].url), 'movie stream uses the provider container extension (.mkv)');
    check(opts[0] && opts[0].behaviorHints && opts[0].behaviorHints.notWebReady === true, 'movie stream carries the notWebReady hint');

    console.log('=== L. Manifest: only search catalogs are searchable, and they lead ===');
    const hasSearch = c => (c.extra || []).some(e => e.name === 'search');
    const manDef = await (await fetch(`http://127.0.0.1:${APP_PORT}/${CFG}/manifest.json`)).json();
    const cDef = manDef.catalogs || [];
    check(cDef[0] && cDef[0].id === 'xtremio_search_movies' && cDef[1] && cDef[1].id === 'xtremio_search_series',
        `default manifest starts with Search Movies + Search Series (${cDef[0] && cDef[0].id}, ${cDef[1] && cDef[1].id})`);
    check(!cDef.some(c => c.id === 'xtremio_search_live'), 'live search catalog absent when the toggle is off');
    const browseDef = cDef.filter(c => !c.id.startsWith('xtremio_search_'));
    check(browseDef.length === 7, `7 browsing catalogs present (${browseDef.length})`);
    check(browseDef.every(c => !hasSearch(c)), 'no browsing catalog advertises a search extra');
    check(browseDef.every(c => (c.extra || []).some(e => e.name === 'genre')), 'browsing catalogs keep their genre picker');
    check(cDef.filter(c => c.id.startsWith('xtremio_search_')).every(hasSearch), 'search catalogs keep their search extra');

    const manPk = await (await fetch(`http://127.0.0.1:${APP_PORT}/${ENC2}/manifest.json`)).json();
    const cPk = manPk.catalogs || [];
    const picksPk = cPk.filter(c => c.id.startsWith('xtremio_pick_'));
    check(picksPk.length === 4, `4 pick catalogs present (${picksPk.length})`);
    check(picksPk.every(c => !hasSearch(c)), 'pick catalogs are not searchable');
    check(cPk[0].id === 'xtremio_search_movies' && cPk[1].id === 'xtremio_search_series', 'search catalogs still lead with picks present');

    const cfgLS = Buffer.from(JSON.stringify({ serverUrl: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'p', settings: { enableLiveSearch: true } })).toString('base64url');
    const manLS = await (await fetch(`http://127.0.0.1:${APP_PORT}/${cfgLS}/manifest.json`)).json();
    const cLS = manLS.catalogs || [];
    check(cLS[0] && cLS[0].id === 'xtremio_search_movies' && cLS[1] && cLS[1].id === 'xtremio_search_series' && cLS[2] && cLS[2].id === 'xtremio_search_live',
        'with live search enabled the order is Movies -> Series -> Live');
    check(cLS.filter(c => c.id.startsWith('xtremio_search_')).every(hasSearch) && cLS.filter(c => !c.id.startsWith('xtremio_search_')).every(c => !hasSearch(c)),
        'same searchability rules in the live-search manifest');

    console.log('=== M. Play endpoint: verifies the node assignment ===');
    async function setStreamMode(mode, bad = 0) {
        await fetch(`http://127.0.0.1:${MOCK_PORT}/__mode?mode=${mode}&bad=${bad}`);
    }
    async function playProbe(path) {
        const r = await fetch(`http://127.0.0.1:${APP_PORT}/${CFG}/${path}`, { redirect: 'manual' });
        return { status: r.status, loc: r.headers.get('location') || '', cache: r.headers.get('x-xtremio-cache') || '' };
    }
    await setStreamMode('firstbad', 1);
    let pr = await playProbe('play/live/999001.ts');
    check(pr.status === 302 && pr.loc.includes('/edge/good-999001.ts'),
        `broken node skipped, working node handed to player (${pr.loc.split('/').pop()})`);

    await setStreamMode('allbad');
    pr = await playProbe('play/live/999002.ts');
    check(pr.status === 302 && pr.loc.includes('/live/u/p/999002.ts') && !pr.loc.includes('/edge/'),
        `all nodes broken -> plain upstream fallback (${pr.loc.split('/').slice(-4).join('/')})`);

    await setStreamMode('ok');
    pr = await playProbe('play/movie/12345.mkv');
    check(pr.status === 302 && pr.loc.includes('/edge/good-12345.mkv'), 'movie resolves through the same verified path');
    pr = await playProbe('play/episode/ep777.mp4');
    check(pr.status === 302 && pr.loc.includes('/edge/good-ep777.mp4'), 'episode resolves through the same verified path');

    const sl2 = await streamReq('live', 'xtremio_live_' + firstLive.stream_id);
    check(sl2.streams[0].url.includes(`/${CFG}/play/live/`) && sl2.streams[0].url.endsWith('.ts'),
        'live MPEG-TS entry routes through the play endpoint');
    check(sl2.streams[1].url.includes('.m3u8') && !sl2.streams[1].url.includes('/play/'), 'HLS entry stays direct');
    const sm2 = await streamReq('movie', 'xtremio_movie_' + firstMovie.stream_id);
    check(sm2.streams[0].url.includes(`/${CFG}/play/movie/`) && sm2.streams[0].url.endsWith('.mkv'),
        'movie entry routes through the play endpoint');

    await setStreamMode('direct');
    const hitsBefore = STREAM_SIM.hits;
    pr = await playProbe('play/live/999003.ts');
    check(pr.status === 302 && pr.loc.includes('/live/u/p/999003.ts') && !pr.loc.includes('/edge/'),
        'direct-serving provider passed through (no node games)');
    check(STREAM_SIM.hits - hitsBefore === 1,
        `direct stream touched once, no wasted attempts (${STREAM_SIM.hits - hitsBefore})`);
    await setStreamMode('ok');

    // fast-start behavior: cache + in-flight de-dup + source-list pre-warm
    pr = await playProbe('play/live/999030.ts');
    check(pr.status === 302 && pr.cache === 'miss' && pr.loc.includes('/edge/good-999030.ts'), 'fresh play verifies then serves (cache miss)');
    const hitsC = STREAM_SIM.hits;
    const pr2 = await playProbe('play/live/999030.ts');
    check(pr2.loc === pr.loc && pr2.cache === 'hit' && STREAM_SIM.hits === hitsC, 'verified URL cached: repeat open costs no upstream touch');

    const hitsD = STREAM_SIM.hits;
    const [pc1, pc2] = await Promise.all([playProbe('play/live/999031.ts'), playProbe('play/live/999031.ts')]);
    check(pc1.loc === pc2.loc && pc1.loc.includes('/edge/good-999031.ts') && STREAM_SIM.hits - hitsD === 1,
        'parallel opens share one verification');

    const warmLive = LIVE.find(x => x.name === 'Music #1');
    const hitsE = STREAM_SIM.hits;
    await streamReq('live', 'xtremio_live_' + warmLive.stream_id);
    await new Promise(r => setTimeout(r, 600));
    check(STREAM_SIM.hits > hitsE, 'opening the source list pre-warms the stream in the background');
    pr = await playProbe('play/live/' + warmLive.stream_id + '.ts');
    check(pr.cache === 'hit' && pr.loc.includes('/edge/good-'), 'pre-warmed verification reused on play (instant start)');

    console.log('');
    console.log(`=== SUMMARY: ${checks - failures.length}/${checks} checks passed ===`);
    if (failures.length) {
        console.log('FAILED:');
        for (const f of failures) console.log(' - ' + f);
    }
    return failures.length ? 1 : 0;
}

function closeAll() {
    try { mock.close(); } catch {}
    try { nodes.close(); } catch {}
}

nodes.listen(NODE_PORT, '127.0.0.1');
mock.listen(MOCK_PORT, '127.0.0.1', async () => {
    require('./index.js');
    try {
        await waitUp();
        const code = await main();
        closeAll();
        process.exit(code);
    } catch (e) {
        console.error('TEST RUN ERROR:', e);
        closeAll();
        process.exit(2);
    }
});
