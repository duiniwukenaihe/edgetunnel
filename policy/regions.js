function 默认区域配置() {
	return { version: 1, defaultRegion: 'US', regions: [
		{ code: 'US', name: '美国', exits: 美国出口.split(',') }
	] };
}

function 区域错误(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

function 区域错误响应(error) {
	return Response.json({ error: error.message }, { status: error.status || 503,
		headers: { 'Cache-Control': 'no-store' } });
}

function 验证区域配置(input) {
	if (!input || input.version !== 1 || !Array.isArray(input.regions) || input.regions.length < 1 || input.regions.length > 16)
		throw 区域错误('需要 1–16 个区域，配置版本必须为 1。');
	const codes = new Set(), names = new Set();
	const regions = input.regions.map(region => {
		if (!region || typeof region.code !== 'string' || !/^[A-Z]{2}$/.test(region.code) || codes.has(region.code))
			throw 区域错误('区域代码必须是唯一的两位大写字母。');
		const name = typeof region.name === 'string' ? region.name.trim() : '';
		if (!name || name.length > 32 || /[\x00-\x1f\x7f]/.test(name) || names.has(name))
			throw 区域错误('区域名称须唯一、非空且不超过 32 字符。');
		if (!Array.isArray(region.exits) || region.exits.length < 1 || region.exits.length > 8)
			throw 区域错误('每区需要 1–8 个有序出口。');
		const exits = region.exits.map(exit => {
			const match = typeof exit === 'string' && exit.trim().match(/^(\[[0-9a-fA-F:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
			if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
				throw 区域错误('出口须为 IPv4:端口 或 [IPv6]:端口，端口为 1–65535。');
			let hostname = match[1];
			if (hostname.startsWith('[')) {
				try { hostname = new URL('http://' + hostname + '/').hostname; }
				catch { throw 区域错误('IPv6 地址无效。'); }
			} else if (!hostname.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part)) {
				throw 区域错误('IPv4 地址无效。');
			}
			return hostname + ':' + Number(match[2]);
		});
		if (new Set(exits).size !== exits.length) throw 区域错误('同一区域的出口不能重复。');
		codes.add(region.code); names.add(name);
		return { code: region.code, name, exits };
	});
	if (!codes.has(input.defaultRegion)) throw 区域错误('默认区域必须在已配置区域中。');
	return { version: 1, defaultRegion: input.defaultRegion, regions };
}

async function 读取区域配置(env) {
	if (!env?.KV || typeof env.KV.get !== 'function') throw 区域错误('配置存储 KV 不可用。', 503);
	try {
		const stored = await env.KV.get('regions.json');
		return stored === null ? 默认区域配置() : 验证区域配置(JSON.parse(stored));
	} catch {
		throw 区域错误('区域配置损坏或读取失败，请在管理面板修复。', 503);
	}
}

function 选择区域(config, url) {
	const values = url.searchParams.getAll('region');
	if (values.length > 1 || (values.length === 1 && !/^[a-zA-Z]{2}$/.test(values[0])))
		throw 区域错误('region 参数必须是单个两位区域代码。');
	const code = values.length ? values[0].toUpperCase() : config.defaultRegion;
	const region = config.regions.find(region => region.code === code);
	if (!region) throw 区域错误('所选区域不存在，请更新订阅或在面板中配置。');
	return region;
}

function 订阅区域列表(config, selected) {
	return selected ? [selected] : [config.regions.find(r => r.code === config.defaultRegion),
		...config.regions.filter(r => r.code !== config.defaultRegion)];
}

function 生成区域通用订阅(config, protocol, regions = 默认区域配置(), selected = null) {
	const host = config.HOST, uuid = config.UUID;
	return 订阅区域列表(regions, selected).map(region => {
		if (protocol === 'ss') {
			const cipher = config.SS?.加密方式 || 'aes-128-gcm';
			const plugin = `v2ray-plugin;mode=websocket;host=${host};path=/?enc=${cipher}&region=${region.code};tls;mux=0`;
			return `ss://${btoa(cipher + ':' + uuid)}@${host}:443?plugin=${encodeURIComponent(plugin)}#${region.code}-SS`;
		}
		const params = new URLSearchParams({ security: 'tls', type: 'ws', host, sni: host,
			path: '/?region=' + region.code, encryption: 'none', fp: 'chrome' });
		return `vless://${uuid}@${host}:443?${params}#${region.code}-VLESS`;
	}).join('\n');
}

function 生成区域Clash订阅(config, regions = 默认区域配置(), selected = null) {
	const host = config.HOST, uuid = config.UUID, cipher = config.SS?.加密方式 || 'aes-128-gcm';
	const proxies = [], groups = [];
	for (const region of 订阅区域列表(regions, selected)) {
		const vlessName = region.code + '-VLESS', ssName = region.code + '-SS';
		proxies.push(
			{ name: vlessName, type: 'vless', server: host, port: 443, uuid, tls: true,
				udp: false, servername: host, network: 'ws', 'client-fingerprint': 'chrome',
				'ws-opts': { path: '/?region=' + region.code, headers: { Host: host } } },
			{ name: ssName, type: 'ss', server: host, port: 443, cipher, password: uuid,
				udp: false, plugin: 'v2ray-plugin', 'plugin-opts': { mode: 'websocket', tls: true,
					host, path: '/?enc=' + cipher + '&region=' + region.code, mux: false } }
		);
		groups.push({ name: region.code + ' · ' + region.name + '自动切换', type: 'fallback',
			proxies: [vlessName, ssName], url: 'https://www.cloudflare.com/cdn-cgi/trace',
			'expected-status': 200, interval: 300, lazy: false });
	}
	return JSON.stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
		proxies, 'proxy-groups': [{ name: '地区选择', type: 'select', proxies: groups.map(g => g.name) }, ...groups],
		rules: ['MATCH,地区选择'] }, null, 2);
}

async function 反代参数获取(url, uuid, 默认反代IP = '', 默认反代兜底 = true, env) {
	// 旧签名仍用于独立策略调用；所有真实代理入口明确传入 env。
	const config = env === undefined ? 默认区域配置() : await 读取区域配置(env);
	const region = 选择区域(config, url);
	return { 木马反代地址: null, 反代IP: region.exits.join(','), 代理类型: 'proxyip',
		代理账号: '', 代理全局: true, 代理参数: {}, 反代兜底: false };
}

async function 处理区域管理(request, env, url, host, uuid) {
	const headers = { 'Cache-Control': 'no-store' };
	if (url.pathname === '/admin/regions') {
		if (request.method !== 'GET') return new Response('仅支持 GET。', { status: 405, headers });
		return new Response(区域管理页面, { headers: { ...headers, 'Content-Type': 'text/html;charset=utf-8',
			'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
			'X-Content-Type-Options': 'nosniff' } });
	}
	if (request.method === 'POST') {
		if (request.headers.get('Origin') !== url.origin || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || ''))
			return 区域错误响应(区域错误('保存需要同源 JSON 请求。', 403));
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
		return Response.json({ config, subscriptions: { clash: subscription('clash'),
			vless: subscription('mixed', 'vless'), ss: subscription('mixed', 'ss') } }, { headers });
	} catch (error) { return 区域错误响应(error); }
}
