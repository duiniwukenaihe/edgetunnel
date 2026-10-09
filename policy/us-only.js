function 生成美国通用订阅(config, protocol) {
	const host = config.HOST, uuid = config.UUID;
	if (protocol === 'ss') {
		const cipher = config.SS?.加密方式 || 'aes-128-gcm';
		const plugin = `v2ray-plugin;mode=websocket;host=${host};path=/?enc=${cipher};tls;mux=0`;
		return `ss://${btoa(cipher + ':' + uuid)}@${host}:443?plugin=${encodeURIComponent(plugin)}#US-SS`;
	}
	const params = new URLSearchParams({ security: 'tls', type: 'ws', host, sni: host,
		path: '/', encryption: 'none', fp: 'chrome' });
	return `vless://${uuid}@${host}:443?${params}#US-VLESS`;
}

function 生成美国Clash订阅(config) {
	const host = config.HOST, uuid = config.UUID;
	const cipher = config.SS?.加密方式 || 'aes-128-gcm';
	const vlessName = '美国-VLESS', ssName = '美国-SS';
	return JSON.stringify({
		'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
		proxies: [
			{ name: vlessName, type: 'vless', server: host, port: 443, uuid, tls: true,
				udp: false, servername: host, network: 'ws', 'client-fingerprint': 'chrome',
				'ws-opts': { path: '/', headers: { Host: host } } },
			{ name: ssName, type: 'ss', server: host, port: 443, cipher, password: uuid,
				udp: false, plugin: 'v2ray-plugin', 'plugin-opts': {
					mode: 'websocket', tls: true, host, path: '/?enc=' + cipher, mux: false } }
		],
		'proxy-groups': [{ name: '美国故障切换', type: 'fallback', proxies: [vlessName, ssName],
			url: 'https://www.gstatic.com/generate_204', interval: 300, lazy: false }],
		rules: ['MATCH,美国故障切换']
	}, null, 2);
}

async function 反代参数获取(url, uuid, 默认反代IP = '', 默认反代兜底 = true) {
	// 禁止 URL、KV 或默认直连绕过经过验证的美国出口。
	return { 木马反代地址: null, 反代IP: 美国出口, 代理类型: 'proxyip',
		代理账号: '', 代理全局: true, 代理参数: {}, 反代兜底: false };
}
