// This receipt authenticates observed egress, independently of the probe's TLS transport.
// Only a random nonce is sent through candidates. The independent random key stays in KV.
const 出口回执密钥名称 = '__naiops_exit_receipt_key_v1';
function 出口回执内容(receipt) {
	return JSON.stringify([1, receipt.nonce, receipt.hostname, receipt.revision, receipt.issuedAt, receipt.ip, receipt.country]);
}

async function 出口回执密钥(env) {
	let value;
	try { value = await env.KV.get(出口回执密钥名称); } catch { throw 区域错误('检测密钥读取失败。', 503); }
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw 区域错误('检测密钥尚未初始化或格式无效。', 503);
	const material = Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
	return crypto.subtle.importKey('raw', material,
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function 确保出口回执密钥(env) {
	// Provision once during authorized deployment; KV has no atomic create-if-absent.
	return 出口回执密钥(env);
}

async function 处理出口回执(request, env) {
	try {
		if (request.method !== 'GET') throw 区域错误('仅支持 GET。', 405);
		const url = new URL(request.url), values = url.searchParams.getAll('nonce');
		if (values.length !== 1 || !/^[0-9a-f]{32}$/.test(values[0])) throw 区域错误('检测 nonce 无效。');
		const ip = request.headers.get('CF-Connecting-IP'), country = request.cf?.country;
		if (request.headers.has('CF-Worker')) throw 区域错误('Worker 子请求不能作为出口证据。', 503);
		if (!ip || !/^[A-Z]{2}$/.test(country || '') || country === 'XX') throw 区域错误('边缘出口信息不可用。', 503);
		try {
			const canonical = 验证公共出口((ip.includes(':') ? '[' + ip + ']' : ip) + ':443');
			if (canonical === '[2a06:98c0:3600::103]:443') throw new Error('synthetic Worker address');
		}
		catch { throw 区域错误('边缘出口地址无效。', 503); }
		const receipt = { version: 1, nonce: values[0], hostname: url.hostname, revision: 发布版本,
			issuedAt: Date.now(), ip, country };
		const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await 出口回执密钥(env), new TextEncoder().encode(出口回执内容(receipt))));
		receipt.signature = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
		return Response.json(receipt, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error) { return 区域错误响应(error); }
}

async function 验证出口回执(receipt, env, request, nonce, code) {
	if (!receipt || receipt.version !== 1 || receipt.nonce !== nonce || receipt.hostname !== new URL(request.url).hostname ||
		receipt.revision !== 发布版本 || !Number.isFinite(receipt.issuedAt) || receipt.issuedAt < Date.now() - 10000 ||
		receipt.issuedAt > Date.now() + 2000 || typeof receipt.signature !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.signature))
		throw 区域错误('出口签名回执无效或过期。', 503);
	const signature = Uint8Array.from(receipt.signature.match(/../g), byte => parseInt(byte, 16));
	if (!await crypto.subtle.verify('HMAC', await 出口回执密钥(env), signature, new TextEncoder().encode(出口回执内容(receipt))))
		throw Object.assign(区域错误('出口回执签名不匹配。', 503), { invalidatesExit: true });
	if (receipt.country !== code) throw Object.assign(区域错误('实际出口国家不符合所选区域。', 503), { invalidatesExit: true });
	验证公共出口((receipt.ip?.includes(':') ? '[' + receipt.ip + ']' : receipt.ip) + ':443');
	return { exitIP: receipt.ip, country: receipt.country, proofVerified: true };
}

function 解析候选回执响应(text) {
	const split = text.indexOf('\r\n\r\n');
	if (split < 0 || split > 4096 || text.length > 8192 || !/^HTTP\/1\.[01] 200(?: |\r\n)/.test(text))
		throw 区域错误('出口回执未返回有效 HTTP 200。', 503);
	const headers = text.slice(0, split), lengths = [...headers.matchAll(/\r\nContent-Length:\s*(\d+)\s*(?=\r\n|$)/gi)];
	const encodings = [...headers.matchAll(/\r\nTransfer-Encoding:\s*([^\r\n]+)/gi)];
	if (!/\r\nContent-Type:\s*application\/json(?:\s*;[^\r\n]*)?(?=\r\n|$)/i.test(headers) ||
		lengths.length > 1 || encodings.length > 1 || (encodings.length && (lengths.length || encodings[0][1].trim().toLowerCase() !== 'chunked')))
		throw 区域错误('出口回执响应格式无效。', 503);
	let body = text.slice(split + 4);
	if (encodings.length) {
		let offset = 0, plain = '', ended = false;
		while (offset < body.length) {
			const end = body.indexOf('\r\n', offset), sizeText = body.slice(offset, end);
			if (end < 0 || !/^[0-9a-f]{1,6}$/i.test(sizeText)) throw 区域错误('出口回执分块无效。', 503);
			const size = parseInt(sizeText, 16); offset = end + 2;
			if (body.slice(offset + size, offset + size + 2) !== '\r\n') throw 区域错误('出口回执分块不完整。', 503);
			if (size === 0) { ended = offset + 2 === body.length; break; }
			plain += body.slice(offset, offset + size); offset += size + 2;
		}
		if (!ended) throw 区域错误('出口回执缺少结束块。', 503);
		body = plain;
	} else if (lengths.length && Number(lengths[0][1]) !== new TextEncoder().encode(body).byteLength)
		throw 区域错误('出口回执长度不符。', 503);
	try { return JSON.parse(body); } catch { throw 区域错误('出口回执不是有效 JSON。', 503); }
}

async function 读取候选回执(address, hostname, nonce, signal) {
	let raw, socket, timer, finished = false, rejectAbort;
	const close = () => { try { raw?.close()?.catch(() => {}); } catch {} };
	const abort = () => { finished = true; close(); rejectAbort?.(new Error('检测已取消。')); };
	try {
		验证公共出口(address);
		if (signal?.aborted) throw new Error('检测已取消。');
		signal?.addEventListener('abort', abort, { once: true });
		return await Promise.race([
			(async () => {
				raw = connect({ hostname: address.slice(0, -4).replace(/^\[|\]$/g, ''), port: 443 });
				raw.closed?.catch(() => {}); await raw.opened;
				if (finished || signal?.aborted) throw new Error('检测已取消。');
				socket = new TlsClient(raw, { serverName: hostname, tls12: false, allowChacha: false, timeout: 0 });
				await socket.handshake();
				if (finished || signal?.aborted) throw new Error('检测已取消。');
				await socket.write(new TextEncoder().encode(`GET /__naiops_exit_probe?nonce=${nonce} HTTP/1.0\r\nHost: ${hostname}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
				let size = 0, text = ''; const decoder = new TextDecoder();
				for (;;) {
					const value = await socket.read(); if (!value) break;
					size += value.byteLength; if (size > 8192) throw new Error('出口回执响应超过限制。');
					text += decoder.decode(value, { stream: true });
				}
				return 解析候选回执响应(text + decoder.decode());
			})(),
			new Promise((_, reject) => { rejectAbort = reject; timer = setTimeout(() => { finished = true; close(); reject(new Error('出口回执检测超时。')); }, 4000); })
		]);
	} finally { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); close(); }
}
