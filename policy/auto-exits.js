const 出口刷新间隔 = 15 * 60 * 1000, 出口有效期 = 30 * 60 * 1000;
const 区域池实例状态 = new WeakMap();

// Withdrawal outlives evictable pool views until persistence or the original proof expiry.
const 区域撤销权威 = new WeakMap();
function 读取撤销权威(kv) {
	let authority = 区域撤销权威.get(kv);
	if (!authority) { authority = { withdrawals: new Map(), blockedUntil: 0 }; 区域撤销权威.set(kv, authority); }
	for (const [id, proof] of authority.withdrawals) if (proof.expiresAt <= Date.now()) authority.withdrawals.delete(id);
	return authority;
}
function 撤销旧出口(kv, key, item) {
	const authority = 读取撤销权威(kv), expiresAt = item.checkedAt + 出口有效期;
	if (expiresAt <= Date.now()) return;
	const id = key + ':' + item.address;
	if (!authority.withdrawals.has(id) && authority.withdrawals.size >= 256) {
		authority.blockedUntil = Math.max(authority.blockedUntil, expiresAt, ...Array.from(authority.withdrawals.values(), proof => proof.expiresAt));
		return;
	}
	const old = authority.withdrawals.get(id);
	authority.withdrawals.set(id, { key, checkedAt: Math.max(item.checkedAt, old?.checkedAt || 0), expiresAt: Math.max(expiresAt, old?.expiresAt || 0) });
}
function 允许当前证明(kv, key, item) {
	const authority = 读取撤销权威(kv), withdrawal = authority.withdrawals.get(key + ':' + item.address);
	return authority.blockedUntil <= Date.now() && (!withdrawal || item.checkedAt > withdrawal.checkedAt);
}
function 区域不可用状态(pool, region) {
	if (!pool) return 'not_checked';
	if (pool.exits.some(item => 有效区域出口(item, region))) return null;
	const matching = pool.exits.filter(item => item.country === (region.country || region.code) && (!region.area || 出口所属区域(item) === region.area));
	if (matching.some(item => item.checkedAt + 出口有效期 <= Date.now())) return 'expired';
	if (pool.failures.some(item => item.address.startsWith('source'))) return 'source_failed';
	const fresh = pool.exits.filter(item => 有效区域出口(item, { code: region.country || region.code }));
	if (region.area && fresh.length && fresh.every(item => !出口所属区域(item))) return 'missing_geo';
	return region.area ? 'area_unavailable' : 'country_unavailable';
}

const 美国州分组 = {
	west: 'AK AZ CA CO HI ID MT NM NV OR UT WA WY',
	east: 'CT DE DC FL GA MA MD ME NC NH NJ NY PA RI SC VA VT WV',
	central: 'AL AR IA IL IN KS KY LA MI MN MO MS ND NE OH OK SD TN TX WI'
};
function 美国州区域(code) {
	return Object.keys(美国州分组).find(area => 美国州分组[area].split(' ').includes(code)) || null;
}
function 有效地理字段(item) {
	return (item.regionCode === null || (typeof item.regionCode === 'string' && /^[A-Z0-9-]{1,8}$/.test(item.regionCode))) &&
		(item.city === null || (typeof item.city === 'string' && item.city.length <= 128 && !/[\x00-\x1f\x7f]/.test(item.city)));
}
function 出口所属区域(item) {
	return item.receiptVersion === 2 && item.country === 'US' ? 美国州区域(item.regionCode) : null;
}
function 有效区域出口(item, region) {
	return item.country === (region.country || region.code) && item.proofVerified === true &&
		item.checkedAt + 出口有效期 > Date.now() && (!region.area || 出口所属区域(item) === region.area);
}
function 区域池视图(pool, region) {
	if (!pool) return null;
	const exits = pool.exits.filter(item => 有效区域出口(item, region)).map(item => ({ ...item }));
	return { ...pool, region: region.code, country: region.country || region.code, area: region.area || null, exits,
		failures: pool.failures.map(item => ({ ...item })), expiresAt: exits.length ? Math.max(...exits.map(item => item.checkedAt + 出口有效期)) : 0 };
}
function 区域池统计(pool, country) {
	const view = 区域池视图(pool, { code: country });
	const availableCounts = { [country]: view?.exits.length || 0 };
	if (country === 'US') for (const child of 美国子区域)
		availableCounts[child.code] = view?.exits.filter(item => 出口所属区域(item) === child.area).length || 0;
	return { country, discoveredCount: pool?.discoveredCount || 0, probedCount: pool?.probedCount || 0,
		availableCounts, lastAttemptAt: pool?.lastAttemptAt || null, nextRefreshAt: pool?.nextRefreshAt || null };
}

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

async function 探测区域出口(address, code, signal, env, request) {
	const controller = new AbortController(), abort = () => controller.abort();
	const timer = setTimeout(abort, 4000); signal?.addEventListener('abort', abort, { once: true });
	try {
		if (signal?.aborted) controller.abort();
		const start = performance.now();
		const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
		const receipt = await 读取候选回执(address, new URL(request.url).hostname, nonce, controller.signal);
		const trace = await 验证出口回执(receipt, env, request, nonce, code);
		const latency = Math.round(performance.now() - start);
		return { address, ...trace, latency, checkedAt: Date.now() };
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
		const source = 自动地区目录.find(item => item.code === region.code && item.source === region.source);
		if (!source) throw 区域错误('该区域没有受支持的自动来源。');
		for (const type of ['A', 'AAAA']) {
			if (signal?.aborted) throw new Error('出口发现已取消。');
			const url = new URL('https://cloudflare-dns.com/dns-query');
			url.searchParams.set('name', source.hostname); url.searchParams.set('type', type);
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
	const country = region.country || region.code;
	const material = JSON.stringify([发布版本, new URL(request.url).hostname, request.cf?.colo || 'unknown', country, region.exits, !!region.auto, region.source || null]);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
	return 'exit-pool:v3:' + country + ':' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

function 验证出口池(pool, code) {
	if (!pool || pool.version !== 1 || pool.region !== code || !Array.isArray(pool.exits) || pool.exits.length > 8 ||
		!Array.isArray(pool.failures) || pool.failures.length > 8 || !Number.isFinite(pool.lastAttemptAt) ||
		!Number.isFinite(pool.expiresAt) || !Number.isFinite(pool.nextRefreshAt) || pool.lastAttemptAt <= 0 || pool.expiresAt < 0 ||
		pool.nextRefreshAt < pool.lastAttemptAt || pool.lastAttemptAt > Date.now() + 10000 ||
		pool.nextRefreshAt > pool.lastAttemptAt + 出口刷新间隔 || pool.expiresAt > pool.lastAttemptAt + 出口有效期 + 12000 ||
		new Set(pool.exits.map(item => item?.address)).size !== pool.exits.length ||
		(pool.cursor !== undefined && (!Number.isInteger(pool.cursor) || pool.cursor < 0 || pool.cursor > 31)) ||
		(pool.discoveredCount !== undefined && (!Number.isInteger(pool.discoveredCount) || pool.discoveredCount < 0 || pool.discoveredCount > 32)) ||
		(pool.probedCount !== undefined && (!Number.isInteger(pool.probedCount) || pool.probedCount < 0 || pool.probedCount > 4)))
		throw 区域错误('出口检测缓存损坏，请立即刷新修复。', 503);
	for (const failure of pool.failures)
		if (!failure || typeof failure.address !== 'string' || failure.address.length > 80 || typeof failure.reason !== 'string' || failure.reason.length > 180 ||
			(failure.invalidatesExit !== undefined && typeof failure.invalidatesExit !== 'boolean')) throw 区域错误('出口检测缓存错误详情无效。', 503);
	for (const item of pool.exits) {
		验证公共出口(item.address);
		验证公共出口((item.exitIP?.includes(':') ? '[' + item.exitIP + ']' : item.exitIP) + ':443');
		if (item.country !== code || item.proofVerified !== true || !Number.isFinite(item.latency) || item.latency < 0 || !Number.isFinite(item.checkedAt) ||
			item.checkedAt <= 0 || item.checkedAt > Date.now() + 10000 ||
			(item.receiptVersion === 2 ? !有效地理字段(item) || item.area !== (code === 'US' ? 美国州区域(item.regionCode) : null) :
				item.receiptVersion !== undefined || item.regionCode != null || item.city != null || item.area != null))
			throw 区域错误('出口检测缓存包含未经有效验证的结果。', 503);
	}
	return pool;
}

async function 读取出口池状态(env, region, request, repair = false) {
	if (!env?.KV?.get || !env.KV.put) throw 区域错误('配置存储 KV 不可用。', 503);
	let state = 区域池实例状态.get(env.KV);
	if (!state) { state = new Map(); 区域池实例状态.set(env.KV, state); }
	const key = await 区域池缓存键(region, request);
	if (读取撤销权威(env.KV).blockedUntil > Date.now()) throw 区域错误('出口撤销记录达到保护上限，请等待旧证明过期。', 503);
	if (!state.has(key)) {
		if (state.size >= 32) { for (const [oldKey, oldEntry] of state) { if (!oldEntry.pending) { state.delete(oldKey); break; } } }
		const entry = { pool: null, pending: null };
		entry.loaded = (async () => {
			let value;
			try { value = await env.KV.get(key); }
			catch { state.delete(key); throw 区域错误('出口缓存读取失败。', 503); }
			try { entry.pool = value === null ? null : 验证出口池(JSON.parse(value), region.country || region.code); }
			catch { if (!repair) { state.delete(key); throw 区域错误('出口缓存损坏，请立即刷新修复。', 503); } }
		})(); state.set(key, entry);
	}
	const entry = state.get(key); await entry.loaded;
	if (entry.pool) entry.pool = { ...entry.pool, exits: entry.pool.exits.filter(item => 允许当前证明(env.KV, key, item)) };
	return { key, entry };
}

async function 刷新区域出口池(env, region, request, key, entry) {
	region = { ...region, code: region.country || region.code, area: null };
	const old = entry.pool, now = Date.now(), controller = new AbortController();
	let timer;
	const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
		controller.abort(); reject(new Error('出口发现或检测超过 12 秒限制。'));
	}, 12000); });
	const failures = [], checked = [];
	let candidates = [], probedCount = 0, cursor = Number.isInteger(old?.cursor) ? old.cursor : 0;
	try {
		await Promise.race([确保出口回执密钥(env), deadline]);
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
					probedCount++;
					const result = await 探测区域出口(address, region.code, controller.signal, env, request);
					验证出口池({ version: 1, region: region.code, exits: [result], failures: [], lastAttemptAt: Date.now(), expiresAt: result.checkedAt + 出口有效期, nextRefreshAt: Date.now() }, region.code);
					const previous = old?.exits.find(item => item.address === address);
					if (previous && (previous.regionCode !== result.regionCode || previous.receiptVersion !== result.receiptVersion))
						撤销旧出口(env.KV, key, previous);
					if (controller.signal.aborted) return;
					checked.push(result);
				} catch (error) {
					const invalidatesExit = error.invalidatesExit === true || /certificate|hostname mismatch/i.test(error.message);
					const previous = old?.exits.find(item => item.address === address);
					if (invalidatesExit && previous) 撤销旧出口(env.KV, key, previous);
					if (!controller.signal.aborted) failures.push({ address, reason: String(error.message).slice(0, 180), invalidatesExit });
				}
			})), deadline]);
		}
	} catch (error) { failures.push({ address: 'source', reason: String(error.message).slice(0, 180) }); }
	finally { clearTimeout(timer); controller.abort(); }
	const order = old?.exits[0]?.address;
	checked.sort((a, b) => (a.address === order ? -1 : b.address === order ? 1 : a.latency - b.latency));
	const retained = old?.exits.filter(item => 有效区域出口(item, region) && 允许当前证明(env.KV, key, item) &&
		!failures.some(failure => failure.address === item.address && failure.invalidatesExit) &&
		!checked.some(result => result.address === item.address && (result.regionCode !== item.regionCode || result.receiptVersion !== item.receiptVersion))) || [];
	for (const item of old?.exits || []) if (!retained.includes(item)) 撤销旧出口(env.KV, key, item);
	// Remove revoked evidence in memory before persistence; accepted replacements require a successful KV write.
	if (old) entry.pool = { ...old, exits: retained, failures: failures.slice(0, 8), cursor,
		discoveredCount: candidates.length, probedCount, lastAttemptAt: now, nextRefreshAt: now + 60000,
		expiresAt: retained.length ? Math.max(...retained.map(item => item.checkedAt + 出口有效期)) : now };
	else entry.pool = { version: 1, region: region.code, exits: [], failures: failures.slice(0, 8), cursor, lastAttemptAt: now,
		nextRefreshAt: now + 60000, expiresAt: now, discoveredCount: candidates.length, probedCount };
	const merged = [...checked, ...retained.filter(item => !checked.some(result => result.address === item.address))];
	merged.sort((a, b) => (a.address === order ? -1 : b.address === order ? 1 : a.latency - b.latency));
	const exits = [];
	if (merged[0]) exits.push(merged[0]);
	// Preserve one candidate per observed area before filling the bounded pool.
	if (region.code === 'US') for (const child of 美国子区域) {
		const item = merged.find(item => 出口所属区域(item) === child.area);
		if (item && !exits.includes(item)) exits.push(item);
	}
	for (const item of merged) if (exits.length < 8 && !exits.includes(item)) exits.push(item);
	const pool = { version: 1, region: region.code, exits, failures: failures.slice(0, 8), cursor,
		discoveredCount: candidates.length, probedCount, lastAttemptAt: now,
		nextRefreshAt: now + (checked.length ? 出口刷新间隔 : 60000),
		expiresAt: exits.length ? Math.max(...exits.map(item => item.checkedAt + 出口有效期)) : now };

	try { await env.KV.put(key, JSON.stringify(pool), { expirationTtl: 3600 }); }
	catch { throw 区域错误('出口检测结果保存失败。', 503); }
	const authority = 读取撤销权威(env.KV);
	for (const [id, proof] of authority.withdrawals)
		if (proof.key === key && !pool.exits.some(item => id === key + ':' + item.address && item.checkedAt <= proof.checkedAt)) authority.withdrawals.delete(id);
	entry.pool = pool; return pool;
}

async function 获取有效区域池(env, region, request, force = false) {
	const { key, entry } = await 读取出口池状态(env, region, request, force);
	const now = Date.now(), old = entry.pool, selected = 区域池视图(old, region);
	if (force && old && now - old.lastAttemptAt < 60000) throw 区域错误('刷新操作过于频繁，请稍后再试。', 429);
	const missingArea = region.area && !selected?.exits.length && old && now - old.lastAttemptAt >= 60000;
	if (!entry.pending && (force || !old || now >= old.nextRefreshAt || missingArea)) {
		entry.pending = 刷新区域出口池(env, region, request, key, entry);
		entry.pending.finally(() => { entry.pending = null; }).catch(() => {});
	}
	const currentPool = entry.pending ? await entry.pending : entry.pool;
	if (读取撤销权威(env.KV).blockedUntil > Date.now()) throw 区域错误('出口撤销记录达到保护上限，请等待旧证明过期。', 503);
	const pool = 区域池视图(currentPool && { ...currentPool, exits: currentPool.exits.filter(item => 允许当前证明(env.KV, key, item)) }, region);
	if (!pool?.exits.length) throw 区域错误('当前区域没有未过期的有效出口，请稍后刷新。', 503);
	pool.验证当前出口 = item => {
		const current = 区域池实例状态.get(env.KV)?.get(key)?.pool?.exits.find(exit => exit.address === item.address);
		return !!current && 允许当前证明(env.KV, key, item) && 有效区域出口(current, region) && 有效区域出口(item, region);
	};
	return pool;
}
