"""Generate the custom worker; source drift stops before writing the output."""
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
                 "\t\tif (url.pathname === '/healthz') return Response.json({ status: env.KV ? 'ready' : 'missing-kv', revision: 发布版本 }, { status: env.KV ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });")
    replace_once('反代并发拨号数 = Math.max(1, Number(env.PROXY_CONCURRENT_DIAL) || 反代并发拨号数);', '反代并发拨号数 = 1;')
    start = result.index('function 创建请求TCP连接器(request) {')
    end = result.index('\n////////////////////////////////////////////TLSClient', start)
    replace_once(result[start:end], 'function 创建请求TCP连接器(request) {\n\treturn connect;\n}')
    start = result.index('async function 反代参数获取(')
    end = result.index('const 反代协议默认端口', start)
    replace_once(result[start:end], (ROOT / 'policy/us-only.js').read_text())
    start = result.index('\tconst 排序后数组 = 所有反代数组.sort(')
    end = result.index('\n\tlog(`[反代解析] 解析完成', start)
    replace_once(result[start:end], '\tconst 解析结果 = 所有反代数组.slice(0, 8);')
    start = result.index('\t\t\t\t\t\tconst 协议类型 = ((url.searchParams.has(')
    end = result.index("\n\t\t\t\t\t\tlet 订阅内容 = '';", start)
    replace_once(result[start:end], """\t\t\t\t\t\tif (!['clash', 'mixed'].includes(订阅类型)) return new Response('请使用 target=clash 或 target=mixed。', { status: 400 });
						if (订阅类型 === 'clash') {
							responseHeaders['content-type'] = 'application/yaml; charset=utf-8';
							return new Response(生成美国Clash订阅(config_JSON), { status: 200, headers: responseHeaders });
						}
						const 协议类型 = url.searchParams.get('protocol') || config_JSON.协议类型;
						if (!['vless', 'ss'].includes(协议类型)) return new Response('请使用 protocol=vless 或 protocol=ss。', { status: 400 });
						const link = 生成美国通用订阅(config_JSON, 协议类型);
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
