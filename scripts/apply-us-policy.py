"""Generate the custom worker; source drift stops before writing the output."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def apply_policy(source):
    result = source.lstrip('\ufeff')

    def replace_once(old, new):
        nonlocal result
        if result.count(old) != 1:
            raise ValueError('Upstream anchor changed; review required: ' + old[:70])
        result = result.replace(old, new, 1)

    replace_once('let config_JSON,', "import { connect } from 'cloudflare:sockets';\n"
                 "const 美国出口 = '3.132.174.45:443,192.3.208.192:443';\n"
                 "const 发布版本 = '__NAIOPS_RELEASE_SHA__';\nlet config_JSON,")
    admin = '\t\tconst 管理员密码 = env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || env.UUID || env.uuid;'
    replace_once(admin, "\t\tconst 管理员密码 = env.ADMIN;\n"
                 "\t\tif (!管理员密码) return new Response('请先在 Cloudflare 设置 ADMIN。', { status: 503, headers: { 'Cache-Control': 'no-store' } });\n"
                 "\t\tif (url.pathname === '/__naiops_exit_probe') return await 处理出口回执(request, env);\n"
                 "\t\tif (url.pathname === '/healthz') return Response.json({ status: env.KV ? 'ready' : 'missing-kv', revision: 发布版本 }, { status: env.KV ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });")
    replace_once('反代并发拨号数 = Math.max(1, Number(env.PROXY_CONCURRENT_DIAL) || 反代并发拨号数);', '反代并发拨号数 = 1;')
    config_reader = 'async function 读取config_JSON(env, hostname, userID, UA = "Mozilla/5.0", 重置配置 = false) {'
    replace_once(config_reader, config_reader + '\n\tlet config_JSON;')
    path_anchor = 'const 访问路径 = url.pathname.slice(1).toLowerCase();'
    replace_once(path_anchor, path_anchor + "\n\t\tif (['admin', 'admin/regions', 'admin/regions.json', 'admin/exits.json'].includes(访问路径) &&\n"
                 "\t\t\t(!env.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function'))\n"
                 "\t\t\treturn 区域错误响应(区域错误('配置存储 KV 不可用。', 503));")
    proxy_call = 'const 反代上下文 = await 反代参数获取(url, userID, 默认反代IP, 默认反代兜底);'
    if result.count(proxy_call) != 2:
        raise ValueError('Upstream proxy entry points changed; review required')
    result = result.replace(proxy_call, 'let 反代上下文;\n\t\t\ttry { 反代上下文 = await 反代参数获取(url, userID, 默认反代IP, 默认反代兜底, env, request); }\n'
                            '\t\t\tcatch (error) { return 区域错误响应(error); }')
    auth_anchor = "if (访问路径 === 'admin/log.json') {// 读取日志内容"
    replace_once(auth_anchor, "if (访问路径 === 'admin') return new Response(null, { status: 302, headers: { Location: '/admin/regions' } });\n"
                 "\t\t\t\t\tif (['admin/regions', 'admin/regions.json', 'admin/exits.json'].includes(访问路径)) return await 处理区域管理(request, env, url, host, userID);\n"
                 '\t\t\t\t\t' + auth_anchor)
    sub_anchor = "if (用户客户端请求订阅 || 订阅转换后端请求订阅 || 作为优选订阅生成器) {\n\t\t\t\t\t\tconfig_JSON = await 读取config_JSON(env, host, userID, UA);"
    replace_once(sub_anchor, sub_anchor.replace(' || 作为优选订阅生成器', '').replace('config_JSON =', 'const config_JSON =') + "\n\t\t\t\t\t\tlet 区域配置, 订阅地区;\n"
                 "\t\t\t\t\t\ttry { 区域配置 = await 读取区域配置(env); 订阅地区 = url.searchParams.has('region') ? 选择区域(区域配置, url) : null; }\n"
                 "\t\t\t\t\t\tcatch (error) { return 区域错误响应(error); }\n"
                 "\t\t\t\t\t\tctx.waitUntil(获取有效区域池(env, 订阅地区 || 选择区域(区域配置, url), request).catch(() => {}));")
    tcp_anchor = "\tconst ctx反代IP = 反代上下文.反代IP || '';"
    replace_once(tcp_anchor, "\tlet ctx反代IP = 反代上下文.反代IP || '', 当前验证池 = null;")
    dial_anchor = "\t\t\t\t\tconst 所有反代数组 = await 解析地址端口(ctx反代IP, host, yourUUID);"
    replace_once(dial_anchor, "\t\t\t\t\t// Authenticated first dial and every retry require a fresh, unexpired pool.\n"
                 "\t\t\t\t\tif (反代上下文.获取验证出口) { 当前验证池 = await 反代上下文.获取验证出口(); ctx反代IP = 当前验证池.exits.map(item => item.address).join(','); }\n" + dial_anchor)
    batch_anchor = '\t\t\tfor (let i = 0; i < 所有反代数组.length; i += 实际并发数) {'
    replace_once(batch_anchor, batch_anchor + "\n\t\t\t\tif (当前验证池 && 当前验证池.expiresAt <= Date.now()) throw 区域错误('出口验证已过期，请重新建立连接。', 503);")
    start = result.index('function 创建请求TCP连接器(request) {')
    end = result.index('\n////////////////////////////////////////////TLSClient', start)
    replace_once(result[start:end], 'function 创建请求TCP连接器(request) {\n\treturn connect;\n}')
    start = result.index('async function forwardataudp(')
    end = result.index('\nfunction closeSocketQuietly(', start)
    replace_once(result[start:end], "async function forwardataudp(udpChunk, webSocket, respHeader, request, 响应封装器 = null) {\n"
                 "\tcloseSocketQuietly(webSocket);\n\tthrow new Error('本分支仅支持 TCP，UDP/DNS 转发已禁用。');\n}")
    start = result.index('async function 反代参数获取(')
    end = result.index('const 反代协议默认端口', start)
    policy = '\n'.join((ROOT / file).read_text() for file in ['policy/regions.js', 'policy/exit-proof.js', 'policy/auto-exits.js'])
    panel = json.dumps((ROOT / 'policy/regions.html').read_text(), ensure_ascii=False)
    replace_once(result[start:end], 'const 区域管理页面 = ' + panel + ';\n' + policy)
    start = result.index('\tconst 排序后数组 = 所有反代数组.sort(')
    end = result.index('\n\tlog(`[反代解析] 解析完成', start)
    replace_once(result[start:end], '\tconst 解析结果 = 所有反代数组.slice(0, 8);')
    start = result.index('\t\t\t\t\t\tconst 协议类型 = ((url.searchParams.has(')
    end = result.index("\n\t\t\t\t\t\tlet 订阅内容 = '';", start)
    replace_once(result[start:end], """\t\t\t\t\t\tif (!['clash', 'mixed'].includes(订阅类型)) return new Response('请使用 target=clash 或 target=mixed。', { status: 400 });
						if (订阅类型 === 'clash') {
							responseHeaders['content-type'] = 'application/yaml; charset=utf-8';
							return new Response(生成区域Clash订阅(config_JSON, 区域配置, 订阅地区), { status: 200, headers: responseHeaders });
						}
						const 协议类型 = url.searchParams.get('protocol') || config_JSON.协议类型;
						if (!['vless', 'ss'].includes(协议类型)) return new Response('请使用 protocol=vless 或 protocol=ss。', { status: 400 });
						const link = 生成区域通用订阅(config_JSON, 协议类型, 区域配置, 订阅地区);
						const body = (!ua.includes('mozilla') || url.searchParams.has('b64') || url.searchParams.has('base64')) ? btoa(link) : link;
						return new Response(body, { status: 200, headers: responseHeaders });""")
    return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: apply-us-policy.py INPUT OUTPUT')
    try:
        generated = apply_policy(Path(sys.argv[1]).read_text())
    except ValueError as error:
        raise SystemExit(str(error))
    Path(sys.argv[2]).write_text(generated)
