const 出口刷新间隔 = 15 * 60 * 1000, 出口有效期 = 30 * 60 * 1000;
const 区域池实例状态 = new WeakMap();
const 出口检测主机 = 'www.cloudflare.com';

function 验证公共出口(value) {
	const match = typeof value === 'string' && value.match(/^(\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):443$/);
	if (!match) throw 区域错误('候选出口必须是公共 IP:443。');
	let host = match[1];
	if (host.startsWith('[')) {
		try { host = new URL('http://' + host).hostname; } catch { throw 区域错误('IPv6 地址无效。'); }
		const first = parseInt(host.slice(1).split(':')[0], 16);
		// Global unicast only; exclude documentation, transition and special-purpose space.
		const second = parseInt(host.slice(1).split(':')[1] || '0', 16);
		if (!(first >= 0x2000 && first <= 0x3ffe) || (first === 0x2001 && (second < 0x200 || second === 0xdb8)) || first === 0x2002)
			throw 区域错误('IPv6 候选必须是公共单播地址。');
	} else {
		const parts = host.split('.').map(Number), [a, b, c] = parts;
		if (parts.some((part, i) => part > 255 || String(part) !== host.split('.')[i]) ||
			a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 88 && c === 99) || (b === 0 && (c === 0 || c === 2)))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
			throw 区域错误('IPv4 候选必须是公共单播地址。');
	}
	return host + ':443';
}

function 解析出口检测响应(text, code) {
	const split = text.indexOf('\r\n\r\n');
	if (split < 0 || !/^HTTP\/1\.[01] 200(?: |\r\n)/.test(text)) throw 区域错误('出口检测未返回 HTTP 200。', 503);
	const lines = text.slice(split + 4).trim().split(/\r?\n/);
	const ips = lines.filter(line => line.startsWith('ip=')), countries = lines.filter(line => line.startsWith('loc='));
	if (ips.length !== 1 || countries.length !== 1 || countries[0] !== 'loc=' + code)
		throw Object.assign(区域错误('实际出口国家未知或不符合所选区域。', 503), { invalidatesExit: true });
	const exitIP = ips[0].slice(3);
	验证公共出口((exitIP.includes(':') ? '[' + exitIP + ']' : exitIP) + ':443');
	return { exitIP, country: code };
}

async function 读取验证TLS响应(address, expectedHostname = 出口检测主机, signal) {
	let raw, socket, reader, timer, stage = 'connect', finished = false, rejectAbort;
	const close = () => { try { socket?.close()?.catch(() => {}); } catch {} try { raw?.close()?.catch(() => {}); } catch {} };
	const abort = () => { finished = true; close(); rejectAbort?.(new Error('检测已取消。')); };
	try {
		验证公共出口(address);
		if (signal?.aborted) throw new Error('检测已取消。');
		signal?.addEventListener('abort', abort, { once: true });
		return await Promise.race([
			(async () => {
				const host = address.slice(0, -4).replace(/^\[|\]$/g, '');
				raw = connect({ hostname: host, port: 443 }, { secureTransport: 'starttls' });
				raw.closed?.catch(() => {});
				await raw.opened;
				if (finished || signal?.aborted) throw new Error('检测已取消。');
				stage = 'tls'; socket = raw.startTls({ expectedServerHostname: expectedHostname });
				socket.closed?.catch(() => {});
				await socket.opened;
				if (finished || signal?.aborted) throw new Error('检测已取消。');
				const writer = socket.writable.getWriter();
				try { await writer.write(new TextEncoder().encode(`GET /cdn-cgi/trace HTTP/1.0\r\nHost: ${出口检测主机}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`)); }
				finally { writer.releaseLock(); }
				reader = socket.readable.getReader();
				let size = 0, response = ''; const decoder = new TextDecoder();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength; if (size > 8192) throw new Error('检测响应超过限制。');
					stage = 'response'; response += decoder.decode(value, { stream: true });
				}
				return response + decoder.decode();
			})(),
			new Promise((_, reject) => { rejectAbort = reject; timer = setTimeout(() => { finished = true; close(); reject(new Error('TLS 检测超时。')); }, 4000); })
		]);
	} catch (error) { error.probeStage = stage; throw error; }
	finally {
		finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
		try { reader?.releaseLock(); } catch {} close();
	}
}

async function 探测区域出口(address, code, signal) {
	const controller = new AbortController(), abort = () => controller.abort();
	const timer = setTimeout(abort, 4000); signal?.addEventListener('abort', abort, { once: true });
	try {
		if (signal?.aborted) controller.abort();
		const start = performance.now();
		const trace = 解析出口检测响应(await 读取验证TLS响应(address, 出口检测主机, controller.signal), code);
		const latency = Math.round(performance.now() - start);
		// A reset/EOF is not evidence of certificate-name validation.
		let rejected = false;
		try { await 读取验证TLS响应(address, 'invalid.naiops.test', controller.signal); }
		catch (error) {
			if (error.probeStage === 'tls' && (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
				/hostname mismatch|certificate name mismatch|certificate.*(?:does not match|not valid for)/i.test(error.message))) rejected = true;
		}
		if (!rejected) throw 区域错误('证书域名反向校验未得到明确的主机名拒绝证据，拒绝启用该出口。', 503);
		return { address, ...trace, latency, checkedAt: Date.now(), tlsNameVerified: true };
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

async function 有界检测JSON(response) {
	if (!response.ok || !response.body) throw new Error('发现来源不可用。');
	const reader = response.body.getReader(); let size = 0, text = ''; const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.byteLength; if (size > 32768) throw new Error('发现来源响应过大。');
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function 发现区域候选(region, signal, failures = []) {
	const results = new Set(region.exits.map(验证公共出口));
	if (region.auto) {
		if (region.code !== 'US' || region.source !== 'cmliu-us-dns') throw 区域错误('该区域没有受支持的自动来源。');
		for (const type of ['A', 'AAAA']) {
			if (signal?.aborted) throw new Error('出口发现已取消。');
			const url = new URL('https://cloudflare-dns.com/dns-query');
			url.searchParams.set('name', 'proxyip.us.cmliussss.net'); url.searchParams.set('type', type);
			const controller = new AbortController(), abort = () => controller.abort();
			const timer = setTimeout(abort, 3000); signal?.addEventListener('abort', abort, { once: true });
			try {
				if (signal?.aborted) controller.abort();
				const data = await 有界检测JSON(await fetch(url.href, { headers: { Accept: 'application/dns-json' }, signal: controller.signal }));
				if (signal?.aborted) throw new Error('出口发现已取消。');
				if (data.Status !== 0 || !Array.isArray(data.Answer)) throw new Error('DNS 没有有效应答。');
				for (const item of data.Answer) {
					if (results.size >= 32) break;
					if (![1, 28].includes(item.type)) continue;
					try { results.add(验证公共出口((item.type === 28 ? '[' + item.data + ']' : item.data) + ':443')); } catch {}
				}
			} catch (error) { if (signal?.aborted) throw error; failures.push({ address: 'source-' + type, reason: String(error.message).slice(0, 180) }); }
			finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
		}
	}
	return Array.from(results).slice(0, 32);
}

async function 区域池缓存键(region, request) {
	const material = JSON.stringify([发布版本, new URL(request.url).hostname, request.cf?.colo || 'unknown', region.code, region.exits, !!region.auto, region.source || null]);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
	return 'exit-pool:v1:' + region.code + ':' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

function 验证出口池(pool, code) {
	if (!pool || pool.version !== 1 || pool.region !== code || !Array.isArray(pool.exits) || pool.exits.length > 8 ||
		!Array.isArray(pool.failures) || pool.failures.length > 8 || !Number.isFinite(pool.lastAttemptAt) ||
		!Number.isFinite(pool.expiresAt) || !Number.isFinite(pool.nextRefreshAt) || pool.lastAttemptAt > Date.now() + 10000 ||
		pool.nextRefreshAt > pool.lastAttemptAt + 出口刷新间隔 || pool.expiresAt > pool.lastAttemptAt + 出口有效期 + 12000 ||
		new Set(pool.exits.map(item => item.address)).size !== pool.exits.length)
		throw 区域错误('出口检测缓存损坏，请立即刷新修复。', 503);
	for (const item of pool.exits) {
		验证公共出口(item.address);
		验证公共出口((item.exitIP?.includes(':') ? '[' + item.exitIP + ']' : item.exitIP) + ':443');
		if (item.country !== code || item.tlsNameVerified !== true || !Number.isFinite(item.latency) || item.latency < 0 || !Number.isFinite(item.checkedAt) ||
			item.checkedAt <= 0 || item.checkedAt > Date.now() + 10000 || pool.expiresAt > item.checkedAt + 出口有效期)
			throw 区域错误('出口检测缓存包含未经有效验证的结果。', 503);
	}
	return pool;
}

async function 读取出口池状态(env, region, request, repair = false) {
	if (!env?.KV?.get || !env.KV.put) throw 区域错误('配置存储 KV 不可用。', 503);
	let state = 区域池实例状态.get(env.KV);
	if (!state) { state = new Map(); 区域池实例状态.set(env.KV, state); }
	const key = await 区域池缓存键(region, request);
	if (!state.has(key)) {
		if (state.size >= 32) { for (const [oldKey, oldEntry] of state) { if (!oldEntry.pending) { state.delete(oldKey); break; } } }
		const entry = { pool: null, pending: null };
		entry.loaded = (async () => {
			let value;
			try { value = await env.KV.get(key); }
			catch { state.delete(key); throw 区域错误('出口缓存读取失败。', 503); }
			try { entry.pool = value === null ? null : 验证出口池(JSON.parse(value), region.code); }
			catch { if (!repair) { state.delete(key); throw 区域错误('出口缓存损坏，请立即刷新修复。', 503); } }
		})(); state.set(key, entry);
	}
	const entry = state.get(key); await entry.loaded;
	return { key, entry };
}

async function 刷新区域出口池(env, region, request, key, entry) {
	const old = entry.pool, now = Date.now(), controller = new AbortController();
	let timer;
	const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
		controller.abort(); reject(new Error('出口发现或检测超过 12 秒限制。'));
	}, 12000); });
	const failures = [], checked = [];
	let candidates = [], cursor = Number.isInteger(old?.cursor) ? old.cursor : 0;
	try {
		candidates = await Promise.race([发现区域候选(region, controller.signal, failures), deadline]);
		const primary = old?.exits[0]?.address;
		const remaining = candidates.filter(address => address !== primary);
		const selected = primary ? [primary] : [];
		const count = Math.min(4 - selected.length, remaining.length);
		for (let i = 0; i < count; i++) selected.push(remaining[(cursor + i) % remaining.length]);
		cursor = remaining.length ? (cursor + selected.length - (primary ? 1 : 0)) % remaining.length : 0;
		for (let offset = 0; offset < selected.length && !controller.signal.aborted; offset += 2) {
			await Promise.race([Promise.all(selected.slice(offset, offset + 2).map(async address => {
				try {
					const result = await 探测区域出口(address, region.code, controller.signal);
					if (controller.signal.aborted) return;
					验证出口池({ version: 1, region: region.code, exits: [result], failures: [], lastAttemptAt: Date.now(), expiresAt: result.checkedAt + 出口有效期, nextRefreshAt: Date.now() }, region.code);
					checked.push(result);
				} catch (error) { if (!controller.signal.aborted) failures.push({ address, reason: String(error.message).slice(0, 180),
					invalidatesExit: error.invalidatesExit === true || /certificate|hostname mismatch/i.test(error.message) }); }
			})), deadline]);
		}
	} catch (error) { failures.push({ address: 'source', reason: String(error.message).slice(0, 180) }); }
	finally { clearTimeout(timer); controller.abort(); }
	const order = old?.exits[0]?.address;
	checked.sort((a, b) => (a.address === order ? -1 : b.address === order ? 1 : a.latency - b.latency));
	const retained = old?.exits.filter(item => !failures.some(failure => failure.address === item.address && failure.invalidatesExit)) || [];
	// Revocation must survive a KV write outage; newly accepted exits still require persistence.
	if (old && retained.length !== old.exits.length) entry.pool = { ...old, exits: retained, failures,
		expiresAt: retained.length ? old.expiresAt : now, nextRefreshAt: now };
	const pool = checked.length ? { version: 1, region: region.code, exits: checked.slice(0, 8), failures, cursor,
		lastAttemptAt: now, nextRefreshAt: now + 出口刷新间隔, expiresAt: Math.min(...checked.map(item => item.checkedAt)) + 出口有效期 }
		: old && old.expiresAt > Date.now() && retained.length ? { ...old, exits: retained, failures, cursor, lastAttemptAt: now, nextRefreshAt: now + 60000 }
			: { version: 1, region: region.code, exits: [], failures, cursor, lastAttemptAt: now, nextRefreshAt: now + 60000, expiresAt: now };
	try { await env.KV.put(key, JSON.stringify(pool), { expirationTtl: 3600 }); }
	catch { throw 区域错误('出口检测结果保存失败。', 503); }
	entry.pool = pool; return pool;
}

async function 获取有效区域池(env, region, request, force = false) {
	const { key, entry } = await 读取出口池状态(env, region, request, force);
	const now = Date.now(), old = entry.pool;
	if (force && old && now - old.lastAttemptAt < 60000) throw 区域错误('刷新操作过于频繁，请稍后再试。', 429);
	if (!entry.pending && (force || !old || now >= old.nextRefreshAt)) {
		entry.pending = 刷新区域出口池(env, region, request, key, entry);
		entry.pending.finally(() => { entry.pending = null; }).catch(() => {});
	}
	const pool = entry.pending ? await entry.pending : entry.pool;
	if (!pool || !pool.exits.length || pool.expiresAt <= Date.now()) throw 区域错误('当前区域没有未过期的有效出口，请稍后刷新。', 503);
	return pool;
}
