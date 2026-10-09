const 自动地区目录 = [
	{ code: 'US', name: '美国' }, { code: 'JP', name: '日本' }, { code: 'SG', name: '新加坡' },
	{ code: 'HK', name: '香港' }, { code: 'DE', name: '德国' }, { code: 'GB', name: '英国' }
].map(region => ({ ...region, source: 'cmliu-' + region.code.toLowerCase() + '-dns',
	hostname: 'proxyip.' + region.code.toLowerCase() + '.cmliussss.net' }));

function 默认区域配置() {
	return { version: 3, defaultRegion: 'US', regions: 自动地区目录.map(({ code, name, source }) =>
		({ code, name, exits: [], auto: true, source })) };
}

function 区域错误(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

function 区域错误响应(error) {
	return Response.json({ error: error.message }, { status: error.status || 503,
		headers: { 'Cache-Control': 'no-store' } });
}

function 验证区域配置(input) {
	if (!input || ![1, 2, 3].includes(input.version) || !Array.isArray(input.regions) || input.regions.length < 1 || input.regions.length > 16)
		throw 区域错误('需要 1–16 个区域，配置版本必须为 1、2 或 3。');
	const codes = new Set(), names = new Set();
	const regions = input.regions.map(region => {
		if (!region || typeof region.code !== 'string' || !/^[A-Z]{2}$/.test(region.code) || codes.has(region.code))
			throw 区域错误('区域代码必须是唯一的两位大写字母。');
		const name = typeof region.name === 'string' ? region.name.trim() : '';
		if (!name || name.length > 32 || /[\x00-\x1f\x7f]/.test(name) || names.has(name) || ['地区选择','DIRECT','REJECT','REJECT-DROP','PASS','COMPATIBLE','GLOBAL'].includes(name) || / · (VLESS|SS)$/.test(name))
			throw 区域错误('区域名称须唯一、非空且不超过 32 字符，不能与订阅分组或协议节点名称冲突。');
		const auto = input.version === 1 ? false : region.auto;
		if (typeof auto !== 'boolean' || (auto && !自动地区目录.some(item => item.code === region.code && item.source === region.source)) ||
			(!auto && input.version !== 1 && region.source !== null)) throw 区域错误('自动来源须与地区目录匹配；手动区域的 source 必须为空。');
		if (!Array.isArray(region.exits) || region.exits.length < (auto ? 0 : 1) || region.exits.length > 8)
			throw 区域错误('每区最多 8 个手动候选；未启用自动来源时至少填写一个。');
		const exits = region.exits.map(exit => 验证公共出口(typeof exit === 'string' ? exit.trim() : exit));
		if (new Set(exits).size !== exits.length) throw 区域错误('同一区域的出口不能重复。');
		codes.add(region.code); names.add(name);
		return { code: region.code, name, exits, auto, source: auto ? region.source : null };
	});
	if (!codes.has(input.defaultRegion)) throw 区域错误('默认区域必须在已配置区域中。');
	return { version: 3, defaultRegion: input.defaultRegion, regions };
}

async function 读取区域配置(env) {
	if (!env?.KV || typeof env.KV.get !== 'function') throw 区域错误('配置存储 KV 不可用。', 503);
	try {
		const stored = await env.KV.get('regions.json');
		if (stored === null) return 默认区域配置();
		const input = JSON.parse(stored), config = 验证区域配置(input);
		// Upgrade the earlier US-auto defaults in memory; explicit v3 removals stay removed.
		if (input.version === 2 && config.regions.some(region => region.auto)) {
			for (const region of 默认区域配置().regions)
				if (config.regions.length < 16 && !config.regions.some(item => item.code === region.code || item.name === region.name)) config.regions.push(region);
		}
		return config;
	} catch {
		throw 区域错误('区域配置损坏或读取失败，请在管理面板修复。', 503);
	}
}

const 美国子区域 = [
	{ code: 'US-EAST', area: 'east', name: '美国东部' },
	{ code: 'US-CENTRAL', area: 'central', name: '美国中部' },
	{ code: 'US-WEST', area: 'west', name: '美国西部' }
];

function 区域入口列表(config) {
	return config.regions.flatMap(region => {
		const entry = { ...region, country: region.code, area: null, name: 'Naiops-' + region.code + ' · ' + region.name + '自动' };
		return region.code === 'US' ? [entry, ...美国子区域.map(child => ({ ...entry, ...child, name: 'Naiops-' + child.code + ' · ' + child.name }))] : [entry];
	});
}

function 选择区域(config, url) {
	const values = url.searchParams.getAll('region');
	if (values.length > 1 || (values.length === 1 && !/^[a-zA-Z]{2}(?:-(?:EAST|CENTRAL|WEST))?$/i.test(values[0])))
		throw 区域错误('region 参数必须是单个有效区域代码。');
	const code = values.length ? values[0].toUpperCase() : config.defaultRegion;
	const region = 区域入口列表(config).find(region => region.code === code);
	if (!region) throw 区域错误('所选区域不存在，请更新订阅或在面板中配置。');
	return region;
}

function 订阅区域列表(config, selected) {
	const entries = 区域入口列表(config);
	return selected ? [entries.find(region => region.code === selected.code)] : [entries.find(r => r.code === config.defaultRegion),
		...entries.filter(r => r.code !== config.defaultRegion)];
}

function 生成区域通用订阅(config, protocol, regions = 默认区域配置(), selected = null) {
	const host = config.HOST, uuid = config.UUID;
	return 订阅区域列表(regions, selected).map(region => {
		if (protocol === 'ss') {
			const cipher = config.SS?.加密方式 || 'aes-128-gcm';
			const plugin = `v2ray-plugin;mode=websocket;host=${host};path=/?enc=${cipher}&region=${region.code};tls;mux=0`;
			return `ss://${btoa(cipher + ':' + uuid)}@${host}:443?plugin=${encodeURIComponent(plugin)}#${encodeURIComponent(region.name)}`;
		}
		const params = new URLSearchParams({ security: 'tls', type: 'ws', host, sni: host,
			path: '/?region=' + region.code, encryption: 'none', fp: 'chrome' });
		return `vless://${uuid}@${host}:443?${params}#${encodeURIComponent(region.name)}`;
	}).join('\n');
}

function 生成区域Clash订阅(config, regions = 默认区域配置(), selected = null) {
	const host = config.HOST, uuid = config.UUID, cipher = config.SS?.加密方式 || 'aes-128-gcm';
	const proxies = [], groups = [];
	for (const region of 订阅区域列表(regions, selected)) {
		const vlessName = region.name + ' · VLESS', ssName = region.name + ' · SS';
		proxies.push(
			{ name: vlessName, type: 'vless', server: host, port: 443, uuid, tls: true,
				udp: false, servername: host, network: 'ws', 'client-fingerprint': 'chrome',
				'ws-opts': { path: '/?region=' + region.code, headers: { Host: host } } },
			{ name: ssName, type: 'ss', server: host, port: 443, cipher, password: uuid,
				udp: false, plugin: 'v2ray-plugin', 'plugin-opts': { mode: 'websocket', tls: true,
					host, path: '/?enc=' + cipher + '&region=' + region.code, mux: false } }
		);
		groups.push({ name: region.name, type: 'fallback',
			proxies: [vlessName, ssName], url: 'https://www.cloudflare.com/cdn-cgi/trace',
			'expected-status': 200, interval: 300, lazy: false });
	}
	return JSON.stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
		proxies, 'proxy-groups': [{ name: '地区选择', type: 'select', proxies: groups.map(g => g.name) }, ...groups],
		rules: ['MATCH,地区选择'] }, null, 2);
}

async function 反代参数获取(url, uuid, 默认反代IP = '', 默认反代兜底 = true, env, request) {
	const config = await 读取区域配置(env);
	const region = 选择区域(config, url);
	return { 木马反代地址: null, 反代IP: region.exits.join(','), 代理类型: 'proxyip',
		代理账号: '', 代理全局: true, 代理参数: {}, 反代兜底: false,
		获取验证出口: () => 获取有效区域池(env, region, request || new Request(url.href)) };
}

async function 处理区域管理(request, env, url, host, uuid) {
	const headers = { 'Cache-Control': 'no-store' };
	if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin ||
		!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')))
		return 区域错误响应(区域错误('保存或刷新需要同源 JSON 请求。', 403));
	if (url.pathname === '/admin/exits.json') {
		if (!['GET', 'POST'].includes(request.method)) return new Response('仅支持 GET 或 POST。', { status: 405, headers });
		try {
			const region = 选择区域(await 读取区域配置(env), url);
			let refreshError;
			if (request.method === 'POST') {
				let body;
				try { body = await request.json(); } catch { throw 区域错误('JSON 格式无效。'); }
				if (!body || Array.isArray(body) || Object.keys(body).length) throw 区域错误('刷新请求须为空 JSON 对象。');
				try { await 获取有效区域池(env, region, request, true); }
				catch (error) { if (error.status !== 503) throw error; refreshError = error; }
			}
			const { entry } = await 读取出口池状态(env, region, request);
			const pool = 区域池视图(entry.pool, region);
			const unavailableState = 区域不可用状态(entry.pool, region);
			const reasons = { not_checked: '尚未检测当前国家出口。', expired: '所选区域的出口证明已过期。',
				source_failed: '发现来源或检测失败，当前区域暂无有效出口。', missing_geo: '有效国家出口缺少可识别的美国州证据。',
				area_unavailable: '所选美国子区域暂无有效州证据出口。', country_unavailable: '当前国家暂无有效出口。' };
			return Response.json({ region: region.code, country: region.country, area: region.area, colo: request.cf?.colo || 'unknown', pool,
				availableCount: pool?.exits.length || 0, countryPool: 区域池统计(entry.pool, region.country),
				unavailableState, unavailableReason: unavailableState ? reasons[unavailableState] : null,
				...(refreshError ? { error: refreshError.message } : {}),
				available: !!pool?.exits.length,
				refreshSeconds: 900, expirySeconds: 1800 }, { status: refreshError ? 503 : 200, headers });
		} catch (error) { return 区域错误响应(error); }
	}
	if (url.pathname === '/admin/regions') {
		if (request.method !== 'GET') return new Response('仅支持 GET。', { status: 405, headers });
		return new Response(区域管理页面, { headers: { ...headers, 'Content-Type': 'text/html;charset=utf-8',
			'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
			'X-Content-Type-Options': 'nosniff' } });
	}
	if (request.method === 'POST') {
		let config;
		try { config = 验证区域配置(await request.json()); }
		catch (error) { return 区域错误响应(区域错误(error instanceof SyntaxError ? 'JSON 格式无效。' : error.message)); }
		try { await env.KV.put('regions.json', JSON.stringify(config)); }
		catch { return 区域错误响应(区域错误('区域配置保存失败，请稍后重试。', 503)); }
		return Response.json({ success: true, config, message: '配置已保存；各地 KV 更新可能需要约一分钟，已有连接继续使用原出口。' }, { headers });
	}
	if (request.method !== 'GET') return new Response('仅支持 GET 或 POST。', { status: 405, headers });
	try {
		const config = await 读取区域配置(env), token = await MD5MD5(host + uuid);
		const base = new URL('/sub', url.origin); base.searchParams.set('token', token);
		const subscription = (target, protocol) => {
			const address = new URL(base); address.searchParams.set('target', target);
			if (protocol) address.searchParams.set('protocol', protocol);
			return address.href;
		};
		return Response.json({ config, entries: 订阅区域列表(config), sources: 自动地区目录, subscriptions: { clash: subscription('clash'),
			vless: subscription('mixed', 'vless'), ss: subscription('mixed', 'ss') } }, { headers });
	} catch (error) { return 区域错误响应(error); }
}
